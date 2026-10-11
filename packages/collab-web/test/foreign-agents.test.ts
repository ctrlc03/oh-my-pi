import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	ADAPTER_PINS,
	type AgentInfo,
	adapterVersion,
	deleteCustomAgent,
	installAgent,
	type LaunchOpts,
	type LaunchSpec,
	launchSpec,
	listAgents,
	saveCustomAgent,
	vendorModes,
} from "../scripts/foreign/agents";

const SECRETS: Record<string, string> = {
	OPENAI_API_KEY: "sk-openai-parent",
	ANTHROPIC_API_KEY: "sk-ant-parent",
	ANTHROPIC_TOKEN: "ant-token-parent",
	XAI_API_KEY: "xai-parent",
	OPENROUTER_API_KEY: "or-parent",
	GH_TOKEN: "gh-parent",
	AWS_SECRET_ACCESS_KEY: "aws-parent",
	SECRET_COMPANION_STATE: "state-parent",
};

const ENV_KEYS = [
	...Object.keys(SECRETS),
	"PATH",
	"HOME",
	"NVM_BIN",
	"NVM_DIR",
	"CODEX_HOME",
	"CODEX_API_KEY",
	"CURSOR_API_KEY",
	"CLAUDE_CONFIG_DIR",
	"HTTPS_PROXY",
	"LANG",
];

let saved: Record<string, string | undefined>;
let root: string;
let bin: string;
let home: string;
let configDir: string;

async function script(name: string, body: string): Promise<string> {
	const file = path.join(bin, name);
	await Bun.write(file, `#!/bin/sh\n${body}\n`);
	await fs.chmod(file, 0o755);
	return file;
}

/** Fake adapter install: a package under <config>/agent/collab-agents/<id>/node_modules with a bin script. */
async function fakeAdapter(id: "claude" | "codex", version: string): Promise<string> {
	const pkg = ADAPTER_PINS[id].pkg;
	const dir = path.join(configDir, "agent", "collab-agents", id, "node_modules", ...pkg.split("/"));
	await fs.mkdir(path.join(dir, "dist"), { recursive: true });
	await Bun.write(
		path.join(dir, "package.json"),
		JSON.stringify({ name: pkg, version, bin: { fake: "dist/index.js" } }),
	);
	await Bun.write(path.join(dir, "dist", "index.js"), "// fake adapter\n");
	return path.join(dir, "dist", "index.js");
}

const byId = (list: AgentInfo[], id: string): AgentInfo => {
	const found = list.find(a => a.id === id);
	if (!found) throw new Error(`no ${id} in list`);
	return found;
};

beforeEach(async () => {
	saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agents-"));
	bin = path.join(root, "bin");
	home = path.join(root, "home");
	configDir = path.join(root, "config");
	await fs.mkdir(bin, { recursive: true });
	await fs.mkdir(home, { recursive: true });
	for (const k of ENV_KEYS) delete process.env[k];
	process.env.HOME = home;
	process.env.NVM_DIR = path.join(root, "no-nvm");
	process.env.PATH = `${bin}:/usr/bin:/bin`;
});

afterEach(async () => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	await fs.rm(root, { recursive: true, force: true });
});

const noFallbacks = (): { configDir: string; fallbackDirs: string[]; refresh: true } => ({
	configDir,
	fallbackDirs: [],
	refresh: true,
});

