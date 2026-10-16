/**
 * The Personal agent's runtime in the companion (docs/personal-agent.md). The module graph:
 *
 * - `companion-personal-store`: paths, JSONL stores, `state.json`, About you;
 * - `companion-personal-profile`: the profile's layout, `config.yml`, login, owner key, launch overlays;
 * - `companion-personal-events`: normalise, sign and file events for the live session;
 * - `companion-personal-{inbox,spend,settings,sources}`: inbox/proposals/digests, spend alerts, settings frames, MCP poll jobs;
 * - `companion-personal-{memory,review,backup}`: the memory frames, the nightly review, backups;
 * - `companion-personal-chat`: chat-tree mode's files (the session's `status.json`, the first-start note);
 * - this file: the shared {@link PersonalDeps}, the run state, keep-alive, rollover, the request dispatch and the hosts-frame marks.
 *
 * Nothing runs until the owner sets Personal up and turns it on: with Personal never set up, no file under the
 * profile or `run/personal/` is written and no timer starts (everything is driven from the companion's own poll,
 * which calls {@link Personal.tick}).
 */

import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { openMemoryAdmin } from "@oh-my-pi/pi-mnemopi/admin";
import type { MemoryAdmin } from "@oh-my-pi/pi-mnemopi/admin-types";
import type {
	PersonalChanged,
	PersonalChangeKind,
	PersonalEventRecord,
	PersonalMemoryMode,
	PersonalReply,
	PersonalRequest,
	PersonalRunState,
	PersonalSettings,
	PersonalStatus,
} from "@oh-my-pi/pi-wire/personal";
import { PERSONAL_DEFAULTS, PERSONAL_LOGIN_COMMAND } from "@oh-my-pi/pi-wire/personal";
import type { PersonalEvent, PersonalIpcReply, PersonalIpcRequest } from "@oh-my-pi/pi-wire/personal-ipc";
import { PERSONAL_PROFILE } from "@oh-my-pi/pi-wire/personal-ipc";
import type { Schedule } from "@oh-my-pi/pi-wire/schedule";
import { SCHEDULE_IPC_FILE } from "@oh-my-pi/pi-wire/schedule";
import type { CompanionHost } from "../src/lib/companion";
import { createPersonalBackup } from "./companion-personal-backup";
import { chatHasMessages, NOTE_CONTROL_PREFIX, noteChunks, readChatTreeStatus } from "./companion-personal-chat";
import { createPersonalEvents, type EventDraft } from "./companion-personal-events";
import { createPersonalInbox } from "./companion-personal-inbox";
import { createPersonalMemoryFrames } from "./companion-personal-memory";
import { createPersonalProfile, type PersonalProfile } from "./companion-personal-profile";
import { createPersonalReview } from "./companion-personal-review";
import { type PersonalOmpRun, type PersonalOmpResult, runPersonalOmp } from "./companion-personal-run";
import { createPersonalSettings } from "./companion-personal-settings";
import { createPersonalSources } from "./companion-personal-sources";
import { createPersonalSpend } from "./companion-personal-spend";
import {
	createAboutStore,
	openPersonalState,
	openPersonalStores,
	type PersonalAboutStore,
	type PersonalPaths,
	type PersonalSessionRecord,
	type PersonalStateStore,
	type PersonalStores,
	personalPaths,
} from "./companion-personal-store";
import type { PersonalIpcHandlers } from "./companion-schedule-ipc";
import type { ScheduleIpc } from "./companion-schedule-ipc";
import {
	findTmux,
	killTmuxSession,
	launchEnded,
	launchFailure,
	launchInTmux,
	launchScreen,
	releaseLaunch,
	type TmuxLaunch,
} from "./companion-start";
import { assistantReplySince, findSessionFile, readSessionTail } from "./companion-sessions";

// ── shared helpers ───────────────────────────────────────────────────────────

/** What a push to the owner's devices carries (the companion adds `computer`, the VAPID key and the send). */
export interface OwnerPush {
	title: string;
	body: string;
	/** A route from `PERSONAL_ROUTES` (`personal/inbox` …) the service worker hands to the app. */
	open: string;
	/** `personal-<kind>`: a newer notice replaces one still on screen. */
	tag: string;
	badge?: number;
}

/**
 * The helpers every Personal module is built on, assembled once by {@link createPersonal}. Modules declare the narrow
 * slice they use; this object satisfies them all structurally.
 */
export interface PersonalDeps {
	paths: PersonalPaths;
	profile: PersonalProfile;
	stores: PersonalStores;
	state: PersonalStateStore;
	about: PersonalAboutStore;
	now(): number;
	/** The omp binary that runs sessions (`omp --profile personal …`). */
	ompBin: string;
	/** Something changed: bump the status revision and tell every connected device (`personal-changed`). */
	changed(what: PersonalChangeKind[]): void;
	/** Push to the owner's paired devices that are not showing the app right now. */
	pushOwner(push: OwnerPush): void;
	/** An owner-trust event for the live session, signed with the owner key (an answer, an accepted About-you change). */
	enqueueOwnerEvent(draft: EventDraft): Promise<PersonalEvent>;
	/** An external-trust event (a source's poll result). */
	enqueueExternalEvent(draft: EventDraft): Promise<PersonalEvent>;
	/** Personal is set up and switched on. */
	enabled(): boolean;
	/** The profile holds a usable login. */
	loginReady(): Promise<boolean>;
	/** The settings in force. */
	settings(): PersonalSettings;
	/** A background failure: logged by the companion. */
	onError(err: unknown): void;
	/** A memory handle over the profile's bank; the caller closes it. */
	openAdmin(options?: { readOnly?: boolean }): MemoryAdmin;
}

