/**
 * Descriptors for the vendor coding agents the companion can drive over ACP (Claude Code, Codex,
 * Cursor, Grok, OpenCode) and for user-defined ACP commands: how to find them, whether they are
 * signed in, how to install the ACP adapters from their shipped lockfiles, and how to launch one.
 *
 * Rules every launch follows:
 * - The child gets an allowlisted environment ({@link launchSpec}), never the companion's. Provider
 *   keys the companion's own agent uses (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, ...)
 *   are not on any list: vendors sign in with their own login, and a shared key would also silently
 *   switch a vendor from its subscription to metered billing.
 * - Vendor auto-approve flags (`--force`, `--always-approve`, `--auto`, ...) are never passed. A
 *   session's permission mode can change while it runs, and a process-wide flag cannot be undone, so
 *   the host enforces supervised/full by answering the agent's permission requests; {@link
 *   vendorModes} names the ACP session modes it can also switch to. Where the vendor offers an
 *   explicit "ask" setting it is forced (always, not only when supervised: the mode can change while it runs), so a
 *   user's own always-approve config cannot leak in.
 * - Foreign sessions run unsandboxed (supervised or full access): no sandbox that can confine an agent with a shell
 *   exists yet. A vendor's own sandbox flags are never used: their scope (config files, hooks, escalation prompts)
 *   is the vendor's to define.
 * - Detection runs `--version` and a read-only auth status command per vendor, plus an optional ACP
 *   `initialize` (never `session/new`). Custom commands are never executed by detection.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface LaunchSpec {
	command: string[];
	env: Record<string, string>;
	cwd: string;
}

export interface AgentModel {
	id: string;
	name: string;
}

export interface AgentInfo {
	id: string;
	name: string;
	kind: "builtin" | "custom";
	/** Ready to launch: the vendor binary (or, for adapter-backed vendors, the pinned adapter) is present. */
	installed: boolean;
	version: string | null;
	auth: "ok" | "needed" | "unknown";
	/** True when {@link installAgent} would install or update the adapter. */
	installable: boolean;
	/** One-line shell command a user can run to install the vendor CLI; null for custom agents. */
	installCommand: string | null;
	/** Shell command a user runs to sign in; null when the agent has none. */
	loginCommand: string | null;
	/** Vendor model ids known before any session exists; absent when the vendor's list is account-dependent. */
	models?: AgentModel[];
	/** Custom agents only, as saved. */
	command?: string[];
	env?: Record<string, string>;
	error?: string;
}

export type Permission = "supervised" | "full";

/** Test and embedding hooks shared by every entry point. */
export interface AgentsOpts {
	configDir: string;
	/** Replaces the install-dir fallbacks searched after PATH (`/opt/homebrew/bin`, ...). */
	fallbackDirs?: string[];
}

export interface LaunchOpts extends AgentsOpts {
	cwd: string;
	permission: Permission;
	/** The vendor's own model id. */
	model?: string;
}

export interface CustomAgentInput {
	/** `custom:<slug>`; absent creates a new agent with a slug derived from the name. */
	id?: string;
	name: string;
	command: string[];
	env?: Record<string, string>;
}

/**
 * Package that adapts a vendor CLI to ACP, installed into `<config>/agent/collab-agents/<id>/` from the lockfile
 * shipped in `./adapters/<id>/` (so its whole dependency tree, with integrity hashes, is pinned, not just this package).
 */
export interface AdapterPin {
	pkg: string;
	version: string;
}

export const ADAPTER_PINS = {
	claude: { pkg: "@agentclientprotocol/claude-agent-acp", version: "0.89.1" },
	codex: { pkg: "@agentclientprotocol/codex-acp", version: "2.2.2" },
} as const satisfies Record<string, AdapterPin>;

const CUSTOM_ID_RE = /^custom:[a-z0-9-]{1,32}$/;
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
const COMMAND_NAME_RE = /^[A-Za-z0-9._+-]+$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,99}$/;
const MAX_CUSTOM_AGENTS = 20;
const MAX_NAME = 60;
const MAX_ARGS = 64;
const MAX_ARG_LEN = 1000;
const MAX_ENV_ENTRIES = 32;
const MAX_ENV_KEY = 64;
const MAX_ENV_VALUE = 4096;
/** Variables a custom agent may not set: they redirect lookups or inject code into the child. */
const RESERVED_ENV: Record<string, true> = { PATH: true, HOME: true };
const RESERVED_ENV_PREFIXES = ["LD_", "DYLD_"];

const CACHE_TTL_MS = 60_000;
const VERSION_TIMEOUT_MS = 5_000;
const AUTH_TIMEOUT_MS = 8_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const INSTALL_TIMEOUT_MS = 300_000;
const MAX_PROBE_BYTES = 64 * 1024;
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

