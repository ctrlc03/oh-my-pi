import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	evaluatePathRule,
	type PathRule,
	parsePathRules,
	pathArgCandidates,
	searchRootCandidates,
} from "@oh-my-pi/pi-coding-agent/tools/path-rules";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

let root: string;
let project: string;
let outside: string;

function settingsWith(rules: PathRule[], outsideProject: "allow" | "prompt" | "deny" = "allow"): Settings {
	return Settings.isolated({ "tools.pathRules": rules, "tools.outsideProject": outsideProject });
}

function evaluate(settings: Settings, tool: string, target: string) {
	return evaluatePathRule(settings, tool, target, project);
}

beforeAll(() => {
	// realpath: macOS reaches os.tmpdir() through a /var -> /private/var link.
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-path-rules-")));
	project = path.join(root, "project");
	outside = path.join(root, "outside");
	fs.mkdirSync(path.join(project, "src"), { recursive: true });
	fs.mkdirSync(path.join(project, "secrets"), { recursive: true });
	fs.mkdirSync(outside, { recursive: true });
	fs.writeFileSync(path.join(project, ".env"), "TOKEN=hunter2-needle\n");
	fs.writeFileSync(path.join(project, ".env.example"), "TOKEN=example-needle\n");
	fs.writeFileSync(path.join(project, "src", "app.ts"), "export const visible = 'public-needle';\n");
	fs.writeFileSync(path.join(project, "src", ".env.local"), "TOKEN=nested-needle\n");
	fs.writeFileSync(path.join(project, "secrets", "key.txt"), "private-needle\n");
	fs.writeFileSync(path.join(outside, "note.txt"), "outside-needle\n");
	fs.symlinkSync(outside, path.join(project, "link-out"));
	fs.symlinkSync(path.join(project, ".env"), path.join(project, "innocent.txt"));
	fs.mkdirSync(path.join(project, "vault"), { recursive: true });
	fs.writeFileSync(path.join(project, "vault", "data.json"), '{"secret":"json-needle"}\n');
	fs.writeFileSync(
		path.join(project, "vault", "arch.zip"),
		new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
	);
	const db = new Database(path.join(project, "vault", "store.sqlite"));
	db.run("CREATE TABLE t (name TEXT)");
	db.run("INSERT INTO t VALUES ('sqlite-needle')");
	db.close();
});

afterAll(() => {
	removeSyncWithRetries(root);
});

describe("tools.pathRules glob matching", () => {
	const denyEnv = settingsWith([{ glob: "**/.env*", action: "deny" }]);

	it("matches relative, nested, and absolute spellings", () => {
		for (const target of [".env", "./.env", "src/.env.local", "src/../.env", path.join(project, ".env")]) {
			expect(evaluate(denyEnv, "read", target).action).toBe("deny");
		}
		expect(evaluate(denyEnv, "read", "src/app.ts").action).toBe("allow");
	});

	it("treats a glob without a slash as a basename match at any depth", () => {
		const settings = settingsWith([{ glob: ".env*", action: "deny" }]);
		expect(evaluate(settings, "read", "src/.env.local").action).toBe("deny");
		expect(evaluate(settings, "read", "src/app.ts").action).toBe("allow");
	});

	it("covers everything beneath a matched directory", () => {
		const settings = settingsWith([{ glob: "secrets", action: "deny" }]);
		expect(evaluate(settings, "read", "secrets/key.txt").action).toBe("deny");
		expect(evaluate(settings, "read", "secrets").action).toBe("deny");
		expect(evaluate(settings, "read", "src/app.ts").action).toBe("allow");
	});

	it("matches project-relative globs and absolute globs", () => {
		const relative = settingsWith([{ glob: "src/**", action: "deny" }]);
		expect(evaluate(relative, "read", "src/app.ts").action).toBe("deny");
		expect(evaluate(relative, "read", "secrets/key.txt").action).toBe("allow");
		const absolute = settingsWith([{ glob: `${outside}/**`, action: "prompt" }]);
		expect(evaluate(absolute, "read", path.join(outside, "note.txt")).action).toBe("prompt");
	});

	it("scopes a rule to the tools it names, defaulting to every file tool", () => {
		const settings = settingsWith([
			{ glob: "secrets/**", action: "deny", tools: ["write", "search"] },
			{ glob: "src/**", action: "prompt" },
		]);
		expect(evaluate(settings, "write", "secrets/key.txt").action).toBe("deny");
		// `search` is the legacy spelling of grep.
		expect(evaluate(settings, "grep", "secrets/key.txt").action).toBe("deny");
		expect(evaluate(settings, "read", "secrets/key.txt").action).toBe("allow");
		for (const tool of ["read", "edit", "write", "ast_edit", "ast_grep", "grep", "glob", "find"]) {
			expect(evaluate(settings, tool, "src/app.ts").action).toBe("prompt");
		}
		expect(evaluate(settings, "bash", "src/app.ts").action).toBe("allow");
	});

	it("drops malformed rules instead of throwing", () => {
		const parsed = parsePathRules([
			{ glob: "a", action: "deny" },
			{ glob: "", action: "deny" },
			{ glob: "b", action: "nope" },
			{ glob: "c", action: "allow", tools: "read" },
			{ glob: "d", action: "allow", tools: [1] },
			"string",
			null,
		]);
		expect(parsed.map(rule => rule.glob)).toEqual(["a", "c"]);
		expect(parsed[1]?.tools).toEqual(["read"]);
	});
});

