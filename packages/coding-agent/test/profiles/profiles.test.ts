import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { LspTool } from "../../src/lsp";
import { findProfile, loadProfileCatalog } from "../../src/profiles/catalog";
import {
	PROFILE_ENTRY_TYPE,
	readPersistedProfileName,
	SessionProfiles,
	type SessionProfilesHost,
} from "../../src/profiles/controller";
import { cfgProfiles } from "../../src/profiles/settings";
import type { ToolSession } from "../../src/tools";
import { resolveApprovalFromContext } from "../../src/tools/approval";
import { evaluatePathRule } from "../../src/tools/path-rules";
import {
	cfgToolsApproval,
	cfgToolsApprovalMode,
	cfgToolsOutsideProject,
	cfgToolsPathRules,
} from "../../src/tools/settings";

function fakeModel(id: string): Model {
	return { provider: "acme", id, name: id } as unknown as Model;
}

const FAST = fakeModel("fast");
const SMART = fakeModel("smart");

interface Harness {
	host: SessionProfilesHost;
	settings: Settings;
	state: {
		busy: boolean;
		blocker?: string;
		persisted?: string;
		model: Model;
		level?: ConfiguredThinkingLevel;
		filter?: (names: string[]) => string[];
		prompts: number;
	};
	profiles: SessionProfiles;
}

function harness(cwd: string, definitions: Record<string, unknown> = {}): Harness {
	const settings = Settings.isolated();
	cfgProfiles.override(settings, definitions);
	const state: Harness["state"] = { busy: false, model: SMART, prompts: 0 };
	const host: SessionProfilesHost = {
		settings,
		cwd: () => cwd,
		setToolFilter: async filter => {
			state.filter = filter;
			return true;
		},
		refreshPrompt: async () => {
			state.prompts++;
		},
		resolveModel: selector => (selector === "acme/fast" ? { model: FAST } : undefined),
		currentModel: () => state.model,
		currentThinkingLevel: () => state.level,
		setModel: async (model, level) => {
			state.model = model;
			state.level = level;
		},
		setThinkingLevel: level => {
			state.level = level;
		},
		isBusy: () => state.busy,
		switchBlocker: () => state.blocker,
		persistedName: () => state.persisted,
		persist: name => {
			state.persisted = name;
		},
		notify: () => {},
	};
	return { host, settings, state, profiles: new SessionProfiles(host) };
}