/** Environment every child may inherit from the companion: locale, terminal, XDG dirs, proxies and CA bundles. */
const BASE_ENV = [
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TMPDIR",
	"USER",
	"LOGNAME",
	"SHELL",
	"TZ",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"XDG_STATE_HOME",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"all_proxy",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"NODE_EXTRA_CA_CERTS",
];

// --- Descriptors ------------------------------------------------------------------------------

interface LaunchInput {
	/** Resolved vendor CLI, or null when absent. */
	bin: string | null;
	/** Command that runs the managed adapter, or null when it is not installed. */
	adapter: string[] | null;
	permission: Permission;
	model?: string;
}

interface Launch {
	command: string[];
	env: Record<string, string>;
}

interface Descriptor {
	id: string;
	name: string;
	/** Executable names of the vendor CLI, most specific first. */
	binaries: string[];
	adapter?: AdapterPin;
	installCommand: string;
	loginCommand: string;
	models?: AgentModel[];
	/** Vendor-specific variables passed through from the companion's environment, on top of {@link BASE_ENV}. */
	passEnv: string[];
	/** Argument lists that print the version, tried in order. */
	versionArgs: string[][];
	/** Maps the vendor's status command to an auth state. */
	auth(bin: string, env: Record<string, string>): Promise<AgentInfo["auth"]>;
	launch(input: LaunchInput): Launch;
}

/** ACP session mode ids a host can switch to at runtime; null where the vendor has no such mode. */
export interface VendorModes {
	supervised: string | null;
	full: string | null;
}

const NO_MODES: VendorModes = { supervised: null, full: null };

const BUILTIN_MODES: Record<string, VendorModes> = {
	claude: { supervised: "default", full: "bypassPermissions" },
	codex: { supervised: "read-only", full: "agent-full-access" },
	cursor: NO_MODES,
	grok: NO_MODES,
	opencode: NO_MODES,
};

function requireBin(d: Descriptor, bin: string | null): string {
	if (!bin) throw new Error(`${d.name} is not installed`);
	return bin;
}

function requireAdapter(d: Descriptor, adapter: string[] | null): string[] {
	if (!adapter) throw new Error(`The ${d.name} ACP adapter is not installed`);
	return adapter;
}

function modelFlag(model: string | undefined, flag: string): string[] {
	return model ? [flag, model] : [];
}

const claude: Descriptor = {
	id: "claude",
	name: "Claude Code",
	binaries: ["claude"],
	adapter: ADAPTER_PINS.claude,
	installCommand: "curl -fsSL https://claude.ai/install.sh | bash",
	loginCommand: "claude auth login",
	models: [
		{ id: "sonnet", name: "Sonnet" },
		{ id: "opus", name: "Opus" },
		{ id: "haiku", name: "Haiku" },
	],
	passEnv: ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN"],
	versionArgs: [["--version"]],
	async auth(bin, env) {
		const res = await run([bin, "auth", "status"], env, AUTH_TIMEOUT_MS);
		if (res.timedOut) return "unknown";
		try {
			const parsed: unknown = JSON.parse(res.out);
			if (parsed && typeof parsed === "object" && "loggedIn" in parsed && typeof parsed.loggedIn === "boolean") {
				return parsed.loggedIn ? "ok" : "needed";
			}
		} catch {
			// not JSON: fall through
		}
		return "unknown";
	},
	launch(input) {
		const env: Record<string, string> = {};
		// The user's own claude binary already holds the keychain grant for its login; the adapter's bundled one would prompt.
		if (input.bin) env.CLAUDE_CODE_EXECUTABLE = input.bin;
		if (input.model) env.ANTHROPIC_MODEL = input.model;
		return { command: requireAdapter(claude, input.adapter), env };
	},
};

const codex: Descriptor = {
	id: "codex",
	name: "Codex",
	binaries: ["codex"],
	adapter: ADAPTER_PINS.codex,
	installCommand: "npm install -g @openai/codex",
	loginCommand: "codex login",
	passEnv: ["CODEX_HOME", "CODEX_API_KEY"],
	versionArgs: [["--version"]],
	async auth(bin, env) {
		const res = await run([bin, "login", "status"], env, AUTH_TIMEOUT_MS);
		if (res.timedOut) return "unknown";
		if (res.code === 0) return "ok";
		return /not logged in/i.test(`${res.out}\n${res.err}`) ? "needed" : "unknown";
	},
	launch(input) {
		// `read-only` asks before every edit and command that escapes Codex's sandbox (supervised); `agent-full-access`
		// drops both (full).
		const mode = input.permission === "full" ? "agent-full-access" : "read-only";
		const env: Record<string, string> = { INITIAL_AGENT_MODE: mode };
		if (input.model) env.CODEX_CONFIG = JSON.stringify({ model: input.model });
		return { command: requireAdapter(codex, input.adapter), env };
	},
};