describe("detection", () => {
	it("resolves vendor binaries from PATH and reports version and auth", async () => {
		await script(
			"claude",
			'case "$1" in --version) echo "7.1.2 (Claude Code)";; auth) echo \'{"loggedIn": true}\';; esac',
		);
		await script(
			"codex",
			'case "$1" in --version) echo "codex-cli 3.4.5";; login) echo "Not logged in" >&2; exit 1;; esac',
		);
		await script(
			"opencode",
			'case "$1" in --version) echo "opencode v2.0.6";; auth) echo "No authenticated integrations";; esac',
		);
		const list = await listAgents(noFallbacks());

		expect(list.map(a => a.id)).toEqual(["claude", "codex", "cursor", "grok", "opencode"]);
		const opencode = byId(list, "opencode");
		expect(opencode).toMatchObject({
			installed: true,
			version: "2.0.6",
			auth: "unknown",
			installable: false,
		});
		expect(opencode.loginCommand).toBe("opencode auth login");
		expect(opencode.installCommand).toContain("opencode.ai");
		expect(byId(list, "codex")).toMatchObject({
			version: "3.4.5",
			auth: "needed",
			kind: "builtin",
		});
		expect(byId(list, "claude")).toMatchObject({ version: "7.1.2", auth: "ok" });
		expect(byId(list, "cursor")).toMatchObject({
			installed: false,
			version: null,
			auth: "unknown",
		});
		expect(byId(list, "grok")).toMatchObject({ installed: false, version: null });
	});

	it("needs the pinned adapter before claude and codex count as installed", async () => {
		await script("claude", 'echo "7.1.2 (Claude Code)"');
		let list = await listAgents(noFallbacks());
		expect(byId(list, "claude")).toMatchObject({
			installed: false,
			installable: true,
			version: "7.1.2",
			error: "ACP adapter not installed",
		});

		await fakeAdapter("claude", "0.0.1");
		list = await listAgents(noFallbacks());
		expect(byId(list, "claude")).toMatchObject({ installed: true, installable: true });
		expect(byId(list, "claude").error).toContain("pinned");

		await fakeAdapter("claude", ADAPTER_PINS.claude.version);
		list = await listAgents(noFallbacks());
		expect(byId(list, "claude")).toMatchObject({ installed: true, installable: false });
		expect(byId(list, "claude").error).toBeUndefined();
		expect(await adapterVersion("claude", { configDir })).toBe(ADAPTER_PINS.claude.version);
		expect(await adapterVersion("opencode", { configDir })).toBeNull();
	});

	it("finds Cursor under either binary name and tolerates a silent --version", async () => {
		await script(
			"cursor-agent",
			'case "$1" in --version) echo "2026.10.01-abcdef";; status) echo "Not logged in";; esac',
		);
		const cursor = byId(await listAgents(noFallbacks()), "cursor");
		expect(cursor).toMatchObject({ installed: true, version: "2026.10.01-abcdef", auth: "needed" });

		await script("grok", "exit 0");
		const grok = byId(await listAgents(noFallbacks()), "grok");
		expect(grok).toMatchObject({
			installed: true,
			version: null,
			auth: "unknown",
			error: "Could not read the version",
		});
	});

	it("falls back to the common install dirs when PATH is thin", async () => {
		const opencodeDir = path.join(home, ".opencode", "bin");
		await fs.mkdir(opencodeDir, { recursive: true });
		await Bun.write(path.join(opencodeDir, "opencode"), '#!/bin/sh\necho "opencode v9.9.9"\n');
		await fs.chmod(path.join(opencodeDir, "opencode"), 0o755);
		process.env.PATH = "/usr/bin:/bin";
		const list = await listAgents({ configDir, refresh: true, fallbackDirs: [opencodeDir] });
		expect(byId(list, "opencode")).toMatchObject({ installed: true, version: "9.9.9" });
	});

	it("finds binaries in the nvm default node when it is not on PATH", async () => {
		const nvm = path.join(root, "nvm");
		const v22 = path.join(nvm, "versions", "node", "v22.13.0", "bin");
		const v18 = path.join(nvm, "versions", "node", "v18.16.1", "bin");
		for (const dir of [v22, v18]) await fs.mkdir(dir, { recursive: true });
		await fs.mkdir(path.join(nvm, "alias"), { recursive: true });
		await Bun.write(path.join(nvm, "alias", "default"), "22\n");
		await Bun.write(path.join(v22, "codex"), '#!/bin/sh\necho "codex-cli 22.0.0"\n');
		await fs.chmod(path.join(v22, "codex"), 0o755);
		await Bun.write(path.join(v18, "codex"), '#!/bin/sh\necho "codex-cli 18.0.0"\n');
		await fs.chmod(path.join(v18, "codex"), 0o755);
		process.env.NVM_DIR = nvm;
		process.env.PATH = "/usr/bin:/bin";
		// Default fallback dirs: the nvm default (22 -> v22.13.0) is searched before the system dirs.
		const list = await listAgents({ configDir, refresh: true });
		expect(byId(list, "codex").version).toBe("22.0.0");
	});

	it("caches for a minute, and refresh or a custom-agent change busts the cache", async () => {
		const counter = path.join(root, "probes");
		await script("opencode", `echo x >> '${counter}'\ncase "$1" in --version) echo "opencode v1.0.0";; esac`);
		const probes = async (): Promise<number> => ((await Bun.file(counter).text()).match(/x/g) ?? []).length;
		const opts = { configDir, fallbackDirs: [] as string[] };

		await listAgents({ ...opts, refresh: true });
		const first = await probes();
		expect(first).toBeGreaterThan(0);
		await listAgents(opts);
		await listAgents(opts);
		expect(await probes()).toBe(first);

		await listAgents({ ...opts, refresh: true });
		expect(await probes()).toBe(first * 2);

		await saveCustomAgent({ name: "Probe", command: ["/bin/sh"] }, opts);
		expect(await probes()).toBe(first * 3);
	});

	it("shares one in-flight detection between concurrent callers", async () => {
		const counter = path.join(root, "probes");
		await script("opencode", `echo x >> '${counter}'\ncase "$1" in --version) echo "opencode v1.0.0";; esac`);
		const opts = { configDir, fallbackDirs: [] as string[] };
		await Promise.all([listAgents({ ...opts, refresh: true }), listAgents(opts), listAgents(opts)]);
		const single = ((await Bun.file(counter).text()).match(/x/g) ?? []).length;
		await listAgents({ ...opts, refresh: true });
		expect(((await Bun.file(counter).text()).match(/x/g) ?? []).length).toBe(single * 2);
	});

	it("never runs a custom command during detection", async () => {
		const marker = path.join(root, "ran");
		const custom = await script("evil", `echo ran > '${marker}'`);
		await saveCustomAgent({ name: "Evil", command: [custom, "--version"] }, { configDir, fallbackDirs: [] });
		await listAgents(noFallbacks());
		expect(await Bun.file(marker).exists()).toBe(false);
	});

	it("answers ACP initialize for a healthy custom agent and explains a broken one", async () => {
		const good = path.join(root, "good-acp.ts");
		await Bun.write(
			good,
			`const dec = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
	for (const line of dec.decode(chunk).split("\\n")) {
		if (!line.trim()) continue;
		const msg = JSON.parse(line);
		if (msg.method === "initialize") console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } }));
	}
}`,
		);
		const bad = path.join(root, "bad-acp.ts");
		await Bun.write(bad, 'console.error("boom: no credentials");\nprocess.exit(3);');
		const opts = { configDir, fallbackDirs: [] as string[] };
		await saveCustomAgent({ name: "Good", command: [process.execPath, good] }, opts);
		await saveCustomAgent({ name: "Bad", command: [process.execPath, bad] }, opts);
		const list = await listAgents({ ...opts, handshake: true });
		expect(byId(list, "custom:good").error).toBeUndefined();
		expect(byId(list, "custom:bad").error).toContain("exited before answering ACP initialize: boom: no credentials");
	});
});