describe("tools.pathRules ordering", () => {
	it("first match wins: an exception placed before the broad rule carves out of it", () => {
		const settings = settingsWith([
			{ glob: "**/.env.example", action: "allow" },
			{ glob: "**/.env*", action: "deny" },
		]);
		expect(evaluate(settings, "read", ".env.example").action).toBe("allow");
		expect(evaluate(settings, "read", ".env").action).toBe("deny");
	});

	it("the same rules in the opposite order let the broad rule win", () => {
		const settings = settingsWith([
			{ glob: "**/.env*", action: "deny" },
			{ glob: "**/.env.example", action: "allow" },
		]);
		expect(evaluate(settings, "read", ".env.example").action).toBe("deny");
	});

	it("names the deciding rule in a readable reason", () => {
		const decision = evaluate(settingsWith([{ glob: "**/.env*", action: "deny" }]), "read", ".env");
		expect(decision.rule?.glob).toBe("**/.env*");
		expect(decision.reason).toContain(".env");
	});

	it("defaults leave every path allowed", () => {
		expect(evaluate(Settings.isolated(), "read", ".env").action).toBe("allow");
		expect(evaluate(Settings.isolated(), "read", path.join(outside, "note.txt")).action).toBe("allow");
	});
});

describe("symlinks", () => {
	it("a link inside the project cannot reach a denied file", () => {
		const settings = settingsWith([{ glob: "**/.env*", action: "deny" }]);
		expect(evaluate(settings, "read", "innocent.txt").action).toBe("deny");
	});

	it("an allow on the link spelling does not outrank a deny on its target", () => {
		const settings = settingsWith([
			{ glob: "innocent.txt", action: "allow" },
			{ glob: "**/.env*", action: "deny" },
		]);
		expect(evaluate(settings, "read", "innocent.txt").action).toBe("deny");
	});

	it("a link out of the project is outside the project", () => {
		const settings = settingsWith([], "deny");
		expect(evaluate(settings, "read", "link-out/note.txt")).toMatchObject({ action: "deny", outsideProject: true });
		expect(evaluate(settings, "read", "src/app.ts").action).toBe("allow");
	});

	it("a missing file under a link is still resolved through the link", () => {
		const settings = settingsWith([], "deny");
		expect(evaluate(settings, "write", "link-out/new-file.txt").action).toBe("deny");
	});
});