const cursor: Descriptor = {
	id: "cursor",
	name: "Cursor",
	binaries: ["agent", "cursor-agent"],
	installCommand: "curl https://cursor.com/install -fsS | bash",
	loginCommand: "agent login",
	passEnv: ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"],
	versionArgs: [["--version"]],
	async auth(bin, env) {
		if (env.CURSOR_API_KEY || env.CURSOR_AUTH_TOKEN) return "ok";
		const res = await run([bin, "status"], env, AUTH_TIMEOUT_MS);
		if (res.timedOut) return "unknown";
		const text = `${res.out}\n${res.err}`;
		if (/not\s+(logged|signed)\s+in|not\s+authenticated|logged\s+out|unauthenticated/i.test(text)) return "needed";
		if (res.code === 0 && /(logged|signed)\s+in|authenticated/i.test(text)) return "ok";
		return "unknown";
	},
	launch(input) {
		// Global options precede the hidden `acp` command. `--force` is never passed.
		return { command: [requireBin(cursor, input.bin), ...modelFlag(input.model, "--model"), "acp"], env: {} };
	},
};

const grok: Descriptor = {
	id: "grok",
	name: "Grok",
	binaries: ["grok"],
	installCommand: "curl -fsSL https://x.ai/cli/install.sh | bash",
	loginCommand: "grok login",
	passEnv: [],
	versionArgs: [["--version"], ["version"]],
	async auth() {
		// No documented non-interactive status command.
		return "unknown";
	},
	launch(input) {
		// `--permission-mode default` beats the user's config, so a configured always-approve cannot leak in.
		const args = ["--no-auto-update", "--permission-mode", "default", ...modelFlag(input.model, "-m")];
		return { command: [requireBin(grok, input.bin), ...args, "agent", "stdio"], env: {} };
	},
};

const opencode: Descriptor = {
	id: "opencode",
	name: "OpenCode",
	binaries: ["opencode"],
	installCommand: "curl -fsSL https://opencode.ai/install | bash",
	loginCommand: "opencode auth login",
	passEnv: ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_API_KEY"],
	versionArgs: [["--version"]],
	async auth(bin, env) {
		const res = await run([bin, "auth", "list"], env, AUTH_TIMEOUT_MS);
		if (res.timedOut || res.code !== 0) return "unknown";
		const text = res.out.trim();
		// OpenCode also serves free models, so "no credentials" is not "needs login".
		if (!text || /no\s+(authenticated|credentials|providers)|^0\s+credentials/im.test(text)) return "unknown";
		return "ok";
	},
	launch(input) {
		// Inline config beats the user's files: every tool asks, whatever the permission. The host answers in full
		// access, so a switch to supervised needs no relaunch.
		const env: Record<string, string> = {
			OPENCODE_DISABLE_AUTOUPDATE: "1",
			OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { "*": "ask" } }),
		};
		return { command: [requireBin(opencode, input.bin), "acp"], env };
	},
};

const BUILTINS: Descriptor[] = [claude, codex, cursor, grok, opencode];
const BUILTIN_BY_ID: Record<string, Descriptor> = Object.fromEntries(BUILTINS.map(d => [d.id, d]));

function builtin(id: string): Descriptor | undefined {
	return Object.hasOwn(BUILTIN_BY_ID, id) ? BUILTIN_BY_ID[id] : undefined;
}

/** What never changes about each built-in agent (detection only fills in its status), for fixtures that fake the detection, such as the mock companion. `hasAdapter`: the agent runs through an ACP adapter the companion installs. */
export function builtinAgentDescriptors(): (Pick<AgentInfo, "id" | "name" | "installCommand" | "loginCommand"> & {
	models?: AgentModel[];
	hasAdapter: boolean;
})[] {
	return BUILTINS.map(d => ({
		id: d.id,
		name: d.name,
		installCommand: d.installCommand,
		loginCommand: d.loginCommand,
		models: d.models?.map(model => ({ ...model })),
		hasAdapter: d.adapter !== undefined,
	}));
}

/** ACP session modes for supervised/full on this agent; custom and unknown ids have none. */
export function vendorModes(id: string): VendorModes {
	return Object.hasOwn(BUILTIN_MODES, id) ? BUILTIN_MODES[id] : NO_MODES;
}

/** Display name of a built-in or saved custom agent without any binary or version detection; null when unknown. */
export async function agentName(id: string, opts: { configDir: string }): Promise<string | null> {
	const d = builtin(id);
	if (d) return d.name;
	if (!CUSTOM_ID_RE.test(id)) return null;
	return (await readCustom(opts.configDir)).find(e => e.id === id)?.name ?? null;
}

// --- Locating binaries ------------------------------------------------------------------------