describe("custom agents", () => {
	const opts = (): { configDir: string; fallbackDirs: string[] } => ({ configDir, fallbackDirs: [] });
	const file = (): string => path.join(configDir, "agent", "collab-agents.json");

	it("saves, lists, updates and deletes, with a 0600 file and no temp leftovers", async () => {
		let list = await saveCustomAgent(
			{ name: "My Agent!", command: ["/bin/sh", "-c", "true"], env: { MY_KEY: "v" } },
			opts(),
		);
		const created = byId(list, "custom:my-agent");
		expect(created).toMatchObject({
			kind: "custom",
			name: "My Agent!",
			installed: true,
			auth: "unknown",
			installable: false,
			installCommand: null,
			loginCommand: null,
			command: ["/bin/sh", "-c", "true"],
			env: { MY_KEY: "v" },
		});
		expect((await fs.stat(file())).mode & 0o777).toBe(0o600);
		expect((await fs.readdir(path.dirname(file()))).filter(n => n.endsWith(".tmp"))).toEqual([]);

		list = await saveCustomAgent({ id: "custom:my-agent", name: "Renamed", command: ["/bin/sh"] }, opts());
		expect(list.filter(a => a.kind === "custom")).toHaveLength(1);
		expect(byId(list, "custom:my-agent")).toMatchObject({ name: "Renamed", command: ["/bin/sh"], env: {} });

		list = await saveCustomAgent({ name: "My Agent", command: ["/bin/sh"] }, opts());
		expect(list.filter(a => a.kind === "custom").map(a => a.id)).toEqual(["custom:my-agent", "custom:my-agent-2"]);

		list = await deleteCustomAgent("custom:my-agent", opts());
		expect(list.filter(a => a.kind === "custom").map(a => a.id)).toEqual(["custom:my-agent-2"]);
		list = await deleteCustomAgent("custom:never-existed", opts());
		expect(list.filter(a => a.kind === "custom")).toHaveLength(1);
		await expect(deleteCustomAgent("claude", opts())).rejects.toThrow("Only custom agents");
	});

	it("keeps every write when saves race", async () => {
		await Promise.all(
			["a", "b", "c", "d", "e"].map(n =>
				saveCustomAgent({ id: `custom:agent-${n}`, name: n, command: ["/bin/sh"] }, opts()),
			),
		);
		const saved = JSON.parse(await Bun.file(file()).text()) as { agents: { id: string }[] };
		expect(saved.agents.map(a => a.id).sort()).toEqual([
			"custom:agent-a",
			"custom:agent-b",
			"custom:agent-c",
			"custom:agent-d",
			"custom:agent-e",
		]);
	});

	it("rejects shell injection and malformed commands", async () => {
		const bad: unknown[] = [
			"sh -c 'rm -rf /'",
			[],
			["sh -c true"],
			["foo; rm -rf /"],
			["foo|bar"],
			["$(whoami)"],
			["`id`"],
			["foo\nbar"],
			["-rf"],
			["a/b"],
			["./local"],
			["/bin/../bin/sh"],
			["/bin//sh"],
			["/bin/sh\0"],
			["/bin/sh", "ok\0nul"],
			["/bin/sh", 5],
			["/bin/sh", "x".repeat(1001)],
			["/bin/sh", ...Array.from({ length: 64 }, () => "a")],
			[""],
		];
		for (const command of bad) {
			await expect(saveCustomAgent({ name: "X", command: command as string[] }, opts())).rejects.toThrow();
		}
		await expect(
			saveCustomAgent({ name: "X", command: ["/bin/sh", ...Array.from({ length: 63 }, () => "a")] }, opts()),
		).resolves.toBeDefined();
		expect(JSON.parse(await Bun.file(file()).text()).agents).toHaveLength(1);
	});

	it("rejects bad names and ids", async () => {
		for (const name of ["", "   ", "x".repeat(61), "bad\nname", "tab\tname", 5 as unknown as string]) {
			await expect(saveCustomAgent({ name, command: ["/bin/sh"] }, opts())).rejects.toThrow("Agent name");
		}
		for (const id of [
			"claude",
			"custom:",
			"custom:UPPER",
			"custom:a_b",
			"custom:../x",
			"custom:x/y",
			`custom:${"a".repeat(33)}`,
			"custom:a b",
			"__proto__",
		]) {
			await expect(saveCustomAgent({ id, name: "X", command: ["/bin/sh"] }, opts())).rejects.toThrow(
				"ids look like",
			);
		}
		const long = await saveCustomAgent({ name: "n".repeat(60), command: ["/bin/sh"] }, opts());
		expect(byId(long, `custom:${"n".repeat(32)}`)).toBeDefined();
		const symbols = await saveCustomAgent({ name: "!!!", command: ["/bin/sh"] }, opts());
		expect(byId(symbols, "custom:agent")).toBeDefined();
	});

	it("rejects bad environment keys, reserved keys and oversize values", async () => {
		const badEnvs: unknown[] = [
			{ lower: "x" },
			{ "1ABC": "x" },
			{ "A-B": "x" },
			{ "A B": "x" },
			{ "A=B": "x" },
			{ "": "x" },
			{ PATH: "/evil" },
			{ HOME: "/evil" },
			{ LD_PRELOAD: "/evil.so" },
			{ DYLD_INSERT_LIBRARIES: "/evil.dylib" },
			{ OK: 5 },
			{ OK: "nul\0" },
			{ OK: "x".repeat(4097) },
			{ [`K${"A".repeat(64)}`]: "x" },
			Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`K${i}`, "v"])),
			["A=B"],
			"A=B",
		];
		for (const env of badEnvs) {
			await expect(
				saveCustomAgent({ name: "X", command: ["/bin/sh"], env: env as Record<string, string> }, opts()),
			).rejects.toThrow();
		}
		const ok = await saveCustomAgent(
			{ name: "Okay", command: ["/bin/sh"], env: { _OK_1: "v", API_BASE: "x".repeat(4096) } },
			opts(),
		);
		expect(Object.keys(byId(ok, "custom:okay").env ?? {})).toEqual(["_OK_1", "API_BASE"]);
	});

	it("allows at most 20 custom agents but still updates an existing one", async () => {
		for (let i = 0; i < 20; i++) await saveCustomAgent({ name: `agent ${i}`, command: ["/bin/sh"] }, opts());
		await expect(saveCustomAgent({ name: "one too many", command: ["/bin/sh"] }, opts())).rejects.toThrow(
			"At most 20",
		);
		await expect(
			saveCustomAgent({ id: "custom:agent-0", name: "renamed", command: ["/bin/sh"] }, opts()),
		).resolves.toBeDefined();
		expect(JSON.parse(await Bun.file(file()).text()).agents).toHaveLength(20);
	});

	it("drops invalid entries from a hand-edited file instead of failing", async () => {
		await fs.mkdir(path.dirname(file()), { recursive: true });
		await Bun.write(
			file(),
			JSON.stringify({
				version: 1,
				agents: [
					{ id: "custom:fine", name: "Fine", command: ["/bin/sh"], env: {} },
					{ id: "custom:path", name: "Hijack", command: ["/bin/sh"], env: { PATH: "/evil" } },
					{ id: "claude", name: "Impostor", command: ["/bin/sh"] },
					{ id: "custom:string", name: "S", command: "sh -c true" },
					null,
					7,
				],
			}),
		);
		const custom = (await listAgents(noFallbacks())).filter(a => a.kind === "custom");
		expect(custom.map(a => a.id)).toEqual(["custom:fine"]);
		await Bun.write(file(), "{not json");
		expect((await listAgents(noFallbacks())).filter(a => a.kind === "custom")).toEqual([]);
	});

	it("reports a missing command and refuses to launch it", async () => {
		const list = await saveCustomAgent({ name: "Ghost", command: ["definitely-not-installed-xyz", "acp"] }, opts());
		expect(byId(list, "custom:ghost")).toMatchObject({
			installed: false,
			error: "definitely-not-installed-xyz was not found",
		});
		await expect(launchSpec("custom:ghost", { ...opts(), cwd: root, permission: "supervised" })).rejects.toThrow(
			"was not found",
		);
	});
});

