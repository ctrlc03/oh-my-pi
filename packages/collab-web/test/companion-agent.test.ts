import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AgentLaunch,
	type AgentRunner,
	type AgentWatch,
	type AgentWatchOptions,
	agentFailureReason,
	agentFolderName,
	checkRunRequest,
	GATED_TOOL_SETTINGS,
	parseAgentJson,
	READONLY_AGENT_TOOLS,
	restrictedOverlayYaml,
	runAgentToFile,
	waitForAgent,
} from "../scripts/companion-agent";

// ── the read-only launch ─────────────────────────────────────────────────────

describe("the read-only agent's launch", () => {
	it("lets the session write its one file, matching wildcard characters in the path literally", () => {
		const yaml = restrictedOverlayYaml("/home/me/my [cfg]/cache/out/bp-0123456789ab.json", READONLY_AGENT_TOOLS);
		expect(yaml).toContain('glob: "/home/me/my [[]cfg[]]/cache/out/bp-0123456789ab.json"');
		expect(yaml).toContain("bash: deny");
		expect(yaml.indexOf("action: allow")).toBeLessThan(yaml.indexOf("action: deny\n"));
		expect(() => restrictedOverlayYaml("C:\\cfg\\out\\bp-0123456789ab.json", READONLY_AGENT_TOOLS)).toThrow(
			/backslash/,
		);
	});

	it("turns on every tool omp keeps off by default that the allowlist names, or omp refuses to start with it in --tools", () => {
		// `--tools ast_grep,trace,flow` without `astGrep.enabled` / `codemap.enabled` ends in "Built-in tools unavailable in this session".
		const settings = Bun.YAML.parse(restrictedOverlayYaml("/out/x.json", READONLY_AGENT_TOOLS)) as Record<
			string,
			{ enabled?: boolean } | undefined
		>;
		expect(READONLY_AGENT_TOOLS).toEqual(expect.arrayContaining(["ast_grep", "trace", "flow"]));
		for (const tool of READONLY_AGENT_TOOLS) {
			if (Object.hasOwn(GATED_TOOL_SETTINGS, tool)) expect(settings[GATED_TOOL_SETTINGS[tool]!]?.enabled).toBe(true);
		}
		expect(settings.astGrep?.enabled).toBe(true);
		expect(settings.codemap?.enabled).toBe(true);
	});

	it("turns on only what the tools it lists need", () => {
		const settings = Bun.YAML.parse(restrictedOverlayYaml("/out/x.json", ["read", "grep", "write"])) as Record<
			string,
			unknown
		>;
		expect(settings.astGrep).toBeUndefined();
		expect(settings.codemap).toBeUndefined();
		const grepOnly = Bun.YAML.parse(restrictedOverlayYaml("/out/x.json", ["read", "ast_grep", "write"])) as Record<
			string,
			{ enabled?: boolean } | undefined
		>;
		expect(grepOnly.astGrep?.enabled).toBe(true);
		expect(grepOnly.codemap).toBeUndefined();
	});

	it("names the checkout folder after the run, without characters a sandbox profile refuses", () => {
		expect(agentFolderName("Architecture", "repo", "feat/x")).toBe("Architecture · repo @ feat-x");
		expect(agentFolderName("Quiz", 're"po', "a\\b\nc")).toBe("Quiz · re-po @ a-b-c");
	});
});

describe("a run request", () => {
	it("accepts a folder, refs, a limit and a model, and fills the default limit", () => {
		expect(checkRunRequest({ cwd: "/tmp/x", ref: "main", base: "@default", model: "p/m" }, 2)).toEqual({
			cwd: "/tmp/x",
			ref: "main",
			base: "@default",
			maxCostUsd: 2,
			model: "p/m",
		});
		expect(checkRunRequest({ cwd: "/tmp/x", maxCostUsd: 0.5 }, 2).maxCostUsd).toBe(0.5);
	});

	it("refuses what a device must not send", () => {
		expect(() => checkRunRequest({ cwd: "relative" }, 1)).toThrow("invalid folder");
		expect(() => checkRunRequest({ cwd: "/x\0y" }, 1)).toThrow("invalid folder");
		expect(() => checkRunRequest({ cwd: "/x", ref: "--upload-pack=x" }, 1)).toThrow("invalid ref");
		expect(() => checkRunRequest({ cwd: "/x", base: "a b" }, 1)).toThrow("invalid base");
		for (const maxCostUsd of [0, -1, 101, Number.NaN, "1"])
			expect(() => checkRunRequest({ cwd: "/x", maxCostUsd }, 1)).toThrow("invalid spending limit");
		expect(() => checkRunRequest({ cwd: "/x", model: "a b;c" }, 1)).toThrow("invalid model");
	});
});

// ── waiting for the agent ────────────────────────────────────────────────────

const WATCH: AgentWatchOptions = { pollMs: 1_000, settleMs: 3_000, idleMs: 20_000, goneMs: 5_000, timeoutMs: 100_000 };

function fakeWatch(
	script: (t: number) => { host: { busy: boolean | null } | null; output: string | null },
	cancelAt = Infinity,
) {
	let t = 0;
	const watch: AgentWatch = {
		host: async () => script(t).host,
		output: async () => {
			const text = script(t).output;
			return text === null ? null : { text, signature: text };
		},
		now: () => t,
		sleep: async ms => {
			t += ms;
		},
		cancelled: () => t >= cancelAt,
	};
	return watch;
}