function homeDir(): string {
	return process.env.HOME || os.homedir();
}

function compareVersionsDesc(a: string, b: string): number {
	const pa = a.replace(/^v/, "").split(".").map(Number);
	const pb = b.replace(/^v/, "").split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pb[i] ?? 0) - (pa[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

async function readTrim(file: string): Promise<string | null> {
	try {
		return (await fs.readFile(file, "utf8")).trim();
	} catch {
		return null;
	}
}

/** `bin` dirs of nvm's Node installs: the active one (`NVM_BIN`), the `default` alias, then the rest newest first. */
async function nvmBinDirs(home: string): Promise<string[]> {
	const nvmDir = process.env.NVM_DIR || path.join(home, ".nvm");
	let versions: string[];
	try {
		versions = (await fs.readdir(path.join(nvmDir, "versions", "node"))).filter(v => /^v\d/.test(v));
	} catch {
		versions = [];
	}
	versions.sort(compareVersionsDesc);
	let alias = await readTrim(path.join(nvmDir, "alias", "default"));
	for (let hops = 0; alias && hops < 5; hops++) {
		const next =
			/^[\w./*-]+$/.test(alias) && !alias.includes("..") ? await readTrim(path.join(nvmDir, "alias", alias)) : null;
		if (!next) break;
		alias = next;
	}
	const preferred = alias
		? versions.find(v => v === alias || v.startsWith(`${alias.startsWith("v") ? alias : `v${alias}`}.`))
		: undefined;
	const ordered = [...(preferred ? [preferred] : []), ...versions.filter(v => v !== preferred)];
	return [
		...(process.env.NVM_BIN ? [process.env.NVM_BIN] : []),
		...ordered.map(v => path.join(nvmDir, "versions", "node", v, "bin")),
	];
}

async function defaultFallbackDirs(): Promise<string[]> {
	const home = homeDir();
	return [
		path.join(home, ".local", "bin"),
		path.join(home, ".opencode", "bin"),
		path.join(home, ".claude", "local"),
		path.join(home, ".grok", "bin"),
		path.join(home, ".bun", "bin"),
		path.join(home, ".npm-global", "bin"),
		...(await nvmBinDirs(home)),
		"/opt/homebrew/bin",
		"/usr/local/bin",
	];
}

/**
 * PATH to search and to hand children: the companion's PATH (thin under launchd) then the usual
 * install dirs, so vendors installed by their own scripts or nvm are found either way.
 */
async function searchPath(opts: AgentsOpts, extra: string[] = []): Promise<string> {
	const dirs = [
		...extra,
		...(process.env.PATH ?? "").split(":"),
		...(opts.fallbackDirs ?? (await defaultFallbackDirs())),
		"/usr/bin",
		"/bin",
	];
	return [...new Set(dirs.filter(d => d && path.isAbsolute(d)))].join(":");
}

function which(name: string, searchPathValue: string): string | null {
	return Bun.which(name, { PATH: searchPathValue, cwd: "/" });
}

async function findBin(d: Descriptor, pathValue: string): Promise<string | null> {
	for (const name of d.binaries) {
		const found = which(name, pathValue);
		if (found) return found;
	}
	return null;
}

/** Runtime for the adapters' scripts: the bun running the companion (adapters work under bun; node may be absent or old). */
function bunBin(pathValue: string): string | null {
	return path.basename(process.execPath).startsWith("bun") ? process.execPath : which("bun", pathValue);
}

// --- Processes --------------------------------------------------------------------------------

interface RunResult {
	code: number | null;
	out: string;
	err: string;
	timedOut: boolean;
}

async function readCapped(stream: ReadableStream<Uint8Array> | null | undefined): Promise<string> {
	if (!stream) return "";
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		// Keep draining past the cap so the child never blocks on a full pipe.
		if (text.length < MAX_PROBE_BYTES) text += decoder.decode(value, { stream: true });
	}
	return text.slice(0, MAX_PROBE_BYTES).replace(ANSI_RE, "");
}

async function run(
	cmd: string[],
	env: Record<string, string>,
	timeoutMs: number,
	cwd: string = os.tmpdir(),
): Promise<RunResult> {
	let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
	try {
		proc = Bun.spawn(cmd, {
			cwd,
			env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			timeout: timeoutMs,
			killSignal: "SIGKILL",
		});
	} catch (error) {
		return { code: null, out: "", err: error instanceof Error ? error.message : String(error), timedOut: false };
	}
	const [out, err, code] = await Promise.all([readCapped(proc.stdout), readCapped(proc.stderr), proc.exited]);
	return { code, out: out.trim(), err: err.trim(), timedOut: proc.signalCode === "SIGKILL" };
}

function parseVersion(text: string): string | null {
	const match = /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(text);
	return match ? match[1] : null;
}

// --- Managed adapters -------------------------------------------------------------------------

function agentsDir(configDir: string): string {
	return path.join(configDir, "agent", "collab-agents");
}

/** Where the adapter for `id` is installed. */
function adapterRoot(configDir: string, id: string): string {
	return path.join(agentsDir(configDir), id);
}

/** Package manifest and lockfile shipped for `id`'s adapter. */
function adapterSource(id: string): string {
	return path.join(import.meta.dir, "adapters", id);
}

function customFile(configDir: string): string {
	return path.join(configDir, "agent", "collab-agents.json");
}

interface InstalledPackage {
	version: string | null;
	/** First `bin` entry, relative to the package root. */
	bin: string | null;
}

async function readPackageJson(configDir: string, id: string, pkg: string): Promise<InstalledPackage | null> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(
			await fs.readFile(path.join(adapterRoot(configDir, id), "node_modules", pkg, "package.json"), "utf8"),
		);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const version = "version" in parsed && typeof parsed.version === "string" ? parsed.version : null;
	let bin: string | null = null;
	if ("bin" in parsed) {
		if (typeof parsed.bin === "string") bin = parsed.bin;
		else if (parsed.bin && typeof parsed.bin === "object") {
			bin = Object.values(parsed.bin).find((v): v is string => typeof v === "string") ?? null;
		}
	}
	return { version, bin };
}

/** Version of the managed adapter installed for `id`, or null when absent (or `id` has no adapter). */
export async function adapterVersion(id: string, opts: { configDir: string }): Promise<string | null> {
	const pin = builtin(id)?.adapter;
	if (!pin) return null;
	return (await readPackageJson(opts.configDir, id, pin.pkg))?.version ?? null;
}

/** Script of the adapter's single `bin`, resolved inside the managed install, or null when it is missing or escapes it. */
async function adapterScript(configDir: string, id: string, pin: AdapterPin): Promise<string | null> {
	const pkg = await readPackageJson(configDir, id, pin.pkg);
	if (!pkg?.bin) return null;
	const root = path.join(adapterRoot(configDir, id), "node_modules", pin.pkg);
	const script = path.resolve(root, pkg.bin);
	if (!script.startsWith(`${root}${path.sep}`)) return null;
	return (await Bun.file(script).exists()) ? script : null;
}

// --- Environment ------------------------------------------------------------------------------

/** Allowlisted environment: HOME, a PATH, locale/terminal/network basics and the vendor's own variables. */
function allowlistedEnv(pathValue: string, passEnv: readonly string[]): Record<string, string> {
	const env: Record<string, string> = { HOME: homeDir(), PATH: pathValue, TERM: process.env.TERM || "dumb" };
	for (const key of [...BASE_ENV, ...passEnv]) {
		const value = process.env[key];
		if (value) env[key] = value;
	}
	return env;
}

// --- Custom agents ----------------------------------------------------------------------------

interface CustomEntry {
	id: string;
	name: string;
	command: string[];
	env: Record<string, string>;
}

let writeChain: Promise<unknown> = Promise.resolve();

/** Runs `fn` after every earlier serialised task (custom-agent writes, installs) has settled. */
function serialised<T>(fn: () => Promise<T>): Promise<T> {
	const next = writeChain.then(fn, fn);
	writeChain = next.catch(() => undefined);
	return next;
}

function hasControlChars(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

function validateName(name: unknown): string {
	if (typeof name !== "string") throw new Error("Agent name must be text");
	const trimmed = name.trim();
	if (!trimmed || trimmed.length > MAX_NAME || hasControlChars(trimmed)) {
		throw new Error(`Agent name must be 1-${MAX_NAME} printable characters`);
	}
	return trimmed;
}

function validateCommand(command: unknown): string[] {
	if (!Array.isArray(command) || command.length === 0)
		throw new Error("Command must be a non-empty list of arguments");
	if (command.length > MAX_ARGS) throw new Error(`Command has more than ${MAX_ARGS} arguments`);
	const argv: string[] = [];
	for (const arg of command) {
		if (typeof arg !== "string") throw new Error("Command arguments must be text");
		if (arg.length > MAX_ARG_LEN) throw new Error(`Command arguments are limited to ${MAX_ARG_LEN} characters`);
		if (arg.includes("\0")) throw new Error("Command arguments cannot contain NUL");
		argv.push(arg);
	}
	const [exe] = argv;
	if (path.isAbsolute(exe)) {
		if (hasControlChars(exe) || path.normalize(exe) !== exe || exe.split("/").includes("..")) {
			throw new Error("Command path must be a plain absolute path");
		}
	} else if (!COMMAND_NAME_RE.test(exe) || exe.startsWith("-")) {
		throw new Error("Command must be an absolute path or a program name on PATH (no shell syntax)");
	}
	return argv;
}

function validateEnv(env: unknown): Record<string, string> {
	if (env === undefined || env === null) return {};
	if (typeof env !== "object" || Array.isArray(env)) throw new Error("Environment must be an object of text values");
	const entries = Object.entries(env);
	if (entries.length > MAX_ENV_ENTRIES) throw new Error(`Environment has more than ${MAX_ENV_ENTRIES} variables`);
	const out: Record<string, string> = {};
	for (const [key, value] of entries) {
		if (key.length > MAX_ENV_KEY || !ENV_KEY_RE.test(key))
			throw new Error(`Invalid variable name: ${key.slice(0, 40)}`);
		if (Object.hasOwn(RESERVED_ENV, key) || RESERVED_ENV_PREFIXES.some(prefix => key.startsWith(prefix))) {
			throw new Error(`${key} cannot be overridden`);
		}
		if (typeof value !== "string" || value.length > MAX_ENV_VALUE || value.includes("\0")) {
			throw new Error(`Invalid value for ${key}`);
		}
		out[key] = value;
	}
	return out;
}

function slugFor(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32)
		.replace(/-+$/g, "");
	return slug || "agent";
}

function sanitizeEntry(raw: unknown): CustomEntry | null {
	if (!raw || typeof raw !== "object" || !("id" in raw) || typeof raw.id !== "string" || !CUSTOM_ID_RE.test(raw.id)) {
		return null;
	}
	try {
		return {
			id: raw.id,
			name: validateName("name" in raw ? raw.name : undefined),
			command: validateCommand("command" in raw ? raw.command : undefined),
			env: validateEnv("env" in raw ? raw.env : undefined),
		};
	} catch {
		return null;
	}
}

async function readCustom(configDir: string): Promise<CustomEntry[]> {
	let raw: unknown;
	try {
		raw = JSON.parse(await fs.readFile(customFile(configDir), "utf8"));
	} catch {
		return [];
	}
	const list = raw && typeof raw === "object" && "agents" in raw ? raw.agents : undefined;
	if (!Array.isArray(list)) return [];
	const seen = new Set<string>();
	const entries: CustomEntry[] = [];
	for (const item of list.slice(0, MAX_CUSTOM_AGENTS)) {
		const entry = sanitizeEntry(item);
		if (entry && !seen.has(entry.id)) {
			seen.add(entry.id);
			entries.push(entry);
		}
	}
	return entries;
}

async function writeCustom(configDir: string, entries: CustomEntry[]): Promise<void> {
	const file = customFile(configDir);
	await fs.mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await fs.writeFile(tmp, `${JSON.stringify({ version: 1, agents: entries }, null, "\t")}\n`, { mode: 0o600 });
		await fs.rename(tmp, file);
	} catch (error) {
		await fs.rm(tmp, { force: true });
		throw error;
	}
	await fs.chmod(file, 0o600);
}

/** Creates or updates a custom ACP command; returns the refreshed list. */
export function saveCustomAgent(input: CustomAgentInput, opts: AgentsOpts): Promise<AgentInfo[]> {
	return serialised(async () => {
		const name = validateName(input?.name);
		const command = validateCommand(input?.command);
		const env = validateEnv(input?.env);
		const entries = await readCustom(opts.configDir);
		let id = input.id;
		if (id !== undefined) {
			if (typeof id !== "string" || !CUSTOM_ID_RE.test(id))
				throw new Error("Custom agent ids look like custom:my-agent");
		} else {
			const base = slugFor(name);
			let slug = base;
			for (let n = 2; entries.some(e => e.id === `custom:${slug}`); n++) {
				slug = `${base.slice(0, 32 - String(n).length - 1)}-${n}`;
			}
			id = `custom:${slug}`;
		}
		const index = entries.findIndex(e => e.id === id);
		if (index === -1 && entries.length >= MAX_CUSTOM_AGENTS) {
			throw new Error(`At most ${MAX_CUSTOM_AGENTS} custom agents are supported`);
		}
		const entry: CustomEntry = { id, name, command, env };
		if (index === -1) entries.push(entry);
		else entries[index] = entry;
		await writeCustom(opts.configDir, entries);
		invalidate(opts.configDir);
		return listAgents({ ...opts, refresh: true });
	});
}

/** Removes a custom ACP command; deleting an unknown id is a no-op. Returns the refreshed list. */
export function deleteCustomAgent(id: string, opts: AgentsOpts): Promise<AgentInfo[]> {
	return serialised(async () => {
		if (typeof id !== "string" || !CUSTOM_ID_RE.test(id)) throw new Error("Only custom agents can be deleted");
		const entries = await readCustom(opts.configDir);
		const kept = entries.filter(e => e.id !== id);
		if (kept.length !== entries.length) await writeCustom(opts.configDir, kept);
		invalidate(opts.configDir);
		return listAgents({ ...opts, refresh: true });
	});
}

// --- Detection --------------------------------------------------------------------------------

const cache = new Map<string, { at: number; value: Promise<AgentInfo[]> }>();

function invalidate(configDir: string): void {
	cache.delete(configDir);
}

async function detectBuiltin(d: Descriptor, opts: AgentsOpts, pathValue: string): Promise<AgentInfo> {
	const bin = await findBin(d, pathValue);
	const env = allowlistedEnv(pathValue, d.passEnv);
	let cliVersion: string | null = null;
	let error: string | undefined;
	if (bin) {
		for (const args of d.versionArgs) {
			const res = await run([bin, ...args], env, VERSION_TIMEOUT_MS);
			cliVersion = parseVersion(`${res.out}\n${res.err}`);
			if (cliVersion) break;
		}
		if (!cliVersion) error = "Could not read the version";
	}
	let installed = bin !== null;
	let installable = false;
	let version = cliVersion;
	if (d.adapter) {
		const adapterV = await adapterVersion(d.id, opts);
		const script = adapterV ? await adapterScript(opts.configDir, d.id, d.adapter) : null;
		installed = script !== null && bunBin(pathValue) !== null;
		installable = adapterV !== d.adapter.version && bunBin(pathValue) !== null;
		version = cliVersion ?? adapterV;
		if (!installed) error = "ACP adapter not installed";
		else if (adapterV !== d.adapter.version) error = `Adapter ${adapterV} is not the pinned ${d.adapter.version}`;
	}
	const auth = bin ? await d.auth(bin, env) : "unknown";
	const info: AgentInfo = {
		id: d.id,
		name: d.name,
		kind: "builtin",
		installed,
		version,
		auth,
		installable,
		installCommand: d.installCommand,
		loginCommand: d.loginCommand,
	};
	if (d.models) info.models = d.models;
	if (error) info.error = error;
	return info;
}

async function detectCustom(entry: CustomEntry, pathValue: string): Promise<AgentInfo> {
	const [exe] = entry.command;
	const resolved = path.isAbsolute(exe) ? ((await Bun.file(exe).exists()) ? exe : null) : which(exe, pathValue);
	const info: AgentInfo = {
		id: entry.id,
		name: entry.name,
		kind: "custom",
		installed: resolved !== null,
		version: null,
		auth: "unknown",
		installable: false,
		installCommand: null,
		loginCommand: null,
		command: entry.command,
		env: entry.env,
	};
	if (!resolved) info.error = `${exe} was not found`;
	return info;
}

/** Spawns the agent and sends ACP `initialize` only; reports why it failed, or null when it answered. */
async function handshake(id: string, opts: AgentsOpts): Promise<string | null> {
	let spec: LaunchSpec;
	try {
		spec = await launchSpec(id, { ...opts, cwd: os.tmpdir(), permission: "supervised" });
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
	try {
		proc = Bun.spawn(spec.command, { cwd: spec.cwd, env: spec.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	const stderr = readCapped(proc.stderr);
	const timer = setTimeout(() => proc.kill("SIGKILL"), HANDSHAKE_TIMEOUT_MS);
	try {
		proc.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "omp-collab", version: "1" } } })}\n`,
		);
		await proc.stdin.flush();
		const reader = proc.stdout.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (!line.startsWith("{")) continue;
				let message: unknown;
				try {
					message = JSON.parse(line);
				} catch {
					continue;
				}
				if (!message || typeof message !== "object" || !("id" in message) || message.id !== 1) continue;
				if ("result" in message && message.result) return null;
				const failure =
					"error" in message && message.error && typeof message.error === "object" && "message" in message.error
						? message.error.message
						: null;
				return `ACP initialize failed: ${String(failure ?? "unknown error").slice(0, 200)}`;
			}
			if (buffer.length > MAX_PROBE_BYTES) buffer = "";
		}
		const tail = (await stderr).trim().split("\n").pop() ?? "";
		return `The agent exited before answering ACP initialize${tail ? `: ${tail.slice(0, 200)}` : ""}`;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	} finally {
		clearTimeout(timer);
		proc.kill("SIGKILL");
	}
}

async function detectAll(opts: AgentsOpts & { handshake?: boolean }): Promise<AgentInfo[]> {
	const pathValue = await searchPath(opts);
	const [builtins, customEntries] = await Promise.all([
		Promise.all(BUILTINS.map(d => detectBuiltin(d, opts, pathValue))),
		readCustom(opts.configDir),
	]);
	const customs = await Promise.all(customEntries.map(entry => detectCustom(entry, pathValue)));
	const all = [...builtins, ...customs];
	if (opts.handshake) {
		await Promise.all(
			all
				.filter(info => info.installed)
				.map(async info => {
					const failure = await handshake(info.id, opts);
					if (failure) info.error = failure;
				}),
		);
	}
	return all;
}

/**
 * Every built-in agent then every custom one, cached for 60 s per config dir; `refresh` skips the cache.
 * `handshake` also runs an ACP `initialize` against each installed agent (and is never cached).
 */
export function listAgents(opts: AgentsOpts & { refresh?: boolean; handshake?: boolean }): Promise<AgentInfo[]> {
	if (opts.handshake) return detectAll(opts);
	const hit = cache.get(opts.configDir);
	if (!opts.refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
	const value = detectAll(opts);
	const entry = { at: Date.now(), value };
	cache.set(opts.configDir, entry);
	value.catch(() => {
		if (cache.get(opts.configDir) === entry) cache.delete(opts.configDir);
	});
	return value;
}

// --- Install ----------------------------------------------------------------------------------

/**
 * Installs (or moves to the pinned version of) the ACP adapter for `id` into `<config>/agent/collab-agents/<id>/`,
 * one install at a time, from the manifest and lockfile shipped with the companion: `bun install --frozen-lockfile
 * --ignore-scripts` fails rather than resolve anything the lockfile does not name. Returns the refreshed list.
 */
export function installAgent(id: string, opts: AgentsOpts): Promise<AgentInfo[]> {
	return serialised(async () => {
		const pin = builtin(id)?.adapter;
		if (!pin) throw new Error(`${id} has no adapter the companion can install`);
		if ((await adapterVersion(id, opts)) !== pin.version) {
			const pathValue = await searchPath(opts);
			const bun = bunBin(pathValue);
			if (!bun) throw new Error("Installing needs bun on this computer");
			const dir = adapterRoot(opts.configDir, id);
			await fs.mkdir(dir, { recursive: true });
			for (const file of ["package.json", "bun.lock"]) {
				await fs.copyFile(path.join(adapterSource(id), file), path.join(dir, file));
			}
			const spec = `${pin.pkg}@${pin.version}`;
			const command = [bun, "install", "--frozen-lockfile", "--ignore-scripts", "--no-progress"];
			const res = await run(command, { ...allowlistedEnv(pathValue, []), NO_COLOR: "1" }, INSTALL_TIMEOUT_MS, dir);
			if (res.timedOut) throw new Error(`Installing ${spec} timed out`);
			if (res.code !== 0) {
				const tail = `${res.err}\n${res.out}`.trim().split("\n").slice(-4).join("\n");
				throw new Error(`Installing ${spec} failed: ${tail.slice(0, 600)}`);
			}
			if ((await adapterVersion(id, opts)) !== pin.version)
				throw new Error(`${spec} installed but the version does not match`);
		}
		invalidate(opts.configDir);
		return listAgents({ ...opts, refresh: true });
	});
}

// --- Launch -----------------------------------------------------------------------------------

/**
 * Command, environment and cwd for the agent's ACP server. The environment is allowlisted (see the
 * file header); `model` is the vendor's own model id and must look like one.
 *
 */
export async function launchSpec(id: string, opts: LaunchOpts): Promise<LaunchSpec> {
	if (opts.permission !== "supervised" && opts.permission !== "full")
		throw new Error("Permission must be supervised or full");
	if (opts.model !== undefined && (!MODEL_RE.test(opts.model) || opts.model.startsWith("-"))) {
		throw new Error("Invalid model id");
	}
	const d = builtin(id);
	if (d) {
		const pathValue = await searchPath(opts);
		const bin = await findBin(d, pathValue);
		let adapter: string[] | null = null;
		if (d.adapter) {
			const script = await adapterScript(opts.configDir, d.id, d.adapter);
			const bun = bunBin(pathValue);
			if (script && bun) adapter = [bun, script];
		}
		const launch = d.launch({
			bin,
			adapter,
			permission: opts.permission,
			model: opts.model,
		});
		const binDir = bin ? [path.dirname(bin)] : [];
		const env = { ...allowlistedEnv(await searchPath(opts, binDir), d.passEnv), ...launch.env };
		return { command: launch.command, env, cwd: opts.cwd };
	}
	if (!CUSTOM_ID_RE.test(id)) throw new Error(`Unknown agent: ${id}`);
	const entry = (await readCustom(opts.configDir)).find(e => e.id === id);
	if (!entry) throw new Error(`Unknown agent: ${id}`);
	const pathValue = await searchPath(opts);
	const [exe, ...args] = entry.command;
	const resolved = path.isAbsolute(exe) ? exe : which(exe, pathValue);
	if (!resolved) throw new Error(`${exe} was not found`);
	return { command: [resolved, ...args], env: { ...allowlistedEnv(pathValue, []), ...entry.env }, cwd: opts.cwd };
}