describe("launchSpec", () => {
	/** The project folder, apart from the fake home and config dir that share `root`. */
	const work = (): string => path.join(root, "work");
	const spec = (id: string, extra: Partial<LaunchOpts> = {}): Promise<LaunchSpec> =>
		launchSpec(id, { configDir, fallbackDirs: [], cwd: work(), permission: "supervised", ...extra });

	beforeEach(async () => {
		await fs.mkdir(work(), { recursive: true });
		for (const name of ["claude", "codex", "agent", "grok", "opencode"]) await script(name, "exit 0");
		await fakeAdapter("claude", ADAPTER_PINS.claude.version);
		await fakeAdapter("codex", ADAPTER_PINS.codex.version);
	});

	it("passes an allowlisted environment and never the parent's secrets", async () => {
		Object.assign(process.env, SECRETS, { LANG: "en_GB.UTF-8", HTTPS_PROXY: "http://proxy.test:3128" });
		process.env.TERM = "xterm-256color";
		await saveCustomAgent(
			{ name: "Mine", command: ["/bin/sh", "-c", "true"], env: { CUSTOM_FLAG: "1" } },
			{ configDir, fallbackDirs: [] },
		);
		for (const id of ["claude", "codex", "cursor", "grok", "opencode", "custom:mine"]) {
			const { env } = await spec(id);
			for (const key of Object.keys(SECRETS)) expect(env[key]).toBeUndefined();
			for (const value of Object.values(env)) {
				for (const secret of Object.values(SECRETS)) expect(value).not.toContain(secret);
			}
			expect(env.HOME).toBe(home);
			expect(env.PATH).toContain(bin);
			expect(env.LANG).toBe("en_GB.UTF-8");
			expect(env.TERM).toBe("xterm-256color");
			expect(env.HTTPS_PROXY).toBe("http://proxy.test:3128");
			expect(env.PATH.split(":")).toContain("/usr/bin");
		}
		expect((await spec("custom:mine")).env.CUSTOM_FLAG).toBe("1");
	});

	it("only lets a vendor's own variables through to that vendor", async () => {
		Object.assign(process.env, {
			CODEX_HOME: "/h/.codex",
			CODEX_API_KEY: "ck",
			CURSOR_API_KEY: "cur",
			CLAUDE_CONFIG_DIR: "/h/.claude",
		});
		expect((await spec("codex")).env).toMatchObject({ CODEX_HOME: "/h/.codex", CODEX_API_KEY: "ck" });
		expect((await spec("codex")).env.CURSOR_API_KEY).toBeUndefined();
		expect((await spec("cursor")).env).toMatchObject({ CURSOR_API_KEY: "cur" });
		expect((await spec("cursor")).env.CODEX_API_KEY).toBeUndefined();
		expect((await spec("claude")).env).toMatchObject({ CLAUDE_CONFIG_DIR: "/h/.claude" });
		for (const id of ["grok", "opencode", "custom:none"]) {
			if (id === "custom:none")
				await saveCustomAgent({ name: "None", command: ["/bin/sh"] }, { configDir, fallbackDirs: [] });
			const { env } = await spec(id);
			for (const key of ["CODEX_HOME", "CODEX_API_KEY", "CURSOR_API_KEY", "CLAUDE_CONFIG_DIR"])
				expect(env[key]).toBeUndefined();
		}
	});

	it("keeps the user's own env out of a custom agent beyond what they set", async () => {
		process.env.HOME = home;
		await saveCustomAgent(
			{ name: "Env", command: ["/bin/sh"], env: { A_KEY: "a" } },
			{ configDir, fallbackDirs: [] },
		);
		const { env } = await spec("custom:env");
		const base = [
			"A_KEY",
			"HOME",
			"PATH",
			"TERM",
			"TMPDIR",
			"USER",
			"LOGNAME",
			"SHELL",
			"LANG",
			"LC_ALL",
			"LC_CTYPE",
			"TZ",
		];
		expect(Object.keys(env).filter(k => !base.includes(k))).toEqual([]);
		expect(env.A_KEY).toBe("a");
	});

	it("launches the adapters under bun with vendor-specific settings", async () => {
		const claude = await spec("claude", { model: "opus" });
		const script = path.join(
			configDir,
			"agent",
			"collab-agents",
			"claude",
			"node_modules",
			"@agentclientprotocol",
			"claude-agent-acp",
			"dist",
			"index.js",
		);
		expect(claude.command[1]).toBe(script);
		expect(path.basename(claude.command[0])).toStartWith("bun");
		expect(claude.cwd).toBe(work());
		expect(claude.env.CLAUDE_CODE_EXECUTABLE).toBe(path.join(bin, "claude"));
		expect(claude.env.ANTHROPIC_MODEL).toBe("opus");

		const supervised = await spec("codex");
		expect(supervised.env.INITIAL_AGENT_MODE).toBe("read-only");
		expect((await spec("codex", { permission: "full" })).env.INITIAL_AGENT_MODE).toBe("agent-full-access");
		expect(JSON.parse((await spec("codex", { model: "gpt-5.5" })).env.CODEX_CONFIG)).toEqual({ model: "gpt-5.5" });
		expect(supervised.env.CODEX_CONFIG).toBeUndefined();
	});

	it("maps the model to Cursor and Grok flags and never passes a vendor sandbox flag", async () => {
		expect((await spec("cursor")).command).toEqual([path.join(bin, "agent"), "acp"]);
		expect((await spec("cursor", { model: "auto" })).command).toEqual([
			path.join(bin, "agent"),
			"--model",
			"auto",
			"acp",
		]);
		expect((await spec("grok", { model: "grok-build" })).command).toEqual([
			path.join(bin, "grok"),
			"--no-auto-update",
			"--permission-mode",
			"default",
			"-m",
			"grok-build",
			"agent",
			"stdio",
		]);
	});

	it("never enables a vendor auto-approve, whatever the permission", async () => {
		const forbidden = [
			"--force",
			"-f",
			"--yolo",
			"--always-approve",
			"--auto",
			"--dangerously-skip-permissions",
			"--approve-mcps",
			"--trust",
		];
		for (const id of ["claude", "codex", "cursor", "grok", "opencode"]) {
			for (const permission of ["supervised", "full"] as const) {
				const { command, env } = await spec(id, { permission, model: "m1" });
				for (const flag of forbidden) expect(command).not.toContain(flag);
				expect(Object.keys(env).filter(k => /YOLO|ALWAYS|BYPASS/.test(k))).toEqual([]);
			}
		}
		const opencodeConfig = JSON.parse((await spec("opencode")).env.OPENCODE_CONFIG_CONTENT);
		expect(opencodeConfig).toEqual({ permission: { "*": "ask" } });
		// Always ask: the host answers in full access, so switching to supervised later needs no relaunch.
		expect(JSON.parse((await spec("opencode", { permission: "full" })).env.OPENCODE_CONFIG_CONTENT)).toEqual(
			opencodeConfig,
		);
		expect((await spec("grok", { permission: "full" })).command).toContain("default");
	});

	it("exposes the ACP session modes a host can switch between", () => {
		expect(vendorModes("claude")).toEqual({ supervised: "default", full: "bypassPermissions" });
		expect(vendorModes("codex")).toEqual({ supervised: "read-only", full: "agent-full-access" });
		for (const id of ["cursor", "grok", "opencode", "custom:x", "__proto__", "constructor"]) {
			expect(vendorModes(id)).toEqual({ supervised: null, full: null });
		}
	});

	it("rejects unknown agents, bad models and bad permissions", async () => {
		for (const id of ["gemini", "__proto__", "constructor", "custom:missing", "custom:../x"]) {
			await expect(spec(id)).rejects.toThrow("Unknown agent");
		}
		for (const model of ["--yolo", "-m", "a b", "a;b", "$(x)", "", "x".repeat(101), "a\nb"]) {
			await expect(spec("cursor", { model })).rejects.toThrow("Invalid model id");
		}
		await expect(spec("cursor", { permission: "yolo" as "full" })).rejects.toThrow("Permission");
	});

	it("refuses to launch what is not installed", async () => {
		await fs.rm(path.join(configDir, "agent", "collab-agents"), { recursive: true, force: true });
		await expect(spec("claude")).rejects.toThrow("adapter is not installed");
		await fs.rm(path.join(bin, "grok"));
		await expect(spec("grok")).rejects.toThrow("Grok is not installed");
	});
});

