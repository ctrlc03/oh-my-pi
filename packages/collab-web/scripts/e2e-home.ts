/**
 * A throwaway HOME for running the real companion and the real `omp` against the stub model (./stub-model) without
 * credentials, network or any touch of the user's own `~/.omp`:
 *
 * - `<root>/home/.omp/agent/models.yml`: a custom provider `stub` (Chat Completions at the stub's URL) with one model,
 *   priced like {@link STUB_PRICING} so a call has a real cost for `--max-cost`;
 * - `<root>/home/.omp/agent/config.yml`: `default` and `smol` roles (so `--model @smol` and the default model both
 *   resolve to the stub), only that model enabled, update checks off;
 * - `<root>/bin/tmux`: wrapper that execs the real tmux on a private socket (`tmux -L <socket>`), first on PATH, so the
 *   companion's `findTmux()` (`Bun.which("tmux")` first) and every `tmux` it runs land on the private server;
 * - `<root>/bin/omp`: wrapper that runs this checkout's `packages/coding-agent/src/cli.ts` with bun (`OMP_BIN`).
 *
 * The returned `env` is complete (not merged with `process.env`): pass it as `env` to `Bun.spawn` for the companion or
 * for a headless omp run. HTTP(S)_PROXY point at a closed port (loopback excluded), so any attempt to reach the real
 * internet fails at once instead of silently working.
 *
 * ```ts
 * const stub = startStubModel({ responder });
 * const e2e = await createE2eHome({ stubUrl: stub.url });
 * Bun.spawn([e2e.ompBin, "-p", "--no-session", "--no-tools", "--model", "@smol", "hi"], { env: e2e.env });
 * await e2e.cleanup();
 * ```
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { STUB_MODEL_ID, STUB_PRICING } from "./stub-model";

/** Provider id in `models.yml`; the model selector is `stub/stub-model`. */
export const STUB_PROVIDER = "stub";
export const STUB_SELECTOR = `${STUB_PROVIDER}/${STUB_MODEL_ID}`;

/** This checkout's omp entry point (an executable with a `#!/usr/bin/env bun` shebang). */
const CHECKOUT_OMP = path.resolve(import.meta.dir, "../../coding-agent/src/cli.ts");

export interface E2eHomeOptions {
	/** The stub's `baseUrl` (`StubServer.url`). */
	stubUrl: string;
	/** Parent folder of everything created; default: a fresh `omp-e2e-*` folder in the OS temp dir (removed by `cleanup`). */
	root?: string;
	/** The omp the companion and the helpers run. Default: this checkout's `cli.ts` through a wrapper script. */
	ompBin?: string;
	/** `collab.relayUrl` written to `config.yml`; unset keeps omp's public relay, which the proxy guard makes unreachable. */
	relayUrl?: string;
	/** Port of `collab.localRelayUrl`; default: a free one. Never 7467, the companion's own default. */
	localRelayPort?: number;
	/** Extra `config.yml` YAML appended after the generated lines (top-level keys other than `modelRoles`, `enabledModels`, `startup`, `collab`). */
	configYaml?: string;
}

export interface PrivateTmux {
	/** The `-L` socket name. */
	socket: string;
	/** The real tmux binary. */
	real: string;
	/** Run tmux on the private socket. */
	run(args: string[]): Promise<{ code: number; out: string; err: string }>;
	/** Names of the sessions on the private server (empty when no server runs). */
	sessions(): Promise<string[]>;
	/** The visible screen and scrollback of a session. */
	capture(session: string): Promise<string>;
	/** Type `text` and press Enter in a session. */
	send(session: string, text: string): Promise<void>;
	/** Stop the private server and every session on it. */
	killServer(): Promise<void>;
}