/** What the companion hands the runtime: the computer it runs on and the few things only `companion.ts` can do. */
export interface PersonalEnv {
	/** `<home>/<PI_CONFIG_DIR or .omp>`. */
	configRoot: string;
	machine: string;
	/** The companion's room id: what the app calls the computer. */
	computerId: string;
	ompBin: string;
	relayUrl: string;
	webUrl: string;
	localRelayUrl(): string | undefined;
	now(): number;
	/** A fresh listing of the omp hosts on this computer. */
	listHosts(): Promise<CompanionHost[]>;
	/** End a session the companion started (kills its tmux session). */
	endHost(instanceId: string): Promise<void>;
	/** Push to the subscribed devices; `presenceAware` skips those showing the app right now. */
	pushOwner(push: OwnerPush, options: { presenceAware: boolean }): void;
	/** Send a frame to every authenticated device. */
	broadcast(frame: PersonalChanged): void;
	/** The hosts frame changed (a revision moved): send it. */
	refresh(): void;
	/** The loopback server whose endpoint files the runtime publishes while Personal is on. */
	ipc(): Pick<ScheduleIpc, "publishPersonal" | "publishSchedule" | "unpublish">;
	/** Where the companion keeps its own files for a launch (overlay, first prompt). */
	overlayFile: string;
	promptDir: string;
	/** Default profile's sessions folder, for lookups that cover both. */
	defaultSessionsDir: string;
	/** Tests replace these. */
	launcher?: Launcher;
	timing?: Partial<Timing>;
	runOmp?(run: PersonalOmpRun): Promise<PersonalOmpResult>;
}

/** tmux operations of a launch (see `companion-start`). */
export interface Launcher {
	findTmux(): Promise<string | null>;
	launch(launch: TmuxLaunch): Promise<{ name: string; cwd: string }>;
	ended(tmux: string, name: string): Promise<{ tail: string } | null>;
	screen(tmux: string, name: string): Promise<string>;
	release(tmux: string, name: string): Promise<void>;
	kill(tmux: string, name: string): Promise<void>;
}

const defaultLauncher: Launcher = {
	findTmux,
	launch: launchInTmux,
	ended: launchEnded,
	screen: launchScreen,
	release: releaseLaunch,
	kill: killTmuxSession,
};

export interface Timing {
	/** How long a start waits for the new host to be listed. */
	startWaitMs: number;
	pollMs: number;
	/** A rollover waits this long for the session to answer with its handoff note. */
	replyWaitMs: number;
	/** A rollover or stop waits this long for the session to exit before it ends it. */
	exitWaitMs: number;
}

const DEFAULT_TIMING: Timing = { startWaitMs: 45_000, pollMs: 1_000, replyWaitMs: 5 * 60_000, exitWaitMs: 90_000 };