describe("install", () => {
	it("refuses agents without an installable adapter", async () => {
		for (const id of ["cursor", "grok", "opencode", "custom:x", "__proto__"]) {
			await expect(installAgent(id, { configDir, fallbackDirs: [] })).rejects.toThrow("no adapter");
		}
	});
});

// Real network install: proves the pinned versions resolve and the adapter answers ACP.
describe("pinned adapter install (network)", () => {
	let tmpConfig: string;
	beforeAll(async () => {
		tmpConfig = await fs.mkdtemp(path.join(os.tmpdir(), "omp-install-"));
	});
	afterAll(async () => {
		await fs.rm(tmpConfig, { recursive: true, force: true });
	});

	it("installs the pinned Claude adapter from the shipped lockfile and launches it", async () => {
		// The install env is allowlisted; keep the real PATH so bun resolves, but nothing else changes.
		process.env.PATH = saved.PATH ?? "/usr/bin:/bin";
		const opts = { configDir: tmpConfig };
		const before = byId(await listAgents({ ...opts, refresh: true }), "claude");
		expect(before.installed).toBe(false);

		const [first, second] = await Promise.all([installAgent("claude", opts), installAgent("claude", opts)]);
		for (const list of [first, second]) {
			expect(byId(list, "claude")).toMatchObject({ installed: true, installable: false });
		}
		expect(await adapterVersion("claude", opts)).toBe(ADAPTER_PINS.claude.version);

		const dir = path.join(tmpConfig, "agent", "collab-agents", "claude");
		const shipped = path.join(import.meta.dir, "..", "scripts", "foreign", "adapters", "claude");
		expect(await Bun.file(path.join(dir, "bun.lock")).text()).toBe(
			await Bun.file(path.join(shipped, "bun.lock")).text(),
		);
		// Transitive dependencies come from the lockfile: the SDK version it names, not whatever is newest.
		const lock = await Bun.file(path.join(shipped, "bun.lock")).text();
		const sdk = /"@anthropic-ai\/claude-agent-sdk@([^"]+)"/.exec(lock)?.[1];
		expect(sdk).toBeDefined();
		const sdkPackage = JSON.parse(
			await Bun.file(path.join(dir, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json")).text(),
		);
		expect(sdkPackage.version).toBe(sdk);

		const withHandshake = byId(await listAgents({ ...opts, handshake: true }), "claude");
		expect(withHandshake.error).toBeUndefined();

		const launch = await launchSpec("claude", { ...opts, cwd: tmpConfig, permission: "supervised" });
		expect(launch.command[1].startsWith(dir)).toBe(true);
	}, 180_000);
});