export interface E2eHome {
	root: string;
	/** `HOME` of everything run with {@link env}. */
	home: string;
	/** `<home>/.omp`: what the companion computes from `os.homedir()` and an unset `PI_CONFIG_DIR`. */
	configDir: string;
	/** `<configDir>/agent`: where omp keeps `models.yml` and `config.yml`. */
	agentDir: string;
	/** Single executable path for `OMP_BIN`. */
	ompBin: string;
	/** The port `collab.localRelayUrl` names in `config.yml`. */
	localRelayPort: number;
	/** The wrapper that runs tmux on the private socket (also first on `env.PATH`). */
	tmuxBin: string;
	tmux: PrivateTmux;
	/** Complete environment for a spawned companion or omp: HOME, PATH, OMP_BIN, proxy guards. */
	env: Record<string, string>;
	/** Stop the private tmux server and delete what was created. */
	cleanup(): Promise<void>;
}

/** `models.yml` for the stub provider. Prices are {@link STUB_PRICING}. */
export function modelsYml(stubUrl: string): string {
	return `providers:
  ${STUB_PROVIDER}:
    baseUrl: ${JSON.stringify(stubUrl)}
    apiKey: stub-key
    api: openai-completions
    models:
      - id: ${STUB_MODEL_ID}
        name: Stub model
        reasoning: false
        input: [text]
        cost:
          input: ${STUB_PRICING.inputPerMTok}
          output: ${STUB_PRICING.outputPerMTok}
          cacheRead: 0
          cacheWrite: 0
        contextWindow: 200000
        maxTokens: 16384
`;
}

/** What `configYml` writes besides the model roles. */
export interface ConfigYmlOptions {
	/** `collab.localRelayUrl` port: the companion's local relay prefers it (its own default is 7467, which a real companion may hold). */
	localRelayPort: number;
	/** `collab.relayUrl`: the relay sessions and the companion join (default: omp's public one, unreachable here). */
	relayUrl?: string;
	/** Extra YAML appended as is. */
	extra?: string;
}

/** `config.yml`: every model role on the stub, nothing else enabled, no update check, the local relay on a private port. */
export function configYml(options: ConfigYmlOptions): string {
	return `modelRoles:
  default: ${STUB_SELECTOR}
  smol: ${STUB_SELECTOR}
  slow: ${STUB_SELECTOR}
  plan: ${STUB_SELECTOR}
  task: ${STUB_SELECTOR}
enabledModels:
  - ${STUB_SELECTOR}
startup:
  checkUpdate: false
  setupWizard: false
  changelogMode: hidden
collab:
  localRelayUrl: ${JSON.stringify(`ws://127.0.0.1:${options.localRelayPort}`)}
${options.relayUrl === undefined ? "" : `  relayUrl: ${JSON.stringify(options.relayUrl)}\n`}${options.extra ?? ""}`;
}

/** A port nothing listens on right now (best effort: it is released before it is returned). */
async function freePort(): Promise<number> {
	const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
	const port = probe.port;
	probe.stop(true);
	return port;
}

/** Shell wrapper that runs `real` on the private socket; `TMUX` is cleared so a nested run never targets the caller's server. */
export function tmuxWrapper(real: string, socket: string): string {
	return `#!/bin/sh\nunset TMUX\nexec ${shellQuote(real)} -L ${shellQuote(socket)} "$@"\n`;
}