// ── clock and decisions (pure) ───────────────────────────────────────────────

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Local `YYYY-MM-DD`. */
export function localDay(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Minutes since local midnight that `HH:MM` names. */
export function clockMinutes(hhmm: string): number {
	const [h = "0", m = "0"] = hhmm.split(":");
	return Number(h) * 60 + Number(m);
}

/** The next local `HH:MM` strictly after `now`. */
export function nextLocalTime(now: number, hhmm: string): number {
	const minutes = clockMinutes(hhmm);
	const at = new Date(now);
	at.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
	if (at.getTime() <= now) at.setDate(at.getDate() + 1);
	return at.getTime();
}

/** The daily rollover is due: its local time has passed today, it has not run today, and the session is idle. */
export function rolloverDue(now: number, time: string, doneDay: string | null): boolean {
	const d = new Date(now);
	return d.getHours() * 60 + d.getMinutes() >= clockMinutes(time) && doneDay !== localDay(now);
}

/** Start waits 15 s after the first failure, doubling to at most 5 minutes. */
export function backoffMs(failures: number): number {
	return Math.min(5 * 60_000, 15_000 * 2 ** Math.max(0, failures - 1));
}

/** Failures in a row after which a start is `failed` (and the owner is told). */
export const FAILED_AFTER = 3;
/** The session file this big stands in for a full context: the companion has no context gauge of the host. */
export const ROLLOVER_SESSION_BYTES = 6 * 1024 * 1024;

export interface KeepAliveInput {
	enabled: boolean;
	/** The owner stopped the session. */
	stopped: boolean;
	loginReady: boolean;
	live: { busy: boolean | null; inputRequired: boolean } | null;
	/** A start, rollover or stop is in flight. */
	lifecycleBusy: boolean;
	now: number;
	/** No start before this (the back-off). */
	nextStartAt: number;
	rolloverDue: boolean;
	contextFull: boolean;
	/** Chat-tree mode is configured: the daily time never ends the session (its view bounds the context; the chat carries continuity). */
	chatTree: boolean;
	/** The live session was launched in another memory mode than the configured one: restarting it makes the switch. */
	modeMismatch: boolean;
}

/** `renew` starts a fresh omp session in chat-tree mode (no handoff, the chat is kept); `rollover` restarts with a handoff or a mode change. */
export type KeepAliveAction = "none" | "start" | "rollover" | "renew";

/** What one poll should do about the Personal session. */
export function keepAliveDecision(input: KeepAliveInput): KeepAliveAction {
	if (!input.enabled || input.lifecycleBusy) return "none";
	if (input.live === null)
		return !input.stopped && input.loginReady && input.now >= input.nextStartAt ? "start" : "none";
	const idle = input.live.busy === false && !input.live.inputRequired;
	if (!idle) return "none";
	if (input.modeMismatch) return "rollover";
	if (input.chatTree) return input.contextFull ? "renew" : "none";
	return input.rolloverDue || input.contextFull ? "rollover" : "none";
}

const ROLLOVER_REQUEST = [
	"The day's session is ending. Reply with one handoff note for your next session, nothing else.",
	"Include what you were doing, anything you promised the owner, open questions you asked, and what to check next.",
	"Do not repeat what is already in memory or About you.",
].join(" ");

/** The first prompt of the session that follows a rollover. */
export function handoffPrompt(note: string): string {
	return `You are starting a new session. Your previous session left you this handoff note:\n\n${note}`;
}

/** Requests that change something: refused until the profile exists. */
const MUTATING: Record<string, true> = {
	"personal-enable": true,
	"personal-disable": true,
	"personal-control": true,
	"personal-backup-now": true,
	"personal-settings-set": true,
	"personal-memory-retract": true,
	"personal-memory-pin": true,
	"personal-memory-unpin": true,
	"personal-about-set": true,
	"personal-proposal-edit": true,
	"personal-proposal-accept": true,
	"personal-proposal-reject": true,
	"personal-digest-read": true,
	"personal-inbox-ack": true,
	"personal-answer": true,
};

const EVENTS_PAGE = 50;
const EVENTS_MAX_PAGE = 200;
const EVENT_MAINTAIN_MS = 30_000;
const CONTEXT_CHECK_MS = 60_000;
/** The chat's numbers reach the app's status at most this often. */
const CHAT_STATUS_PUSH_MS = 5_000;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ── the runtime ──────────────────────────────────────────────────────────────

export interface Personal {
	/** The two loopback paths (`/personal`, `/event`) for the schedule IPC server. */
	ipc: PersonalIpcHandlers;
	/** The frame is a `personal-*` request. */
	isRequest(frame: { t: string }): frame is PersonalRequest;
	/** Answer a `personal-*` request; rejects with a message fit for the app. */
	handleRequest(frame: unknown): Promise<PersonalReply>;
	/** One look at the hosts: keep-alive, rollover and every background job. Never rejects. */
	tick(hosts: readonly CompanionHost[]): Promise<void>;
	/** The hosts with the Personal session marked `personal: true`. */
	markHosts(hosts: CompanionHost[]): CompanionHost[];
	/** `canPersonal` / `canPersonalChatTree` / `personalRev` for the hosts frame. */
	hostsFields(canServe: boolean): { canPersonal?: true; canPersonalChatTree?: true; personalRev?: number };
	/** Personal is on: the companion keeps polling even with no device connected. */
	enabled(): boolean;
	/** The session is the Personal agent's: session organisation leaves it alone. */
	exempt(sessionId: string): boolean;
	isPersonalHost(host: Pick<CompanionHost, "cwd" | "instanceId">): boolean;
	/** Folders to look for session files in: the default profile's, and the Personal profile's once it exists. */
	sessionDirs(): string[];
	/** A schedule with `deliverTo: "personal"` fired. */
	deliverSchedule(schedule: Schedule): Promise<void>;
	/** Publish the endpoint files when Personal is already on at startup. */
	attach(): Promise<void>;
	/** The companion is stopping: stop background jobs (the session itself keeps running). */
	shutdown(): void;
	/** Resolves once every job the polls started (start, rollover, backup, review, sources) has finished. */
	idle(): Promise<void>;
	status(): Promise<PersonalStatus>;
	/** Exposed for tests and the integrator. */
	deps: PersonalDeps;
}

export async function createPersonal(env: PersonalEnv): Promise<Personal> {
	const now = env.now;
	const paths = personalPaths(env.configRoot);
	const timing: Timing = { ...DEFAULT_TIMING, ...env.timing };
	const launcher = env.launcher ?? defaultLauncher;
	const runOmp = env.runOmp ?? runPersonalOmp;
	const state = await openPersonalState(paths.stateFile);
	const stores = openPersonalStores(paths);
	const about = createAboutStore(paths, now);
	const settings = (): PersonalSettings => state.read().settings;
	const mode = (): PersonalMemoryMode => settings().memoryMode ?? PERSONAL_DEFAULTS.memoryMode;
	const enabled = (): boolean => state.read().setUp && state.read().enabled;
	const onError = (err: unknown): void => console.error(`companion: personal agent: ${errorText(err)}`);

	const profile = createPersonalProfile({
		paths,
		now,
		about,
		relayUrl: env.relayUrl,
		webUrl: env.webUrl,
		localRelayUrl: env.localRelayUrl,
		limits: () => settings().limits,
		memoryMode: mode,
	});

	/** Work started and not finished (a revision being saved, a start, a backup): {@link Personal.idle} waits for it. */
	const background = new Set<Promise<void>>();
	const track = (work: Promise<unknown>, onFail: (err: unknown) => void): void => {
		const running: Promise<void> = work.then(() => undefined, onFail);
		background.add(running);
		void running.then(() => background.delete(running));
	};

	const changed = (what: PersonalChangeKind[]): void => {
		track(
			state
				.update(s => ({ ...s, rev: s.rev + 1 }))
				.then(next => {
					env.broadcast({ t: "personal-changed", what, rev: next.rev });
					env.refresh();
				}),
			onError,
		);
	};

	const events = createPersonalEvents({
		paths,
		events: stores.events,
		now,
		ownerKey: () => profile.ownerKey(),
		changed,
	});

	// Login: refreshed by status and every tick; a ready → missing edge raises an alert once.
	let loginOk = false;
	let loginSeen = false;
	const loginReady = async (): Promise<boolean> => {
		const ok = (await profile.login()).state === "ready";
		const lost = loginSeen && loginOk && !ok;
		loginSeen = true;
		loginOk = ok;
		if (lost && enabled())
			void inbox
				.alert({
					title: "The Personal agent lost its login",
					body: `Run ${PERSONAL_LOGIN_COMMAND} on ${env.machine} to sign in again.`,
					tag: "personal-login",
				})
				.catch(onError);
		return ok;
	};

	const deps: PersonalDeps = {
		paths,
		profile,
		stores,
		state,
		about,
		now,
		ompBin: env.ompBin,
		changed,
		pushOwner: push => env.pushOwner(push, { presenceAware: true }),
		enqueueOwnerEvent: draft => events.enqueueOwner(draft),
		enqueueExternalEvent: draft => events.enqueueExternal(draft),
		enabled,
		loginReady,
		settings,
		onError,
		openAdmin: options => openMemoryAdmin({ agentDir: paths.agentDir, ...options }),
	};

	const inbox = createPersonalInbox(deps);
	const spend = createPersonalSpend({ ...deps, alert: a => inbox.alert(a) });
	const settingsService = createPersonalSettings(deps);
	const sources = createPersonalSources({ ...deps, limitsAllow: () => spend.limitsAllow(), run: runOmp });
	const backup = createPersonalBackup({ ...deps, alert: a => inbox.alert(a) });
	const memory = createPersonalMemoryFrames(deps);

	// ── the live session ────────────────────────────────────────────────────

	let workspaceReal = paths.workspace;
	let live: CompanionHost | null = null;
	let lifecycle: "starting" | "rollover" | "stopping" | null = null;
	let failures = 0;
	let nextStartAt = 0;
	let failureAlerted = false;
	let lastEventsMaintain = 0;
	let contextFull = false;
	let lastContextCheck = 0;
	let lastRun: PersonalRunState = "off";

	/** A host registers the folder as its process sees it (`/var/...` for `/private/var/...` on macOS), so compare resolved paths too. */
	const inWorkspace = (cwd: string): boolean => {
		if (cwd === workspaceReal || cwd === paths.workspace) return true;
		try {
			return realpathSync(cwd) === workspaceReal;
		} catch {
			return false;
		}
	};

	const isPersonalHost = (host: Pick<CompanionHost, "cwd" | "instanceId">): boolean => {
		if (!enabled()) return false;
		if (!inWorkspace(host.cwd)) return false;
		const recorded = state.read().session?.instanceId ?? null;
		return recorded === null || host.instanceId === recorded;
	};

	const review = createPersonalReview({
		...deps,
		reviews: stores.reviews,
		proposals: stores.proposals,
		rejected: stores.rejected,
		finishReview: run => inbox.finishReview({ since: run.since, costUsd: run.costUsd ?? 0 }),
		limitsAllow: () => spend.limitsAllow(),
		sessionBusy: () => (live === null ? null : live.busy === true || live.inputRequired),
		runOmp,
		overlayFile: path.join(paths.personalDir, "review-overlay.yml"),
		alert: a => inbox.alert(a),
	});

	const runState = (): PersonalRunState => {
		if (!enabled()) return "off";
		if (live !== null) {
			if (live.inputRequired) return "waiting";
			return live.busy === false ? "idle" : "working";
		}
		if (lifecycle !== null) return "starting";
		if (failures >= FAILED_AFTER) return "failed";
		if (state.read().stopped || !loginOk) return "stopped";
		return "starting";
	};

	const sessionOf = (): PersonalSessionRecord | null => {
		const recorded = state.read().session;
		return live === null || recorded === null ? null : recorded;
	};

	/** Keep the record in step with the host that is live now (a hand-started or resumed session is adopted). */
	const adopt = async (host: CompanionHost): Promise<void> => {
		const recorded = state.read().session;
		if (recorded?.sessionId === host.sessionId && recorded.instanceId === host.instanceId) return;
		const known = recorded?.sessionId === host.sessionId;
		const generation = known ? recorded.generation : state.read().generation + 1;
		await state.update(s => ({
			...s,
			// A session started by hand is taken to be in the mode configured now: a restart would not change that.
			session: {
				sessionId: host.sessionId,
				instanceId: host.instanceId,
				startedAt: host.startedAt,
				generation,
				mode: known ? recorded.mode : mode(),
			},
			generation: Math.max(s.generation, generation),
		}));
		changed(["status"]);
	};

	/** The memory mode a live session was launched with; null when the record is not about that session yet. */
	const launchedMode = (host: CompanionHost): PersonalMemoryMode | null => {
		const recorded = state.read().session;
		return recorded?.sessionId === host.sessionId ? (recorded.mode ?? PERSONAL_DEFAULTS.memoryMode) : null;
	};

	/** The handoff note of the recall session that ended becomes the endless chat's first message: owner-signed `control` events the session logs as `note`s, never a turn. */
	const deliverChatNote = async (note: string): Promise<void> => {
		const at = now();
		for (const [index, chunk] of noteChunks(note).entries()) {
			await events.enqueueOwner({
				source: "companion",
				kind: "control",
				title: "Handoff note",
				body: `${NOTE_CONTROL_PREFIX}${chunk}`,
				at: at + index,
			});
		}
	};

	/** Poll the listing until `done` says yes (or `ms` passed). */
	const waitFor = async <T>(ms: number, probe: () => Promise<T | null>): Promise<T | null> => {
		const until = now() + ms;
		for (;;) {
			const found = await probe();
			if (found !== null) return found;
			if (now() >= until) return null;
			await Bun.sleep(timing.pollMs);
		}
	};

	const hostNow = async (sessionId: string): Promise<CompanionHost | null> =>
		(await env.listHosts()).find(host => host.sessionId === sessionId && isPersonalHost(host)) ?? null;

	const recordFailure = async (message: string): Promise<void> => {
		failures += 1;
		nextStartAt = now() + backoffMs(failures);
		await state.update(s => ({ ...s, error: message }));
		changed(["status"]);
		if (failures >= FAILED_AFTER && !failureAlerted) {
			failureAlerted = true;
			await inbox
				.alert({
					title: "The Personal agent will not start",
					body: `${message}. The companion keeps trying every few minutes.`,
					tag: "personal-run",
				})
				.catch(onError);
		}
	};

	/** Start the session: resume the recorded one, or begin a new one with the handoff as its first prompt. */
	const launch = async (): Promise<void> => {
		if (!(await loginReady())) throw new Error(`The Personal agent has no login: run ${PERSONAL_LOGIN_COMMAND}`);
		const tmux = await launcher.findTmux();
		if (tmux === null) throw new Error("tmux is not installed on this computer");
		const target = mode();
		const recorded = state.read().session;
		const handoff = state.read().handoff;
		// The first start of the endless chat takes the stored note as its first message; once it has messages the note is stale.
		const chatNote = target === "chat-tree" && handoff !== null && !(await chatHasMessages(paths)) ? handoff : null;
		// A recall session resumes unless a note waits for it; any session starts anew when the memory mode changed.
		const recordedFile =
			recorded !== null &&
			(target === "chat-tree" || handoff === null) &&
			(recorded.mode ?? PERSONAL_DEFAULTS.memoryMode) === target &&
			failures < FAILED_AFTER
				? await findSessionFile(paths.sessionsDir, recorded.sessionId)
				: null;
		const resume = recordedFile === null || recorded === null ? undefined : recorded.sessionId;
		const spawnedAt = now();
		const launched = await launcher.launch({
			tmux,
			ompBin: env.ompBin,
			overlayPath: env.overlayFile,
			promptDir: env.promptDir,
			localRelayUrl: env.localRelayUrl(),
			cwd: paths.workspace,
			resume,
			prompt: target === "recall" && resume === undefined && handoff !== null ? handoffPrompt(handoff) : undefined,
			keepEnded: true,
			profile: { name: PERSONAL_PROFILE, overlayYaml: profile.overlayText("live") },
		});
		workspaceReal = launched.cwd;
		while (now() < spawnedAt + timing.startWaitMs) {
			await Bun.sleep(timing.pollMs);
			let hosts: CompanionHost[];
			try {
				hosts = await env.listHosts();
			} catch {
				continue;
			}
			const host = hosts.find(
				h =>
					inWorkspace(h.cwd) && (resume !== undefined ? h.sessionId === resume : h.startedAt >= spawnedAt - 1_000),
			);
			if (host !== undefined) {
				const generation =
					resume !== undefined && recorded !== null ? recorded.generation : state.read().generation + 1;
				const today = localDay(now());
				const pastRollover = rolloverDue(now(), settings().rollover.time, null);
				await state.update(s => ({
					...s,
					session: {
						sessionId: host.sessionId,
						instanceId: host.instanceId,
						startedAt: host.startedAt,
						generation,
						mode: target,
					},
					generation: Math.max(s.generation, generation),
					handoff: chatNote === null ? null : s.handoff,
					stopped: false,
					rolloverDay: pastRollover ? today : s.rolloverDay,
					error: undefined,
				}));
				await launcher.release(tmux, launched.name);
				failures = 0;
				failureAlerted = false;
				nextStartAt = 0;
				live = host;
				if (chatNote !== null) {
					// The stored note stays until every piece is in the inbox; a failed hand-over keeps it for the next start (while the chat is still empty).
					await deliverChatNote(chatNote).then(
						() => state.update(s => ({ ...s, handoff: s.handoff === chatNote ? null : s.handoff })),
						onError,
					);
				}
				changed(["status"]);
				return;
			}
			const ended = await launcher.ended(tmux, launched.name);
			if (ended !== null) {
				await launcher.kill(tmux, launched.name);
				throw new Error(launchFailure("The Personal agent stopped before it was ready", ended.tail));
			}
		}
		const screen = await launcher.screen(tmux, launched.name);
		await launcher.kill(tmux, launched.name);
		throw new Error(launchFailure("The Personal agent did not start hosting in time", screen));
	};

	/** The session finishes the turn in progress, retains and consolidates its memory, and exits; it is ended when it does not. */
	const exitSession = async (host: CompanionHost): Promise<void> => {
		await events.enqueueOwner({ source: "companion", kind: "control", title: "Exit", body: "exit" });
		const gone = await waitFor(timing.exitWaitMs, async () =>
			(await hostNow(host.sessionId)) === null ? true : null,
		);
		if (gone === null) await env.endHost(host.instanceId);
		live = null;
	};

	/** A lifecycle step runs alone: keep-alive, rollover and the owner's controls never overlap. */
	const exclusive = async (kind: NonNullable<typeof lifecycle>, work: () => Promise<void>): Promise<void> => {
		if (lifecycle !== null) throw new Error(`The Personal agent is busy (${lifecycle})`);
		lifecycle = kind;
		changed(["status"]);
		try {
			await work();
		} finally {
			lifecycle = null;
		}
	};

	/** Start the session; a failure is counted, backed off and (after a few) told to the owner. */
	const launchOrFail = async (): Promise<void> => {
		try {
			await launch();
		} catch (err) {
			await recordFailure(errorText(err));
			throw err;
		}
	};

	const start = (): Promise<void> => exclusive("starting", launchOrFail);

	/**
	 * Restart the live session. A recall session is asked for a handoff note first and the next one starts with it as
	 * its first prompt. A chat-tree session is not: the chat holds everything, so it restarts at once and, unless the
	 * memory mode changed, resumes its omp session; the chat continues either way. `fresh` (a full context in chat-tree
	 * mode) starts a new omp session instead, with no handoff and no first prompt: `personal-chat/` is untouched.
	 */
	const rollover = (fresh = false): Promise<void> =>
		exclusive("rollover", async () => {
			const host = live;
			if (host === null) {
				await launchOrFail();
				return;
			}
			const running = launchedMode(host) ?? mode();
			const idle = await waitFor(timing.replyWaitMs, async () => {
				const current = await hostNow(host.sessionId);
				return current !== null && current.busy === false && !current.inputRequired ? current : null;
			});
			if (idle === null) throw new Error("The Personal agent is busy; try again when it is idle");
			let note: string | null = null;
			if (running === "recall") {
				const asked = now();
				await events.enqueueOwner({
					source: "companion",
					kind: "rollover",
					title: "Rollover",
					body: ROLLOVER_REQUEST,
				});
				note = await waitFor(timing.replyWaitMs, async () => {
					const current = await hostNow(host.sessionId);
					if (current === null || current.busy !== false) return null;
					return assistantReplySince(await readSessionTail(paths.sessionsDir, host.sessionId), asked);
				});
			}
			await exitSession(host);
			const resumes = !fresh && running === "chat-tree" && mode() === "chat-tree";
			await state.update(s => ({
				...s,
				handoff: note ?? s.handoff,
				session: resumes ? s.session : null,
				rolloverDay: localDay(now()),
			}));
			// The new session is not full yet; its size is read again on the next check.
			contextFull = false;
			await launchOrFail();
		});

	const stop = (): Promise<void> =>
		exclusive("stopping", async () => {
			const host = live;
			if (host !== null) await exitSession(host);
			await state.update(s => ({ ...s, stopped: true }));
			changed(["status"]);
		});

	const publishEndpoints = async (): Promise<void> => {
		const ipc = env.ipc();
		await ipc.publishPersonal(paths.ipcFile);
		await ipc.publishSchedule(path.join(paths.agentDir, SCHEDULE_IPC_FILE));
	};
	const unpublishEndpoints = async (): Promise<void> => {
		const ipc = env.ipc();
		await ipc.unpublish(paths.ipcFile);
		await ipc.unpublish(path.join(paths.agentDir, SCHEDULE_IPC_FILE));
	};

	// ── status ──────────────────────────────────────────────────────────────

	const status = async (): Promise<PersonalStatus> => {
		const s = state.read();
		const [login, spendNow, backups, reviewNow, counts] = await Promise.all([
			profile.login(),
			spend.read(),
			backup.status(),
			review.status(),
			inbox.counts(),
		]);
		loginOk = login.state === "ready";
		const session = sessionOf();
		const chat = enabled() && mode() === "chat-tree" ? await readChatTreeStatus(paths) : null;
		return {
			setUp: s.setUp,
			enabled: enabled(),
			homeComputer: { computerId: env.computerId, machine: env.machine },
			login,
			run: runState(),
			session:
				session === null
					? null
					: {
							sessionId: session.sessionId,
							instanceId: session.instanceId,
							startedAt: session.startedAt,
							generation: session.generation,
						},
			spend: spendNow,
			backups,
			review: reviewNow,
			nextRolloverAt: enabled() && mode() === "recall" ? nextLocalTime(now(), s.settings.rollover.time) : null,
			counts,
			rev: s.rev,
			...(chat !== null ? { chatTree: chat } : {}),
			...(s.error !== undefined && enabled() ? { error: s.error } : {}),
		};
	};

	// ── the owner's controls ────────────────────────────────────────────────

	const requireSetUp = (): void => {
		if (!state.read().setUp) throw new Error("Set up the Personal agent first");
	};

	const setup = async (about_?: string): Promise<void> => {
		await profile.setup(settings(), about_);
		await state.update(s => ({ ...s, setUp: true, enabled: true, stopped: false }));
		await publishEndpoints();
		changed(["status", "settings", "about"]);
	};

	const enable = async (): Promise<void> => {
		requireSetUp();
		await profile.repair(settings());
		await state.update(s => ({ ...s, enabled: true, stopped: false }));
		failures = 0;
		failureAlerted = false;
		nextStartAt = 0;
		await publishEndpoints();
		changed(["status"]);
	};

	const disable = async (): Promise<void> => {
		requireSetUp();
		if (lifecycle === null && live !== null) await stop();
		sources.stop();
		await state.update(s => ({ ...s, enabled: false, stopped: false }));
		await unpublishEndpoints();
		changed(["status"]);
	};

	const control = async (action: "start" | "stop" | "restart"): Promise<void> => {
		requireSetUp();
		if (!enabled()) throw new Error("The Personal agent is turned off");
		if (action === "stop") {
			await stop();
			return;
		}
		await state.update(s => ({ ...s, stopped: false }));
		if (action === "restart") {
			await rollover();
			return;
		}
		if (live === null) await start();
	};

	// ── requests ────────────────────────────────────────────────────────────

	const listEvents = async (limit: unknown, before: unknown): Promise<PersonalEventRecord[]> => {
		const page = typeof limit === "number" && limit >= 1 ? Math.min(Math.floor(limit), EVENTS_MAX_PAGE) : EVENTS_PAGE;
		const cutoff = typeof before === "number" ? before : Number.POSITIVE_INFINITY;
		return (await stores.events.list())
			.filter(event => event.at < cutoff)
			.sort((a, b) => b.at - a.at)
			.slice(0, page);
	};

	const handleRequest = async (frame: unknown): Promise<PersonalReply> => {
		const request = frame as PersonalRequest;
		if (Object.hasOwn(MUTATING, request.t)) requireSetUp();
		switch (request.t) {
			case "personal-status":
				return { t: request.t, reqId: request.reqId, status: await status() };
			case "personal-setup":
				if (request.about !== undefined && typeof request.about !== "string") throw new Error("invalid request");
				await setup(request.about);
				return { t: request.t, reqId: request.reqId, status: await status() };
			case "personal-enable":
				await enable();
				return { t: request.t, reqId: request.reqId, status: await status() };
			case "personal-disable":
				await disable();
				return { t: request.t, reqId: request.reqId, status: await status() };
			case "personal-control":
				if (request.action !== "start" && request.action !== "stop" && request.action !== "restart")
					throw new Error("invalid action");
				await control(request.action);
				return { t: request.t, reqId: request.reqId, status: await status() };
			case "personal-backup-now": {
				if (backup.running()) throw new Error("A backup is already running.");
				const result = await backup.run({ force: true });
				return {
					t: request.t,
					reqId: request.reqId,
					ok: result.ok,
					...(result.error === undefined ? {} : { error: result.error }),
					status: await status(),
				};
			}
			case "personal-events":
				return { t: request.t, reqId: request.reqId, events: await listEvents(request.limit, request.before) };
			default: {
				const reply =
					(await settingsService.handle(request)) ??
					(await memory.handle(request)) ??
					(await inbox.handle(request));
				if (reply === undefined) throw new Error("unknown request");
				return reply;
			}
		}
	};

	// ── the poll ────────────────────────────────────────────────────────────

	const guard = (what: string, work: () => Promise<unknown>): void => {
		track(work(), err => onError(new Error(`${what}: ${errorText(err)}`)));
	};

	const checkContext = async (sessionId: string): Promise<void> => {
		const file = await findSessionFile(paths.sessionsDir, sessionId);
		contextFull = file !== null && Bun.file(file).size >= ROLLOVER_SESSION_BYTES;
	};

	let chatSeen = "";
	let chatPushedAt = 0;
	/** Tell the devices when the chat's numbers moved (messages, lines still being summarised), at most every few seconds. */
	const watchChatStatus = async (): Promise<void> => {
		const chat = await readChatTreeStatus(paths);
		const signature = chat === null ? "" : JSON.stringify(chat);
		if (signature === chatSeen || now() - chatPushedAt < CHAT_STATUS_PUSH_MS) return;
		chatSeen = signature;
		chatPushedAt = now();
		changed(["status"]);
	};

	const tick = async (hosts: readonly CompanionHost[]): Promise<void> => {
		if (!enabled()) return;
		try {
			workspaceReal = await fs.realpath(paths.workspace).catch(() => paths.workspace);
			live = hosts.find(isPersonalHost) ?? null;
			if (live !== null) {
				// A start or rollover in progress records its own session (and counts the generation) when its host appears.
				if (lifecycle === null) await adopt(live);
				if (failures > 0) {
					failures = 0;
					failureAlerted = false;
					nextStartAt = 0;
				}
				if (now() - lastContextCheck >= CONTEXT_CHECK_MS) {
					lastContextCheck = now();
					await checkContext(live.sessionId);
				}
			} else {
				contextFull = false;
			}
			const ready = await loginReady();
			const run = runState();
			if (run !== lastRun) {
				lastRun = run;
				changed(["status"]);
			}
			if (mode() === "chat-tree") await watchChatStatus();
			if (now() - lastEventsMaintain >= EVENT_MAINTAIN_MS) {
				lastEventsMaintain = now();
				guard("event channel", () => events.maintain());
			}
			guard("spend check", () => spend.tick());
			guard("sources", () => sources.tick());
			guard("backup", () => backup.tick());
			guard("review", () => review.tick());
			const launchedAs = live === null ? null : launchedMode(live);
			const action = keepAliveDecision({
				enabled: true,
				stopped: state.read().stopped,
				loginReady: ready,
				live: live === null ? null : { busy: live.busy, inputRequired: live.inputRequired },
				lifecycleBusy: lifecycle !== null,
				now: now(),
				nextStartAt,
				rolloverDue: rolloverDue(now(), settings().rollover.time, state.read().rolloverDay),
				contextFull,
				chatTree: mode() === "chat-tree",
				modeMismatch: launchedAs !== null && launchedAs !== mode(),
			});
			if (action === "start") guard("starting the session", start);
			else if (action === "rollover") guard("rollover", () => rollover());
			else if (action === "renew") guard("fresh session", () => rollover(true));
		} catch (err) {
			onError(err);
		}
	};

	// ── the loopback channel ────────────────────────────────────────────────

	const ipc: PersonalIpcHandlers = {
		serving: enabled,
		async request(request: PersonalIpcRequest): Promise<PersonalIpcReply> {
			if (typeof request.op !== "string") return { ok: false, error: "unknown operation" };
			switch (request.op) {
				case "notify":
					return await inbox.notify(request);
				case "hello":
					if (typeof request.sessionId !== "string" || typeof request.pid !== "number")
						return { ok: false, error: "invalid hello" };
					return { ok: true };
				case "receipt":
					if (typeof request.eventId !== "string" || typeof request.outcome !== "string")
						return { ok: false, error: "invalid receipt" };
					await events.receipt(request.eventId, request.outcome, request.detail);
					return { ok: true };
				default:
					return { ok: false, error: "unknown operation" };
			}
		},
		event: input => events.ingest(input),
	};

	return {
		ipc,
		isRequest: (frame): frame is PersonalRequest => typeof frame.t === "string" && frame.t.startsWith("personal-"),
		handleRequest,
		tick,
		markHosts: hosts => hosts.map(host => (isPersonalHost(host) ? { ...host, personal: true as const } : host)),
		hostsFields: canServe => ({
			...(canServe ? { canPersonal: true as const, canPersonalChatTree: true as const } : {}),
			...(enabled() ? { personalRev: state.read().rev } : {}),
		}),
		enabled,
		exempt: sessionId => enabled() && state.read().session?.sessionId === sessionId,
		isPersonalHost,
		sessionDirs: () => (state.read().setUp ? [env.defaultSessionsDir, paths.sessionsDir] : [env.defaultSessionsDir]),
		async deliverSchedule(schedule) {
			if (!enabled()) throw new Error("The Personal agent is not turned on on this computer");
			const draft: EventDraft = {
				source: `schedule:${schedule.id}`.slice(0, 64),
				kind: "schedule",
				title: schedule.title,
				body: schedule.prompt,
			};
			// What the owner scheduled is the owner's word; what the agent scheduled may carry outside text.
			if (schedule.createdBy === "agent") await events.enqueueExternal(draft);
			else await events.enqueueOwner(draft);
		},
		async attach() {
			if (enabled()) await publishEndpoints();
		},
		shutdown: () => sources.stop(),
		async idle() {
			while (background.size > 0) await Promise.all(background);
		},
		status,
		deps,
	};
}