describe("shipped adapter lockfiles", () => {
	const shipped = (id: string): string => path.join(import.meta.dir, "..", "scripts", "foreign", "adapters", id);

	for (const id of ["claude", "codex"] as const) {
		it(`pins ${id}'s adapter and its whole tree, with integrity hashes`, async () => {
			const pin = ADAPTER_PINS[id];
			const manifest = JSON.parse(await Bun.file(path.join(shipped(id), "package.json")).text());
			expect(manifest.dependencies).toEqual({ [pin.pkg]: pin.version });
			const lock = await Bun.file(path.join(shipped(id), "bun.lock")).text();
			expect(lock).toContain(`"${pin.pkg}@${pin.version}"`);
			// Every resolved package carries an integrity hash: no entry without one except the root workspace.
			const entries = [...lock.matchAll(/\["([^"]+@[^"]+)", "[^"]*", \{[^\]]*\}, "(sha512-[^"]+)"\]/g)];
			expect(entries.length).toBeGreaterThan(5);
			const unresolved = [...lock.matchAll(/^\s+"[^"]+": \["[^"]+", "", \{.*\}\],?$/gm)].filter(
				m => !m[0].includes("sha512-"),
			);
			expect(unresolved).toEqual([]);
		});
	}

	it("refuses an install that would resolve anything the lockfile does not name", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-frozen-"));
		try {
			await Bun.write(
				path.join(dir, "package.json"),
				JSON.stringify({ name: "x", private: true, dependencies: { zod: "4.6.5" } }),
			);
			await fs.copyFile(path.join(shipped("claude"), "bun.lock"), path.join(dir, "bun.lock"));
			const proc = Bun.spawn([process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"], {
				cwd: dir,
				stdout: "pipe",
				stderr: "pipe",
				stdin: "ignore",
			});
			expect(await proc.exited).not.toBe(0);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	}, 60_000);
});