describe("tools.outsideProject", () => {
	it("applies the configured action to paths beyond the cwd", () => {
		const target = path.join(outside, "note.txt");
		expect(evaluate(settingsWith([], "allow"), "read", target).action).toBe("allow");
		expect(evaluate(settingsWith([], "prompt"), "read", target)).toMatchObject({
			action: "prompt",
			outsideProject: true,
		});
		expect(evaluate(settingsWith([], "deny"), "read", target).action).toBe("deny");
		expect(evaluate(settingsWith([], "deny"), "read", "../outside/note.txt").action).toBe("deny");
	});

	it("leaves non-file tools alone", () => {
		expect(evaluate(settingsWith([], "deny"), "bash", path.join(outside, "note.txt")).action).toBe("allow");
	});

	it("an allow rule exempts a path; a deny rule still wins over the exemption order", () => {
		const settings = settingsWith(
			[
				{ glob: `${outside}/**`, action: "allow", tools: ["read"] },
				{ glob: "**/*", action: "deny", tools: ["write"] },
			],
			"deny",
		);
		expect(evaluate(settings, "read", path.join(outside, "note.txt")).action).toBe("allow");
		expect(evaluate(settings, "grep", path.join(outside, "note.txt")).action).toBe("deny");
		expect(evaluate(settings, "write", path.join(outside, "note.txt")).action).toBe("deny");
	});

	it("counts the repo root and additional roots as inside the project", () => {
		fs.mkdirSync(path.join(root, "repo", ".git"), { recursive: true });
		fs.mkdirSync(path.join(root, "repo", "pkg", "a"), { recursive: true });
		const cwd = path.join(root, "repo", "pkg", "a");
		const settings = settingsWith([], "deny");
		expect(evaluatePathRule(settings, "read", "../../README.md", cwd).action).toBe("allow");
		expect(evaluatePathRule(settings, "read", path.join(outside, "note.txt"), cwd).action).toBe("deny");
		expect(
			evaluatePathRule(settings, "read", path.join(outside, "note.txt"), cwd, { additionalRoots: [outside] }).action,
		).toBe("allow");
	});
});

describe("argument extraction", () => {
	it("keeps the bare path when selectors, wrappers, and lists decorate it", () => {
		expect(pathArgCandidates("src/app.ts:10-20")).toContain("src/app.ts");
		expect(pathArgCandidates("[.env#AB12]")).toContain(".env");
		expect(pathArgCandidates("a.ts;.env")).toEqual(expect.arrayContaining(["a.ts", ".env"]));
		expect(pathArgCandidates(".env?what is this")).toContain(".env");
		expect(pathArgCandidates("data.zip:inner/x.txt")).toContain("data.zip");
		expect(pathArgCandidates("artifact://3")).toEqual([]);
		expect(pathArgCandidates("https://example.com/.env")).toEqual([]);
	});

	it("normalizes the spellings the executors accept: @, leading colon, any-case file://, ~", () => {
		expect(pathArgCandidates("@/etc/hosts")).toContain("/etc/hosts");
		expect(pathArgCandidates(":/etc/hosts")).toContain("/etc/hosts");
		expect(pathArgCandidates(":/etc/hosts:1-2")).toContain("/etc/hosts");
		expect(pathArgCandidates("FILE:///etc/hosts")).toContain("/etc/hosts");
		expect(pathArgCandidates("@~/.ssh/config")).toContain(path.join(os.homedir(), ".ssh", "config"));
	});

	it("evaluates every spelling of a denied absolute path as denied", () => {
		const denyEnv = settingsWith([{ glob: "**/.env*", action: "deny" }]);
		const abs = path.join(project, ".env");
		for (const spelled of [`@${abs}`, `:${abs}`, `FILE://${abs}`, `file://${abs}`]) {
			expect({ spelled, action: evaluate(denyEnv, "write", spelled).action }).toEqual({ spelled, action: "deny" });
		}
		const outsideOnly = settingsWith([], "deny");
		expect(evaluate(outsideOnly, "write", `@${path.join(outside, "note.txt")}`).outsideProject).toBe(true);
	});

	it("reduces search entries to their non-glob base directory", () => {
		expect(searchRootCandidates("src/**/*.ts")).toEqual(["src"]);
		expect(searchRootCandidates("*.ts")).toEqual(["."]);
		expect(searchRootCandidates(undefined)).toEqual(["."]);
		expect(searchRootCandidates(["a/", "/etc/*.conf"])).toEqual(expect.arrayContaining(["a/", "/etc"]));
	});
});

