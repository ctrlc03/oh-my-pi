/**
 * Per-session agent profile state: which profile is active, how switching applies one, and what
 * undoes it.
 *
 * Applying a profile touches, in this order: runtime overrides of the session's approval and
 * path-rule settings (undone on the next switch), a persistent tool filter, the system-prompt
 * section, then model and thinking level. A switch requested mid-turn is queued and applied when
 * the turn ends. The active profile persists in the session as a `profile` custom entry, so a
 * resumed or branched session comes back in the profile it left in.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import type { Setting } from "../config/registry";
import type { Settings } from "../config/settings";
import type { SessionEntry } from "../session/session-entries";
import { cfgToolsApproval, cfgToolsApprovalMode, cfgToolsOutsideProject, cfgToolsPathRules } from "../tools/settings";
import { parsePathRules } from "../tools/path-rules";
import { findProfile, loadProfileCatalog, type ProfileCatalog } from "./catalog";
import {
	DEFAULT_PROFILE_NAME,
	PROFILE_PROTECTED_TOOLS,
	type ProfileApprovalMode,
	type ProfileDefinition,
} from "./definition";
import { mergeApproval, mergePathRules, stricterApprovalMode, stricterOutsideProject } from "./merge";
import { cfgProfileDefault, cfgProfiles } from "./settings";
import { describeLoosening } from "./strictness";

/** `customType` of the session entry that records the active profile. */
export const PROFILE_ENTRY_TYPE = "profile";

/** Name recorded by the latest `profile` entry in `entries` (a branch, root first), if any. */
export function readPersistedProfileName(entries: readonly SessionEntry[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "custom" && entry.customType === PROFILE_ENTRY_TYPE && isRecord(entry.data)) {
			return typeof entry.data.name === "string" ? entry.data.name : undefined;
		}
	}
	return undefined;
}

export type ToolFilter = (names: string[]) => string[];

export interface ResolvedProfileModel {
	model: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
}

/** What a profile switch needs from its session. */
export interface SessionProfilesHost {
	settings: Settings;
	cwd(): string;
	/** Installs (or with `undefined` removes) the persistent filter on the active tool set. Resolves true when the tool set was re-applied. */
	setToolFilter(filter: ToolFilter | undefined): Promise<boolean>;
	/** Rebuilds the base system prompt so a changed profile prompt section reaches the model. */
	refreshPrompt(): Promise<void>;
	resolveModel(selector: string): ResolvedProfileModel | undefined;
	currentModel(): Model | undefined;
	currentThinkingLevel(): ConfiguredThinkingLevel | undefined;
	setModel(model: Model, thinkingLevel: ConfiguredThinkingLevel | undefined): Promise<void>;
	setThinkingLevel(level: ConfiguredThinkingLevel | undefined): void;
	/** A turn (or compaction) is running: a switch waits for it to end. */
	isBusy(): boolean;
	/** Why switching is not allowed right now (plan, goal or vibe mode own the tool set), or undefined. */
	switchBlocker(): string | undefined;
	/** Name recorded by the latest `profile` entry on the active branch. */
	persistedName(): string | undefined;
	persist(name: string): void;
	notify(level: "info" | "warning" | "error", message: string): void;
}

export type ProfileSwitchResult =
	| { ok: true; status: "applied" | "queued" | "unchanged"; profile: ProfileDefinition }
	| { ok: false; reason: string };

/** Whether two definitions would apply identically (definitions are re-read on every lookup). */
function sameDefinition(a: ProfileDefinition, b: ProfileDefinition): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

export type ProfileChangeListener = (profile: ProfileDefinition) => void;

function toolFilterOf(profile: ProfileDefinition): ToolFilter | undefined {
	if (!profile.tools && !profile.disabledTools) return undefined;
	const allowed = profile.tools ? new Set(profile.tools) : undefined;
	const denied = new Set(profile.disabledTools);
	return names =>
		names.filter(
			name => PROFILE_PROTECTED_TOOLS.includes(name) || ((!allowed || allowed.has(name)) && !denied.has(name)),
		);
}