/** Shell wrapper that runs omp from source (`bun <cli.ts>`); `$0`-independent so it can sit anywhere. */
export function ompWrapper(cli: string): string {
	return `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cli)} "$@"\n`;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function runProcess(
	argv: string[],
	env: Record<string, string>,
): Promise<{ code: number; out: string; err: string }> {
	const proc = Bun.spawn(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, out, err };
}

function directoryOf(binary: string | null): string[] {
	return binary === null ? [] : [path.dirname(binary)];
}

/** Create the temp HOME. Throws when tmux is not installed. */
export async function createE2eHome(options: E2eHomeOptions): Promise<E2eHome> {
	const created = options.root === undefined;
	// omp resolves symlinks before matching path rules, so everything is created under the real path (`/tmp` and the
	// macOS temp dir are symlinks into `/private`).
	const requested = options.root ?? path.join(os.tmpdir(), `omp-e2e-${crypto.randomUUID().slice(0, 8)}`);
	await fs.mkdir(requested, { recursive: true });
	const root = await fs.realpath(requested);
	const home = path.join(root, "home");
	const configDir = path.join(home, ".omp");
	const agentDir = path.join(configDir, "agent");
	const binDir = path.join(root, "bin");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(binDir, { recursive: true });
	await Bun.write(path.join(agentDir, "models.yml"), modelsYml(options.stubUrl));
	const localRelayPort = options.localRelayPort ?? (await freePort());
	await Bun.write(
		path.join(agentDir, "config.yml"),
		configYml({ localRelayPort, relayUrl: options.relayUrl, extra: options.configYaml }),
	);

	const realTmux =
		Bun.which("tmux") ??
		["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].find(p => Bun.file(p).size > 0);
	if (realTmux === undefined) throw new Error("tmux is not installed");
	const socket = `omp-e2e-${crypto.randomUUID().slice(0, 8)}`;
	const tmuxBin = path.join(binDir, "tmux");
	await Bun.write(tmuxBin, tmuxWrapper(realTmux, socket));
	await fs.chmod(tmuxBin, 0o755);

	let ompBin = options.ompBin;
	if (ompBin === undefined) {
		ompBin = path.join(binDir, "omp");
		await Bun.write(ompBin, ompWrapper(CHECKOUT_OMP));
		await fs.chmod(ompBin, 0o755);
	}

	const toolDirs = [
		binDir,
		...directoryOf(process.execPath),
		...directoryOf(Bun.which("git")),
		...directoryOf(Bun.which("gh")),
		"/usr/bin",
		"/bin",
	];
	const env: Record<string, string> = {
		HOME: home,
		PATH: [...new Set(toolDirs)].join(path.delimiter),
		OMP_BIN: ompBin,
		TERM: "xterm-256color",
		LANG: "en_US.UTF-8",
		TMPDIR: process.env.TMPDIR ?? "/tmp",
		// Anything that tries the real network fails at once; the stub (127.0.0.1) is exempt.
		HTTP_PROXY: "http://127.0.0.1:1",
		HTTPS_PROXY: "http://127.0.0.1:1",
		NO_PROXY: "127.0.0.1,localhost",
		PI_NO_TITLE: "1",
	};

	const tmuxEnv = { ...env };
	const tmuxRun = (args: string[]) => runProcess([tmuxBin, ...args], tmuxEnv);
	const tmux: PrivateTmux = {
		socket,
		real: realTmux,
		run: tmuxRun,
		async sessions() {
			const result = await tmuxRun(["list-sessions", "-F", "#{session_name}"]);
			return result.code === 0 ? result.out.split("\n").filter(line => line !== "") : [];
		},
		async capture(session) {
			return (await tmuxRun(["capture-pane", "-p", "-J", "-S", "-", "-t", `=${session}:`])).out;
		},
		async send(session, text) {
			await tmuxRun(["send-keys", "-t", `=${session}:`, "-l", text]);
			await tmuxRun(["send-keys", "-t", `=${session}:`, "Enter"]);
		},
		async killServer() {
			await tmuxRun(["kill-server"]);
		},
	};

	return {
		root,
		home,
		configDir,
		localRelayPort,
		agentDir,
		ompBin,
		tmuxBin,
		tmux,
		env,
		async cleanup() {
			await tmux.killServer();
			// tmux leaves the (dead) socket file behind: `<TMUX_TMPDIR or /tmp>/tmux-<uid>/<socket>`.
			const socketDir = path.join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${process.getuid?.() ?? 0}`);
			await fs.rm(path.join(socketDir, socket), { force: true });
			await fs.rm(created ? root : home, { recursive: true, force: true });
		},
	};
}