describe("tool integration", () => {
	function session(settings: Settings): ToolSession {
		return {
			cwd: project,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings,
		};
	}

	async function toolsFor(settings: Settings): Promise<Map<string, AgentTool>> {
		const tools = await createTools(session(settings), [
			"read",
			"edit",
			"write",
			"grep",
			"glob",
			"ast_grep",
			"ast_edit",
		]);
		return new Map(tools.map(tool => [tool.name, tool as AgentTool]));
	}

	const text = (result: { content: Array<{ type: string; text?: string }> }): string =>
		result.content.map(block => (block.type === "text" ? (block.text ?? "") : "")).join("\n");

	const denyEnv = (): Settings =>
		Settings.isolated({ "tools.pathRules": [{ glob: "**/.env*", action: "deny" }], "edit.mode": "replace" });

	it("read, edit, and write refuse a denied path through the approval flow", async () => {
		const tools = await toolsFor(denyEnv());
		const calls: Array<[string, unknown]> = [
			["read", { path: ".env" }],
			["read", { path: ".env:1-1" }],
			["read", { path: "innocent.txt" }],
			["write", { path: ".env", content: "x" }],
			["edit", { path: ".env", old_string: "a", new_string: "b" }],
		];
		for (const [name, args] of calls) {
			const tool = tools.get(name);
			if (!tool) throw new Error(`Missing ${name} tool`);
			const resolved = resolveApproval(tool, args, "yolo", {});
			expect({ name, args, policy: resolved.policy }).toEqual({ name, args, policy: "deny" });
		}
		const read = tools.get("read");
		if (!read) throw new Error("Missing read tool");
		expect(resolveApproval(read, { path: "src/app.ts" }, "yolo", {}).policy).toBe("allow");
	});

	it("a deny reads as a refusal the model can act on", async () => {
		const tools = await toolsFor(denyEnv());
		const read = tools.get("read");
		if (!read) throw new Error("Missing read tool");
		const resolved = resolveApproval(read, { path: ".env" }, "yolo", {});
		expect(resolved.reason).toContain("tools.pathRules");
	});

	it("a prompt rule asks in every approval mode, even yolo", async () => {
		const tools = await toolsFor(settingsWith([{ glob: "secrets/**", action: "prompt" }]));
		const read = tools.get("read");
		if (!read) throw new Error("Missing read tool");
		expect(resolveApproval(read, { path: "secrets/key.txt" }, "yolo", {}).policy).toBe("prompt");
		expect(resolveApproval(read, { path: "src/app.ts" }, "yolo", {}).policy).toBe("allow");
	});

	it("read re-checks the resolved path at execute time", async () => {
		const tools = await toolsFor(denyEnv());
		const read = tools.get("read");
		if (!read) throw new Error("Missing read tool");
		await expect(read.execute("t", { path: ".env" })).rejects.toThrow(/tools\.pathRules/);
		const ok = await read.execute("t", { path: "src/app.ts" });
		expect(text(ok)).toContain("public-needle");
	});

	it("write and edit re-check the resolved path at execute time", async () => {
		const tools = await toolsFor(denyEnv());
		const write = tools.get("write");
		const edit = tools.get("edit");
		if (!write || !edit) throw new Error("Missing write/edit tool");
		const envFile = path.join(project, ".env");
		for (const spelled of [".env", `@${envFile}`, `:${envFile}`]) {
			await expect(write.execute("t", { path: spelled, content: "overwritten" })).rejects.toThrow(
				/tools\.pathRules/,
			);
		}
		const edited = await edit.execute("t", { path: ".env", old_string: "hunter2", new_string: "replaced" }).then(
			result => text(result),
			error => String(error),
		);
		expect(edited).toMatch(/tools\.pathRules/);
		expect(fs.readFileSync(envFile, "utf8")).toBe("TOKEN=hunter2-needle\n");
	});

	it("refuses every path spelling the executors accept through the approval flow", async () => {
		const tools = await toolsFor(denyEnv());
		const envFile = path.join(project, ".env");
		for (const spelled of [`@${envFile}`, `:${envFile}`, `FILE://${envFile}`, `file://${envFile}`]) {
			const calls: Array<[string, unknown]> = [
				["read", { path: spelled }],
				["write", { path: spelled, content: "x" }],
				["edit", { path: spelled, old_string: "a", new_string: "b" }],
			];
			for (const [name, args] of calls) {
				const tool = tools.get(name);
				if (!tool) throw new Error(`Missing ${name} tool`);
				const resolved = resolveApproval(tool, args, "yolo", {});
				expect({ name, spelled, policy: resolved.policy }).toEqual({ name, spelled, policy: "deny" });
			}
		}
	});

	it("read denies json, sqlite, and archive targets that suffix recovery resolves into a denied path", async () => {
		const settings = Settings.isolated({ "tools.pathRules": [{ glob: "vault/**", action: "deny" }] });
		const tools = await toolsFor(settings);
		const read = tools.get("read");
		if (!read) throw new Error("Missing read tool");
		for (const target of ["data.json?q=.", "store.sqlite", "arch.zip"]) {
			await expect(read.execute("t", { path: target })).rejects.toThrow(/tools\.pathRules/);
		}
		const allowed = Settings.isolated({ "tools.pathRules": [{ glob: "other/**", action: "deny" }] });
		const open = (await toolsFor(allowed)).get("read");
		if (!open) throw new Error("Missing read tool");
		expect(text(await open.execute("t", { path: "data.json?q=." }))).toContain("json-needle");
	});

	it("grep filters denied files out of the results and says so", async () => {
		const tools = await toolsFor(denyEnv());
		const grep = tools.get("grep");
		if (!grep) throw new Error("Missing grep tool");
		const result = text(await grep.execute("g", { pattern: "needle", path: "." }));
		expect(result).toContain("public-needle");
		expect(result).toContain("private-needle");
		expect(result).not.toContain("hunter2-needle");
		expect(result).not.toContain("nested-needle");
		expect(result).toContain("tools.pathRules");
	});

	it("grep does not fail the whole call when the explicit target is denied", async () => {
		const tools = await toolsFor(denyEnv());
		const grep = tools.get("grep");
		if (!grep) throw new Error("Missing grep tool");
		const result = text(await grep.execute("g", { pattern: "needle", path: ".env" }));
		expect(result).not.toContain("hunter2-needle");
		expect(result).toContain("No matches found");
	});

	it("grep without rules returns everything", async () => {
		const tools = await toolsFor(Settings.isolated());
		const grep = tools.get("grep");
		if (!grep) throw new Error("Missing grep tool");
		const result = text(await grep.execute("g", { pattern: "needle", path: "." }));
		expect(result).toContain("hunter2-needle");
		expect(result).not.toContain("tools.pathRules");
	});

	it("grep hides prompt-gated paths unless the root itself was approved", async () => {
		const tools = await toolsFor(settingsWith([{ glob: "secrets/**", action: "prompt" }]));
		const grep = tools.get("grep");
		if (!grep) throw new Error("Missing grep tool");
		const broad = text(await grep.execute("g", { pattern: "needle", path: "." }));
		expect(broad).not.toContain("private-needle");
		const approvedRoot = text(await grep.execute("g", { pattern: "needle", path: "secrets" }));
		expect(approvedRoot).toContain("private-needle");
		expect(resolveApproval(grep, { pattern: "needle", path: "secrets" }, "yolo", {}).policy).toBe("prompt");
		expect(resolveApproval(grep, { pattern: "needle", path: "." }, "yolo", {}).policy).toBe("allow");
	});

	it("glob drops denied files and keeps the rest", async () => {
		const tools = await toolsFor(denyEnv());
		const glob = tools.get("glob");
		if (!glob) throw new Error("Missing glob tool");
		const result = text(await glob.execute("g", { path: "**/*" }));
		expect(result).toContain("app.ts");
		expect(result).not.toMatch(/\.env(\.local)?\b/);
		expect(result).toContain("tools.pathRules");
	});

	it("ast_edit refuses a rewrite that would reach a protected file", async () => {
		fs.writeFileSync(path.join(project, "src", ".env.ts"), "const token = 1;\n");
		try {
			const tools = await toolsFor(denyEnv());
			const astEdit = tools.get("ast_edit");
			if (!astEdit) throw new Error("Missing ast_edit tool");
			await expect(
				astEdit.execute("a", { ops: [{ pat: "const token = 1", out: "const token = 2" }], paths: ["src"] }),
			).rejects.toThrow(/tools\.pathRules/);
			expect(fs.readFileSync(path.join(project, "src", ".env.ts"), "utf8")).toBe("const token = 1;\n");
		} finally {
			fs.rmSync(path.join(project, "src", ".env.ts"), { force: true });
		}
	});

	it("outsideProject=deny refuses writes outside and filters searches outside", async () => {
		const tools = await toolsFor(settingsWith([], "deny"));
		const write = tools.get("write");
		const grep = tools.get("grep");
		if (!write || !grep) throw new Error("Missing tools");
		expect(resolveApproval(write, { path: path.join(outside, "x.txt"), content: "x" }, "yolo", {}).policy).toBe(
			"deny",
		);
		expect(resolveApproval(write, { path: "src/x.txt", content: "x" }, "yolo", {}).policy).toBe("allow");
		const result = text(await grep.execute("g", { pattern: "outside-needle", path: outside }));
		expect(result).not.toContain("outside-needle\n");
		expect(result).toContain("No matches found");
	});
});