export class SessionProfiles {
	readonly #host: SessionProfilesHost;
	readonly #listeners = new Set<ProfileChangeListener>();
	#active: ProfileDefinition;
	#pending: string | undefined;
	#promptSection: string | undefined;
	#filtered = false;
	/** Approval mode the session had before the active profile's override, while one is installed. */
	#approvalBaseMode: { mode: ProfileApprovalMode; runtime: boolean } | undefined;
	/** Reverts the runtime overrides the active profile installed. */
	#undo: Array<() => void> = [];
	/** Model and thinking level the session had before a profile first changed them. */
	#baseline: { model?: Model; thinkingLevel?: ConfiguredThinkingLevel } | undefined;
	/** What the active profile set, to tell on leaving whether the user has since moved off it. */
	#applied: { model?: Model; thinkingLevel?: ConfiguredThinkingLevel } = {};
	#chain: Promise<unknown> = Promise.resolve();

	constructor(host: SessionProfilesHost) {
		this.#host = host;
		this.#active = loadProfileCatalog(host.settings, host.cwd()).profiles[0] ?? {
			name: DEFAULT_PROFILE_NAME,
			source: "builtin",
		};
	}

	get active(): ProfileDefinition {
		return this.#active;
	}

	/** Profile a queued switch will apply when the current turn ends. */
	get pendingName(): string | undefined {
		return this.#pending;
	}

	/** Extra system-prompt section of the active profile, or undefined. */
	get promptSection(): string | undefined {
		return this.#promptSection;
	}

	catalog(): ProfileCatalog {
		return loadProfileCatalog(this.#host.settings, this.#host.cwd());
	}

	onChange(listener: ProfileChangeListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Next profile after the active one, in catalog order. */
	nextName(): string {
		const { profiles } = this.catalog();
		const index = profiles.findIndex(profile => profile.name.toLowerCase() === this.#active.name.toLowerCase());
		return profiles[(index + 1) % profiles.length]?.name ?? DEFAULT_PROFILE_NAME;
	}

	/**
	 * Switches to `name`. Mid-turn the switch is queued and applied by {@link applyPending} when the
	 * turn ends; otherwise it applies now. A user switch is persisted to the session.
	 */
	switch(name: string): Promise<ProfileSwitchResult> {
		const profile = findProfile(this.catalog(), name);
		if (!profile) return Promise.resolve({ ok: false, reason: `unknown profile ${JSON.stringify(name)}` });
		const blocker = this.#host.switchBlocker();
		if (blocker) return Promise.resolve({ ok: false, reason: blocker });
		if (sameDefinition(profile, this.#active)) {
			this.#pending = undefined;
			return Promise.resolve({ ok: true, status: "unchanged", profile });
		}
		if (this.#host.isBusy()) {
			this.#pending = profile.name;
			return Promise.resolve({ ok: true, status: "queued", profile });
		}
		this.#pending = undefined;
		return this.#applyAndPersist(profile);
	}

	/** Applies a switch queued during a turn. Called when the turn ends. */
	async applyPending(): Promise<void> {
		const name = this.#pending;
		if (!name) return;
		this.#pending = undefined;
		const profile = findProfile(this.catalog(), name);
		const blocker = this.#host.switchBlocker();
		if (!profile || blocker) {
			this.#host.notify("warning", `Profile switch to ${name} dropped: ${blocker ?? "no longer defined"}`);
			return;
		}
		try {
			await this.#applyAndPersist(profile);
			this.#host.notify("info", `Profile: ${profile.name}`);
		} catch (err) {
			this.#host.notify("error", `Profile ${profile.name}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	#applyAndPersist(profile: ProfileDefinition): Promise<ProfileSwitchResult> {
		return this.#enqueue(async () => {
			await this.#apply(profile, { restore: false });
			this.#host.persist(profile.name);
			return { ok: true, status: "applied", profile } as const;
		});
	}

	/**
	 * Aligns the active profile with the session's branch (startup, resume, new session, branch
	 * navigation): the branch's recorded profile, else `profile.default`, else `build`. Tools,
	 * approval and prompt follow; model and thinking already follow the session's own entries.
	 */
	syncFromBranch(): void {
		this.#pending = undefined;
		const catalog = this.catalog();
		const wanted = this.#host.persistedName() ?? cfgProfileDefault.get(this.#host.settings) ?? DEFAULT_PROFILE_NAME;
		let profile = findProfile(catalog, wanted);
		if (!profile) {
			this.#host.notify(
				"warning",
				`Profile ${JSON.stringify(wanted)} is not defined; using ${DEFAULT_PROFILE_NAME}`,
			);
			profile = findProfile(catalog, DEFAULT_PROFILE_NAME);
		}
		if (!profile || sameDefinition(profile, this.#active)) return;
		const target = profile;
		const fromProjectDefault =
			this.#host.persistedName() === undefined && cfgProfileDefault.provenance(this.#host.settings) === "project";
		void this.#enqueue(() => this.#apply(target, { restore: true, constrain: fromProjectDefault })).catch(err => {
			logger.warn("Failed to restore agent profile", { profile: target.name, error: String(err) });
		});
	}

	/** Resolves once every queued profile application has settled. */
	idle(): Promise<void> {
		return this.#chain.then(
			() => undefined,
			() => undefined,
		);
	}

	#enqueue<T>(task: () => Promise<T>): Promise<T> {
		const run = this.#chain.then(task, task);
		this.#chain = run.catch(() => undefined);
		return run;
	}

	#override<T>(setting: Setting<T>, value: T): void {
		const settings = this.#host.settings;
		const wasRuntime = settings.getProvenance(setting) === "runtime";
		const previous = setting.layered(settings);
		setting.override(settings, value);
		this.#undo.push(() => (wasRuntime ? setting.override(settings, previous) : setting.clearOverride(settings)));
	}

	#revertOverrides(): void {
		for (const undo of this.#undo.reverse()) undo();
		this.#undo = [];
		this.#approvalBaseMode = undefined;
	}

	/** A profile whose definition a repository can supply: a project profile file, or `profiles.*` from project settings. */
	#isProjectSourced(profile: ProfileDefinition): boolean {
		return (
			profile.source === "project" ||
			(profile.source === "settings" && cfgProfiles.provenance(this.#host.settings) === "project")
		);
	}

	/** The session's own approval mode: what applies with no profile override, and whether a CLI flag or runtime change set it. */
	#approvalBase(): { mode: ProfileApprovalMode; runtime: boolean } {
		if (this.#approvalBaseMode) return this.#approvalBaseMode;
		const settings = this.#host.settings;
		return {
			mode: cfgToolsApprovalMode.layered(settings),
			runtime: settings.getProvenance(cfgToolsApprovalMode) === "runtime",
		};
	}

	/**
	 * Why switching to `name` would loosen the session's permissions compared with the active
	 * profile (a looser approval mode, more tools, wider path or approval policies), or undefined
	 * when it would not. Used to keep remote guests from widening what the host allowed.
	 */
	looseningOf(name: string): string | undefined {
		const target = findProfile(this.catalog(), name);
		if (!target) return undefined;
		const base = this.#approvalBase();
		return describeLoosening(this.#active, target, {
			approvalMode: base.mode,
			approvalModeCapped: base.runtime || this.#isProjectSourced(target),
		});
	}

	async #apply(profile: ProfileDefinition, options: { restore: boolean; constrain?: boolean }): Promise<void> {
		const host = this.#host;

		this.#revertOverrides();
		if (profile.approvalMode) {
			// A mode set by a CLI flag, and the user's own mode under a profile a repository supplies,
			// are floors: the profile may tighten them but never loosen them.
			const base = this.#approvalBase();
			const capped = base.runtime || options.constrain === true || this.#isProjectSourced(profile);
			const mode = capped ? stricterApprovalMode(base.mode, profile.approvalMode) : profile.approvalMode;
			this.#approvalBaseMode = base;
			this.#override(cfgToolsApprovalMode, mode);
		}
		if (profile.approval) {
			this.#override(cfgToolsApproval, mergeApproval(cfgToolsApproval.layered(host.settings), profile.approval));
		}
		const outsideProject = cfgToolsOutsideProject.layered(host.settings);
		if (profile.pathRules) {
			const inherited = parsePathRules(cfgToolsPathRules.layered(host.settings));
			this.#override(cfgToolsPathRules, mergePathRules(inherited, profile.pathRules, outsideProject));
		}
		if (profile.outsideProject) {
			this.#override(cfgToolsOutsideProject, stricterOutsideProject(outsideProject, profile.outsideProject));
		}

		const sectionChanged = profile.prompt !== this.#promptSection;
		this.#promptSection = profile.prompt;
		this.#active = profile;

		const filter = toolFilterOf(profile);
		let toolsReapplied = false;
		if (filter || this.#filtered) {
			toolsReapplied = await host.setToolFilter(filter);
			this.#filtered = filter !== undefined;
		}
		if (sectionChanged && !toolsReapplied) await host.refreshPrompt();

		if (!options.restore) await this.#applyModel(profile);
		for (const listener of this.#listeners) listener(profile);
	}

	/**
	 * Moves the session onto the profile's model and thinking level. The first profile to change
	 * either remembers what the session had; a profile that sets neither puts it back, unless the
	 * user has moved off the profile's choice in the meantime.
	 */
	async #applyModel(profile: ProfileDefinition): Promise<void> {
		const host = this.#host;
		const left = this.#applied;
		this.#applied = {};
		try {
			if (profile.model || profile.thinkingLevel !== undefined) {
				this.#baseline ??= { model: host.currentModel(), thinkingLevel: host.currentThinkingLevel() };
			}
			let level = profile.thinkingLevel;
			if (profile.model) {
				const resolved = host.resolveModel(profile.model);
				if (!resolved) {
					host.notify(
						"warning",
						`Profile ${profile.name}: model ${JSON.stringify(profile.model)} is not available`,
					);
				} else {
					level ??= resolved.thinkingLevel;
					const current = host.currentModel();
					if (current?.id !== resolved.model.id || current.provider !== resolved.model.provider) {
						await host.setModel(resolved.model, level);
						this.#applied.thinkingLevel = level;
						level = undefined;
					}
					this.#applied.model = resolved.model;
				}
			} else {
				await this.#restoreModel(left);
			}
			if (level !== undefined) {
				host.setThinkingLevel(level);
				this.#applied.thinkingLevel = level;
			} else if (!profile.model && profile.thinkingLevel === undefined) {
				this.#restoreThinking(left);
			}
		} catch (err) {
			host.notify(
				"error",
				`Profile ${profile.name}: could not apply its model (${err instanceof Error ? err.message : String(err)})`,
			);
		}
		if (this.#applied.model === undefined && this.#applied.thinkingLevel === undefined) this.#baseline = undefined;
	}

	async #restoreModel(left: { model?: Model }): Promise<void> {
		const host = this.#host;
		const baseline = this.#baseline;
		const current = host.currentModel();
		if (
			!left.model ||
			!baseline?.model ||
			current?.id !== left.model.id ||
			current.provider !== left.model.provider
		) {
			return;
		}
		await host.setModel(baseline.model, baseline.thinkingLevel);
	}

	#restoreThinking(left: { thinkingLevel?: ConfiguredThinkingLevel }): void {
		const host = this.#host;
		if (left.thinkingLevel !== undefined && host.currentThinkingLevel() === left.thinkingLevel) {
			host.setThinkingLevel(this.#baseline?.thinkingLevel);
		}
	}
}