describe("agent profiles", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-profiles-"));
		setAgentDir(path.join(dir, "agent"));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	describe("catalog", () => {
		it("reads markdown profiles, but a project profile cannot replace a built-in", () => {
			const projectDir = path.join(dir, "project", ".omp", "profiles");
			fs.mkdirSync(projectDir, { recursive: true });
			fs.writeFileSync(
				path.join(projectDir, "docs.md"),
				"---\ndescription: Docs\ntools: [read, edit]\napprovalMode: write\nthinking: low\n---\nOnly touch docs.\n",
			);
			fs.writeFileSync(path.join(projectDir, "review.md"), "---\ntools: [bash]\n---\nsneaky\n");
			const catalog = loadProfileCatalog(Settings.isolated(), path.join(dir, "project"));
			const docs = findProfile(catalog, "DOCS");
			expect(docs).toMatchObject({ tools: ["read", "edit"], approvalMode: "write", thinkingLevel: "low" });
			expect(docs?.prompt).toContain("Only touch docs.");
			const review = findProfile(catalog, "review");
			expect(review?.tools).not.toContain("bash");
			expect(catalog.warnings.some(warning => warning.includes("built-in"))).toBe(true);
		});

		it("drops invalid fields with a warning instead of failing the profile", () => {
			const settings = Settings.isolated();
			cfgProfiles.override(settings, { odd: { approvalMode: "sometimes", tools: ["read"] } });
			const catalog = loadProfileCatalog(settings, dir);
			expect(findProfile(catalog, "odd")).toMatchObject({ tools: ["read"] });
			expect(findProfile(catalog, "odd")?.approvalMode).toBeUndefined();
			expect(catalog.warnings.length).toBeGreaterThan(0);
		});
	});

	describe("application", () => {
		it("filters tools, keeping yield, and clears the filter on switching back", async () => {
			const { profiles, state } = harness(dir);
			expect(await profiles.switch("review")).toMatchObject({ ok: true, status: "applied" });
			expect(state.filter?.(["read", "edit", "bash", "yield"])).toEqual(["read", "yield"]);
			expect(await profiles.switch("build")).toMatchObject({ ok: true, status: "applied" });
			expect(state.filter).toBeUndefined();
		});

		it("applies approval overrides and restores the session's own on switching back", async () => {
			const { profiles, settings } = harness(dir);
			cfgToolsApproval.override(settings, { bash: "prompt" });
			await profiles.switch("review");
			expect(resolveApprovalFromContext({ settings }).userPolicies).toMatchObject({ edit: "deny", bash: "deny" });
			await profiles.switch("build");
			expect(resolveApprovalFromContext({ settings }).userPolicies).toEqual({ bash: "prompt" });
		});

		it("never lets a profile lift a configured deny", async () => {
			const { profiles, settings } = harness(dir, {
				loose: {
					approval: { bash: "allow", edit: "allow", write: "prompt" },
					pathRules: [
						{ glob: "secrets/**", action: "allow" },
						{ glob: "docs/**", action: "prompt" },
					],
					outsideProject: "allow",
				},
			});
			cfgToolsApproval.override(settings, { bash: "deny", grep: "prompt" });
			cfgToolsPathRules.override(settings, [
				{ glob: "secrets/ok/**", action: "allow" },
				{ glob: "secrets/**", action: "deny" },
				{ glob: "tmp/**", action: "prompt" },
			]);
			cfgToolsOutsideProject.override(settings, "deny");
			await profiles.switch("loose");

			const policies = resolveApprovalFromContext({ settings }).userPolicies;
			expect(policies).toMatchObject({ bash: "deny", edit: "allow", write: "prompt", grep: "prompt" });
			const rules = cfgToolsPathRules.get(settings);
			const index = (glob: string, action: string) =>
				rules.findIndex(rule => rule.glob === glob && rule.action === action);
			// The profile's deny leads; the configured rules keep their order; its prompt and allow come after the last deny.
			expect(index("docs/**", "prompt")).toBe(2);
			expect(index("secrets/ok/**", "allow")).toBeLessThan(index("secrets/**", "deny"));
			expect(index("secrets/**", "allow")).toBe(-1);
			expect(cfgToolsOutsideProject.get(settings)).toBe("deny");

			await profiles.switch("build");
			expect(resolveApprovalFromContext({ settings }).userPolicies).toEqual({ bash: "deny", grep: "prompt" });
			expect(cfgToolsPathRules.get(settings)).toHaveLength(3);
		});

		it("allows a profile's path allow when no configured deny reaches it", async () => {
			const { profiles, settings } = harness(dir, { open: { pathRules: [{ glob: "gen/**", action: "allow" }] } });
			cfgToolsPathRules.override(settings, [{ glob: "gen/**", action: "prompt" }]);
			await profiles.switch("open");
			expect(cfgToolsPathRules.get(settings)[0]).toMatchObject({ glob: "gen/**", action: "allow" });
		});

		it("never lets a profile prompt rule shadow a configured deny", async () => {
			const { profiles, settings } = harness(dir, { nag: { pathRules: [{ glob: ".env*", action: "prompt" }] } });
			cfgToolsPathRules.override(settings, [{ glob: ".env*", action: "deny" }]);
			await profiles.switch("nag");
			expect(evaluatePathRule(settings, "read", path.join(dir, ".env"), dir).action).toBe("deny");
			await profiles.switch("build");
			expect(evaluatePathRule(settings, "read", path.join(dir, ".env"), dir).action).toBe("deny");
		});

		it("keeps a CLI approval mode against a looser profile and lets a stricter one tighten it", async () => {
			const { profiles, settings } = harness(dir, {
				open: { approvalMode: "yolo" },
				locked: { approvalMode: "always-ask" },
			});
			cfgToolsApprovalMode.override(settings, "write");
			await profiles.switch("open");
			expect(cfgToolsApprovalMode.get(settings)).toBe("write");
			await profiles.switch("locked");
			expect(cfgToolsApprovalMode.get(settings)).toBe("always-ask");
			await profiles.switch("build");
			expect(cfgToolsApprovalMode.get(settings)).toBe("write");
		});

		it("lets a user profile replace the configured mode but not a project profile", async () => {
			const project = path.join(dir, "project");
			fs.mkdirSync(path.join(project, ".omp", "profiles"), { recursive: true });
			fs.writeFileSync(path.join(project, ".omp", "profiles", "repo.md"), "---\napprovalMode: yolo\n---\nrepo\n");
			const { profiles, settings } = harness(project, { mine: { approvalMode: "yolo" } });
			cfgToolsApprovalMode.set(settings, "always-ask");
			await profiles.switch("mine");
			expect(cfgToolsApprovalMode.get(settings)).toBe("yolo");
			await profiles.switch("repo");
			expect(cfgToolsApprovalMode.get(settings)).toBe("always-ask");
		});

		it("keeps the lsp tool to read actions under the review profile", async () => {
			const { profiles } = harness(dir);
			const session = {
				cwd: dir,
				settings: Settings.isolated(),
				get lspReadOnly() {
					return profiles.active.lspReadOnly === true;
				},
			} as unknown as ToolSession;
			const tool = new LspTool(session);
			await profiles.switch("review");
			const rename = { action: "rename", file: "a.ts", line: 1, symbol: "a", new_name: "b", apply: true } as const;
			await expect(tool.execute("rename", rename)).rejects.toThrow("read-only");
			await expect(
				tool.execute("rename_file", { action: "rename_file", file: "a.ts", new_name: "b.ts" }),
			).rejects.toThrow("read-only");
			await expect(
				tool.execute("code_actions", { action: "code_actions", file: "a.ts", apply: true }),
			).rejects.toThrow("read-only");
		});

		it("describes a switch that loosens the active profile", async () => {
			const { profiles } = harness(dir, {
				wide: { approvalMode: "yolo" },
				tools: { tools: ["read", "bash"] },
				ask: { approvalMode: "always-ask" },
			});
			await profiles.switch("review");
			expect(profiles.looseningOf("build")).toContain("tool");
			expect(profiles.looseningOf("tools")).toContain("bash");
			expect(profiles.looseningOf("review")).toBeUndefined();
			await profiles.switch("ask");
			expect(profiles.looseningOf("wide")).toContain("looser");
			expect(profiles.looseningOf("build")).toContain("looser");
			await profiles.switch("build");
			expect(profiles.looseningOf("ask")).toBeUndefined();
			expect(profiles.looseningOf("review")).toBeUndefined();
		});

		it("moves to the profile's model and restores the original on switching back", async () => {
			const { profiles, state } = harness(dir, { quick: { model: "acme/fast", thinking: "low" } });
			const original = "high" as ConfiguredThinkingLevel;
			state.level = original;
			await profiles.switch("quick");
			expect(state.model).toBe(FAST);
			expect(state.level).toBe("low" as ConfiguredThinkingLevel);
			await profiles.switch("build");
			expect(state.model).toBe(SMART);
			expect(state.level).toBe(original);
		});

		it("contributes the profile's prompt section and rebuilds the prompt", async () => {
			const { profiles, state } = harness(dir, { note: { prompt: "Mind the docs." } });
			await profiles.switch("note");
			expect(profiles.promptSection).toContain("Mind the docs.");
			expect(state.prompts).toBe(1);
		});
	});

	describe("switching", () => {
		it("persists the choice and restores it from the branch", async () => {
			const first = harness(dir);
			await first.profiles.switch("review");
			expect(first.state.persisted).toBe("review");

			const resumed = harness(dir);
			resumed.state.persisted = first.state.persisted;
			resumed.profiles.syncFromBranch();
			await resumed.profiles.idle();
			expect(resumed.profiles.active.name).toBe("review");
			expect(resumed.state.filter?.(["read", "edit"])).toEqual(["read"]);

			resumed.state.persisted = undefined;
			resumed.profiles.syncFromBranch();
			await resumed.profiles.idle();
			expect(resumed.profiles.active.name).toBe("build");
			expect(resumed.state.filter).toBeUndefined();
		});

		it("reads the latest profile entry on a branch", () => {
			const entry = (name: unknown) => ({ type: "custom", customType: PROFILE_ENTRY_TYPE, data: { name } });
			const entries = [entry("review"), { type: "message" }, entry("build"), { type: "custom", customType: "x" }];
			expect(readPersistedProfileName(entries as never)).toBe("build");
			expect(readPersistedProfileName([{ type: "message" }] as never)).toBeUndefined();
		});

		it("queues a mid-turn switch until the turn ends", async () => {
			const { profiles, state } = harness(dir);
			state.busy = true;
			expect(await profiles.switch("review")).toMatchObject({ ok: true, status: "queued" });
			expect(profiles.active.name).toBe("build");
			expect(state.filter).toBeUndefined();
			state.busy = false;
			await profiles.applyPending();
			expect(profiles.active.name).toBe("review");
			expect(state.persisted).toBe("review");
		});

		it("refuses unknown names and plan/goal/vibe mode", async () => {
			const { profiles, state } = harness(dir);
			expect(await profiles.switch("nope")).toMatchObject({ ok: false });
			state.blocker = "exit plan mode first";
			expect(await profiles.switch("review")).toMatchObject({ ok: false, reason: "exit plan mode first" });
			expect(profiles.active.name).toBe("build");
		});

		it("cycles through the catalog", async () => {
			const { profiles } = harness(dir);
			const first = profiles.nextName();
			await profiles.switch(first);
			expect(profiles.nextName()).not.toBe(first);
		});
	});
});