describe("waitForAgent", () => {
	it("takes the file once it stops changing and the session is idle, not while the agent is still working", async () => {
		const watch = fakeWatch(t => ({
			host: { busy: t < 10_000 },
			output: t < 2_000 ? null : t < 6_000 ? "draft" : "final",
		}));
		expect(await waitForAgent(watch, WATCH)).toEqual({ kind: "done", text: "final" });
	});

	it("takes the file when the session exited right after writing it", async () => {
		const watch = fakeWatch(t => ({ host: t < 3_000 ? { busy: true } : null, output: t >= 2_000 ? "out" : null }));
		expect(await waitForAgent(watch, WATCH)).toEqual({ kind: "done", text: "out" });
	});

	it("reports a session that vanished or sat idle without a file, and a timeout", async () => {
		expect(
			await waitForAgent(
				fakeWatch(t => ({ host: t < 2_000 ? { busy: true } : null, output: null })),
				WATCH,
			),
		).toEqual({ kind: "ended" });
		expect(
			await waitForAgent(
				fakeWatch(t => ({ host: { busy: t < 2_000 }, output: null })),
				WATCH,
			),
		).toEqual({ kind: "stalled" });
		expect(
			await waitForAgent(
				fakeWatch(() => ({ host: { busy: true }, output: null })),
				WATCH,
			),
		).toEqual({ kind: "timeout" });
		expect(
			await waitForAgent(
				fakeWatch(() => ({ host: { busy: true }, output: null }), 4_000),
				WATCH,
			),
		).toEqual({ kind: "cancelled" });
	});

	it("words why a run ended without a file", () => {
		expect(agentFailureReason({ kind: "ended" }, 0.99, 1, "the questions")).toContain("spending limit");
		expect(agentFailureReason({ kind: "ended" }, 0.1, 1, "the questions")).toContain(
			"ended before it wrote the questions",
		);
		expect(agentFailureReason({ kind: "stalled" }, undefined, 1, "the questions")).toContain(
			"without writing the questions",
		);
		expect(agentFailureReason({ kind: "timeout" }, undefined, 1, "x")).toBe("it ran out of time");
	});
});

describe("agent output text", () => {
	it("reads JSON with or without a markdown fence", () => {
		expect(parseAgentJson('{"a":1}')).toEqual({ a: 1 });
		expect(parseAgentJson('```json\n{"a":1}\n```\n')).toEqual({ a: 1 });
		expect(() => parseAgentJson("not json")).toThrow(SyntaxError);
	});
});

// ── a whole run, with the session faked ──────────────────────────────────────

describe("runAgentToFile", () => {
	let dir: string;
	beforeAll(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agent-run-"));
	});
	afterAll(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	function launch(name: string): AgentLaunch {
		return {
			cwd: dir,
			prompt: "p",
			maxCostUsd: 1,
			outFile: path.join(dir, `${name}.json`),
			overlayPath: path.join(dir, `${name}.yml`),
			overlayYaml: "x: 1\n",
			tools: ["read", "write"],
		};
	}
	const fast: Partial<AgentWatchOptions> = { pollMs: 5, settleMs: 20, idleMs: 200, goneMs: 40, timeoutMs: 5_000 };

	it("returns the file the session wrote with its model and cost, stops the session and removes its files", async () => {
		const spec = launch("ok");
		const stopped: string[] = [];
		await fs.writeFile(spec.overlayPath, "overlay");
		const agent: AgentRunner = {
			start: async l => {
				await fs.writeFile(l.outFile, '{"done":true}');
				return "inst-1";
			},
			hosts: async () => [{ instanceId: "inst-1", sessionId: "s-1", model: "stub/model", busy: false }],
			stop: async id => {
				stopped.push(id);
			},
			cost: async id => (id === "s-1" ? 0.0123 : undefined),
		};
		const started: string[] = [];
		const result = await runAgentToFile({
			agent,
			launch: spec,
			watch: fast,
			now: Date.now,
			cancelled: () => false,
			started: async id => {
				started.push(id);
			},
		});
		expect(result).toEqual({
			outcome: { kind: "done", text: '{"done":true}' },
			model: "stub/model",
			costUsd: 0.0123,
		});
		expect(started).toEqual(["inst-1"]);
		expect(stopped).toEqual(["inst-1"]);
		expect(await Bun.file(spec.outFile).exists()).toBe(false);
		expect(await Bun.file(spec.overlayPath).exists()).toBe(false);
	});

	it("reports a session that ended without a file, and still stops it", async () => {
		const stopped: string[] = [];
		const agent: AgentRunner = {
			start: async () => "inst-2",
			hosts: async () => [],
			stop: async id => {
				stopped.push(id);
			},
			cost: async () => undefined,
		};
		const result = await runAgentToFile({
			agent,
			launch: launch("none"),
			watch: fast,
			now: Date.now,
			cancelled: () => false,
		});
		expect(result.outcome).toEqual({ kind: "ended" });
		expect(stopped).toEqual(["inst-2"]);
	});

	it("lets a session that fails to start throw", async () => {
		const agent: AgentRunner = {
			start: async () => {
				throw new Error("tmux is missing");
			},
			hosts: async () => [],
			stop: async () => undefined,
			cost: async () => undefined,
		};
		await expect(
			runAgentToFile({ agent, launch: launch("bad"), watch: fast, now: Date.now, cancelled: () => false }),
		).rejects.toThrow("tmux is missing");
	});
});
