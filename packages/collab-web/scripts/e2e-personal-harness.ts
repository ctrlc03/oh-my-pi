/**
 * End-to-end harness for the Personal agent: the real companion (`scripts/companion.ts`) and real omp sessions
 * (`packages/coding-agent/src/cli.ts`) in a throw-away home directory, against a scripted model
 * (`./e2e-personal-stub`). Nothing here touches the real setup:
 *
 * - `HOME` is a fresh temp directory and `PI_CONFIG_DIR=.omp` lives inside it, so every file the companion and omp write
 *   is under it;
 * - sessions run in tmux on a private socket (`tmux -L omp-personal-e2e-<random>`, reached through a `tmux` wrapper first on
 *   `PATH`, because the companion starts tmux by name), with `TMUX` removed from the environment;
 * - the relay is in this process on a port the operating system picks, and `collab.localRelayUrl` names another one, so the
 *   default 7467 is never bound;
 * - a login is a `models.yml` entry for the stub with `auth: none`; no credential exists anywhere;
 * - nothing is killed by pattern: the harness stops the process it started, its descendants (checked by command line) and
 *   its private tmux server.
 *
 * The device is the app's own `CompanionClient` (and `GuestClient` for a session's room), paired the way a phone is.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { PersonalAnswer, PersonalCall, PersonalSettingsPatch, PersonalStatus } from "@oh-my-pi/pi-wire/personal";
import { GuestClient } from "../src/lib/client";
import { CompanionClient, type CompanionHost, extractPairing } from "../src/lib/companion";
import {
	type StubModel,
	type StubRequest,
	type StubToolCall,
	startStubModel,
	stubModelsYml,
	toolResultsSince,
} from "./e2e-personal-stub";
import type { NotifyOwnerInput } from "@oh-my-pi/pi-wire/personal-ipc";
import { startLocalRelay, type LocalRelay } from "./local-relay";

const REPO = path.resolve(import.meta.dir, "..", "..", "..");
const COMPANION = path.join(REPO, "packages", "collab-web", "scripts", "companion.ts");
const OMP_CLI = path.join(REPO, "packages", "coding-agent", "src", "cli.ts");
/** Preloaded into the companion and every omp: moves their clock by the offset in `$HOME/.e2e-clock-offset-ms`. */
const CLOCK_PRELOAD = path.join(import.meta.dir, "e2e-personal-clock.ts");
const SYSTEM_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/** Thrown from a `until` probe to stop waiting at once. */
class FatalWait extends Error {}

/** Poll `pick` until it returns a value. */
export async function until<T>(
	label: string,
	pick: () => T | undefined | null | false | Promise<T | undefined | null | false>,
	options: { timeoutMs?: number; everyMs?: number } = {},
): Promise<T> {
	const deadline = Date.now() + (options.timeoutMs ?? 30_000);
	let last: unknown;
	for (;;) {
		try {
			const value = await pick();
			if (value !== undefined && value !== null && value !== false) return value;
		} catch (err) {
			if (err instanceof FatalWait) throw new Error(err.message);
			last = err;
		}
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for ${label}${last === undefined ? "" : `: ${String(last)}`}`);
		}
		await Bun.sleep(options.everyMs ?? 100);
	}
}

async function freePort(): Promise<number> {
	const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
	const port = probe.port ?? 0;
	probe.stop(true);
	return port;
}

async function readText(file: string): Promise<string> {
	return await Bun.file(file)
		.text()
		.catch(() => "");
}

/** `ps` rows: pid, ppid, command. */
async function processTable(): Promise<Array<{ pid: number; ppid: number; command: string }>> {
	const proc = Bun.spawn(["ps", "-axo", "pid=,ppid=,command="], { stdout: "pipe", stderr: "ignore" });
	const text = await new Response(proc.stdout).text();
	await proc.exited;
	const rows: Array<{ pid: number; ppid: number; command: string }> = [];
	for (const line of text.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
		if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! });
	}
	return rows;
}

export interface HarnessOptions {
	/** Price of the stub model in USD per million tokens (input and output); 0 = free. */
	usdPerMillionTokens?: number;
	/** Extra YAML appended to the default (non-profile) config. */
	defaultConfigYaml?: string;
}

export interface PushCapture {
	at: number;
	/** The endpoint path the push went to. */
	path: string;
	bytes: number;
}

export class PersonalHarness {
	readonly home: string;
	/** `<home>/.omp`, the config root `C`. */
	readonly configDir: string;
	/** `C/profiles/personal`, the profile `P`. */
	readonly profile: string;
	/** `P/agent`. */
	readonly agentDir: string;
	readonly stub: StubModel;
	readonly relay: LocalRelay;
	readonly client: CompanionClient;
	/** Web Pushes the companion sent to the device's subscription. */
	readonly pushes: PushCapture[] = [];
	readonly tmuxSocket: string;
	readonly binDir: string;
	readonly #companion: Bun.Subprocess;
	readonly #pushServer: Bun.Server<undefined> | null;
	readonly #guests: GuestClient[] = [];
	readonly #usdPerMillionTokens: number;
	#stopped = false;
	#clockOffsetMs = 0;

	private constructor(init: {
		home: string;
		stub: StubModel;
		relay: LocalRelay;
		client: CompanionClient;
		tmuxSocket: string;
		binDir: string;
		companion: Bun.Subprocess;
		pushServer: Bun.Server<undefined> | null;
		usdPerMillionTokens: number;
	}) {
		this.home = init.home;
		this.configDir = path.join(init.home, ".omp");
		this.profile = path.join(this.configDir, "profiles", "personal");
		this.agentDir = path.join(this.profile, "agent");
		this.stub = init.stub;
		this.relay = init.relay;
		this.client = init.client;
		this.tmuxSocket = init.tmuxSocket;
		this.binDir = init.binDir;
		this.#companion = init.companion;
		this.#pushServer = init.pushServer;
		this.#usdPerMillionTokens = init.usdPerMillionTokens;
	}

	/** Environment of a process that runs in this harness's home: what the companion and every omp it starts get. */
	static envFor(home: string, binDir: string, extra: Record<string, string> = {}): Record<string, string> {
		return {
			HOME: home,
			PI_CONFIG_DIR: ".omp",
			PATH: [binDir, path.dirname(process.execPath), ...SYSTEM_PATH].join(":"),
			OMP_BIN: path.join(binDir, "omp"),
			NODE_TLS_REJECT_UNAUTHORIZED: "0",
			...extra,
		};
	}

	/** Start a companion in a fresh home, paired with a device. `options.home` reuses a directory (a restart). */
	static async start(options: HarnessOptions & { home?: string; tmuxSocket?: string } = {}): Promise<PersonalHarness> {
		const home = options.home ?? (await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-personal-e2e-"))));
		const binDir = path.join(home, "bin");
		const tmuxSocket = options.tmuxSocket ?? `omp-personal-e2e-${crypto.randomUUID().slice(0, 8)}`;
		await fs.mkdir(binDir, { recursive: true });
		const realTmux = Bun.which("tmux", { PATH: SYSTEM_PATH.join(":") });
		if (!realTmux) throw new Error("tmux is not installed");
		await Bun.write(
			path.join(binDir, "omp"),
			`#!/bin/sh\nexec "${process.execPath}" --preload "${CLOCK_PRELOAD}" "${OMP_CLI}" "$@"\n`,
		);
		await Bun.write(path.join(binDir, "tmux"), `#!/bin/sh\nexec "${realTmux}" -L ${tmuxSocket} "$@"\n`);
		await fs.chmod(path.join(binDir, "omp"), 0o755);
		await fs.chmod(path.join(binDir, "tmux"), 0o755);

		const stub = startStubModel();
		const relay = startLocalRelay(0);
		const localRelayPort = await freePort();
		const configDir = path.join(home, ".omp");
		await fs.mkdir(path.join(configDir, "agent"), { recursive: true });
		await Bun.write(
			path.join(configDir, "agent", "config.yml"),
			[
				"collab:",
				`  relayUrl: ${relay.url}`,
				`  localRelayUrl: ws://127.0.0.1:${localRelayPort}`,
				`  webUrl: http://127.0.0.1:${localRelayPort}/`,
				"  autoHost: false",
				options.defaultConfigYaml ?? "",
				"",
			].join("\n"),
		);

		const pushServer = await startPushServer(home);
		const logs = { out: path.join(home, "companion.out.log"), err: path.join(home, "companion.err.log") };
		const companion = Bun.spawn([process.execPath, "--preload", CLOCK_PRELOAD, COMPANION, "--no-local-app"], {
			cwd: path.join(REPO, "packages", "collab-web"),
			env: PersonalHarness.envFor(home, binDir),
			stdout: Bun.file(logs.out),
			stderr: Bun.file(logs.err),
			stdin: "ignore",
		});

		try {
			const pairing = await until(
				"the companion's pairing link",
				async () => extractPairing(await readText(logs.out)),
				{ timeoutMs: 90_000, everyMs: 250 },
			);
			// A device that joins before the companion's room exists is told so and does not retry: wait for the room.
			await until(
				"the companion's room",
				async () => (await readText(logs.out)).includes("room open on the public relay"),
				{
					timeoutMs: 60_000,
					everyMs: 250,
				},
			);
			const client = new CompanionClient(pairing, () => {});
			client.connect();
			await until("the device to be served", () => client.getSnapshot().phase === "live", {
				timeoutMs: 60_000,
			}).catch(err => {
				const { phase, error } = client.getSnapshot();
				throw new Error(`${String(err)} (phase ${phase}, ${error ?? "no error"})`);
			});

			const harness = new PersonalHarness({
				home,
				stub,
				relay,
				client,
				tmuxSocket,
				binDir,
				companion,
				pushServer: pushServer?.server ?? null,
				usdPerMillionTokens: options.usdPerMillionTokens ?? 0,
			});
			pushServer?.attach(harness.pushes);
			if (pushServer) await client.setPush(pushServer.subscription, true);
			return harness;
		} catch (err) {
			const log = `${await readText(logs.out)}\n${await readText(logs.err)}`.slice(-2_000);
			companion.kill("SIGTERM");
			stub.stop();
			relay.stop();
			pushServer?.server.stop(true);
			await fs.rm(home, { recursive: true, force: true });
			throw new Error(`${String(err)}\ncompanion log (tail):\n${log}`);
		}
	}

	/** `personal-*` request to the companion. */
	async call<C extends PersonalCall>(call: C, timeoutMs = 30_000): Promise<PersonalAnswer<C["t"]>> {
		return await this.client.requestPersonal(call, timeoutMs);
	}

	async status(): Promise<PersonalStatus> {
		return (await this.call({ t: "personal-status" })).status;
	}

	/** The host row of the Personal session, once the companion lists it. */
	personalHost(): CompanionHost | undefined {
		return this.client.getSnapshot().hosts.find(host => host.personal === true);
	}

	/** Write the profile's `models.yml` (the owner's file), which is what makes the login `ready`. */
	async writeModels(): Promise<void> {
		await Bun.write(path.join(this.agentDir, "models.yml"), stubModelsYml(this.stub, this.#usdPerMillionTokens));
	}

	/**
	 * Set up the profile (applying `patch` to its settings first), make the stub the profile's model and its default, and wait until the companion reads the login as
	 * ready. The companion starts the session by itself once it is enabled and a login exists; `waitIdle` waits for that.
	 */
	async setUp(about?: string, patch?: PersonalSettingsPatch): Promise<PersonalStatus> {
		const status = (await this.call({ t: "personal-setup", about })).status;
		// Before the login exists, so the session that starts with it already runs with these settings.
		if (patch !== undefined) await this.call({ t: "personal-settings-set", patch });
		await this.writeModels();
		const defaults = path.join(this.agentDir, "config.yml");
		const current = await readText(defaults);
		if (!current.includes("modelRoles")) {
			await Bun.write(defaults, `${current.trimEnd()}\nmodelRoles:\n  default: stub/stub-model\n`);
		}
		return status;
	}

	/** Wait for the Personal session: run `idle` and a `personal` host row. Returns that row. */
	async waitIdle(timeoutMs = 180_000): Promise<CompanionHost> {
		await until(
			"the Personal session to be idle",
			async () => {
				const status = await this.status();
				if (status.run === "failed") {
					throw new FatalWait(
						`the Personal session failed to start:\n${(await this.companionLog()).slice(-2_500)}`,
					);
				}
				return status.run === "idle" && this.personalHost() !== undefined;
			},
			{ timeoutMs, everyMs: 1_000 },
		);
		return this.personalHost()!;
	}

	/** Open the Personal session's room as a paired device (the app's `GuestClient`) and wait for it to be live. */
	async openSession(host: CompanionHost = this.personalHost()!): Promise<GuestClient> {
		const link = await this.client.requestLink(host.instanceId);
		const guest = new GuestClient(link, "e2e device", null);
		this.#guests.push(guest);
		guest.connect();
		await until("the session room to be live", () => guest.getSnapshot().phase === "live", { timeoutMs: 60_000 });
		return guest;
	}

	/** The event channel under `C/run/personal`. */
	get inboxDir(): string {
		return path.join(this.configDir, "run", "personal", "inbox");
	}

	/** The loopback address and token of the companion's Personal channel (`POST /event`, `POST /personal`). */
	async endpoint(): Promise<{ port: number; token: string }> {
		return JSON.parse(await Bun.file(path.join(this.agentDir, "collab-companion-personal-ipc.json")).text());
	}

	/** `POST /event` the way a script on the computer does it; `token` defaults to the right one. */
	async postEvent(
		body: Record<string, unknown>,
		options: { token?: string } = {},
	): Promise<{ status: number; body: unknown }> {
		const { port, token } = await this.endpoint();
		const response = await fetch(`http://127.0.0.1:${port}/event`, {
			method: "POST",
			headers: { authorization: `Bearer ${options.token ?? token}`, "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		return { status: response.status, body: await response.json().catch(() => null) };
	}

	/** Wait until the session's room reports no turn running (and nothing queued). */
	async settle(guest: GuestClient, timeoutMs = 90_000): Promise<void> {
		await until(
			"the turn to finish",
			() => {
				const snap = guest.getSnapshot();
				return !snap.working && snap.state?.isStreaming !== true && (snap.state?.queuedMessageCount ?? 0) === 0;
			},
			{ timeoutMs, everyMs: 200 },
		);
	}

	/**
	 * Send a prompt as the paired device and wait for the whole turn: the stub sees it, the turn ends, and omp has written the
	 * session file. omp creates the file lazily, with the first assistant message, and the guest reports "not working" for a
	 * moment after `sendPrompt` (before the turn starts): settling alone returns too early, and a session that never took a
	 * turn has nothing to resume. Returns the agent-loop request that carried the prompt.
	 */
	async turn(guest: GuestClient, text: string): Promise<StubRequest> {
		const after = this.stub.requests.at(-1)?.n ?? 0;
		guest.sendPrompt(text);
		const request = await this.stub.waitForRequest(r => r.transcript.includes(text), { after });
		await this.settle(guest);
		await until("omp to write the session file", async () => (await this.sessionFiles()).length > 0, {
			timeoutMs: 30_000,
		});
		return request;
	}

	/**
	 * Script the turn that the prompt `marker` starts: it makes `calls` one after the other (each its own model answer), then
	 * closes with a text; returns the tool results the model was shown, one per call. The Personal profile asks the owner
	 * before a command runs (`tools.approvalMode: write`): `approval` is what this device answers to every such question.
	 */
	async toolsOnPrompt(
		guest: GuestClient,
		marker: string,
		calls: StubToolCall[],
		approval: "Approve" | "Deny" = "Approve",
	): Promise<string[]> {
		const mine = (r: StubRequest) => r.transcript.includes(marker) && !r.lastUser.includes("title-request");
		const results = (r: StubRequest) => toolResultsSince(r, marker);
		calls.forEach((call, step) => {
			this.stub.enqueue({ tools: [call] }, r => mine(r) && results(r).length === step);
		});
		this.stub.enqueue({ text: "Done." }, r => mine(r) && results(r).length === calls.length);
		const after = this.stub.requests.at(-1)?.n ?? 0;
		let turnOver = false;
		const answered = new Set<number>();
		const answerer = (async () => {
			while (!turnOver) {
				const ask = guest.getSnapshot().uiRequest;
				if (
					ask !== null &&
					ask.kind === "select" &&
					ask.title.startsWith("Allow tool") &&
					!answered.has(ask.reqId)
				) {
					answered.add(ask.reqId);
					guest.sendUiResponse(ask.reqId, approval);
				}
				await Bun.sleep(100);
			}
		})();
		try {
			guest.sendPrompt(marker);
			const request = await this.stub.waitForRequest(r => mine(r) && results(r).length === calls.length, {
				after,
				timeoutMs: 120_000,
			});
			await this.settle(guest);
			return results(request);
		} finally {
			turnOver = true;
			await answerer;
		}
	}

	/** Script `notify_owner(item)` for the turn that the prompt `marker` starts; returns that turn's tool results. */
	notifyOnPrompt(guest: GuestClient, marker: string, item: NotifyOwnerInput): Promise<string[]> {
		return this.toolsOnPrompt(guest, marker, [{ name: "notify_owner", args: { ...item } }]);
	}

	/** The session JSONL files of the profile, newest first. */
	async sessionFiles(): Promise<string[]> {
		const dir = path.join(this.agentDir, "sessions");
		const files: Array<{ file: string; mtime: number }> = [];
		const walk = async (current: string): Promise<void> => {
			for (const entry of await fs.readdir(current, { withFileTypes: true }).catch(() => [])) {
				const full = path.join(current, entry.name);
				if (entry.isDirectory()) await walk(full);
				else if (entry.name.endsWith(".jsonl")) files.push({ file: full, mtime: (await fs.stat(full)).mtimeMs });
			}
		};
		await walk(dir);
		return files.sort((a, b) => b.mtime - a.mtime).map(entry => entry.file);
	}

	/** Rows of the profile's Mnemopi bank (read-only, WAL-safe), as plain objects. */
	memoryRows(sql: string, ...params: Array<string | number>): Array<Record<string, unknown>> {
		const db = new Database(path.join(this.agentDir, "memories", "mnemopi", "mnemopi.db"), { readonly: true });
		try {
			return db.query(sql).all(...params) as Array<Record<string, unknown>>;
		} finally {
			db.close();
		}
	}

	/**
	 * Add `count` rows to the working memory, `days` old, as the bank would hold them: for the checks that nothing is trimmed.
	 * The session writes to the same file, so this takes WAL's write lock like any writer and waits for it.
	 */
	seedWorkingRows(count: number, days: number, prefix: string): void {
		const db = new Database(path.join(this.agentDir, "memories", "mnemopi", "mnemopi.db"));
		try {
			db.run("PRAGMA busy_timeout = 15000");
			const stamp = new Date(Date.now() - days * 86_400_000).toISOString();
			const insert = db.prepare(
				"INSERT INTO working_memory (id, content, source, timestamp, session_id, importance, author_id, author_type, trust_tier, scope, created_at) VALUES (?, ?, 'e2e-seed', ?, 'default', 0.5, 'owner', 'owner', 'TRUSTED', 'global', ?)",
			);
			db.transaction(() => {
				for (let i = 0; i < count; i++)
					insert.run(`${prefix}-${i}`, `${prefix} seeded memory number ${i}`, stamp, stamp);
			})();
		} finally {
			db.close();
		}
	}

	/** The clock of the companion and every omp it starts: real time + the offset set so far. */
	clockNow(): number {
		return Date.now() + this.#clockOffsetMs;
	}

	/** Move the clock of the companion and every omp it starts to real time + `offsetMs` (they re-read it within 100 ms). */
	async setClockOffset(offsetMs: number): Promise<void> {
		this.#clockOffsetMs = Math.round(offsetMs);
		await Bun.write(path.join(this.home, ".e2e-clock-offset-ms"), String(this.#clockOffsetMs));
		// The processes re-read the file at most every 100 ms; the companion's own poll is 3 s, so this is only a margin.
		await Bun.sleep(250);
	}

	/**
	 * Move the clock to 00:05 of the next local day and return it. Not a whole 24 h: an event queued a few minutes ago must not
	 * expire (24 h), and the daily rollover (04:00) and backup (03:00) times are not reached unless a test wants them.
	 */
	async advanceToNextDay(): Promise<number> {
		const d = new Date(this.clockNow());
		const target = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 5).getTime();
		await this.setClockOffset(target - Date.now());
		return this.clockNow();
	}

	/** Run tmux on the private socket. */
	async tmux(...args: string[]): Promise<{ code: number; out: string }> {
		const proc = Bun.spawn([path.join(this.binDir, "tmux"), ...args], {
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
			env: { PATH: SYSTEM_PATH.join(":") },
		});
		const out = await new Response(proc.stdout).text();
		return { code: await proc.exited, out };
	}

	companionLog(): Promise<string> {
		return Promise.all([
			readText(path.join(this.home, "companion.out.log")),
			readText(path.join(this.home, "companion.err.log")),
		]).then(([out, err]) => `${out}\n${err}`);
	}

	/** Stop everything this harness started and delete its home. */
	async stop(options: { keepHome?: boolean } = {}): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
		for (const guest of this.#guests) guest.close();
		this.client.close();
		// Our own descendants first (headless runs), verified by command line, then the companion, then its tmux server.
		const table = await processTable();
		const descendants = new Set<number>([this.#companion.pid]);
		for (let grew = true; grew;) {
			grew = false;
			for (const row of table) {
				if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
					descendants.add(row.pid);
					grew = true;
				}
			}
		}
		for (const row of table) {
			if (row.pid !== this.#companion.pid && descendants.has(row.pid) && /cli\.ts|omp/.test(row.command)) {
				try {
					process.kill(row.pid, "SIGTERM");
				} catch {
					// already gone
				}
			}
		}
		this.#companion.kill("SIGTERM");
		await Promise.race([this.#companion.exited, Bun.sleep(5_000)]);
		await this.tmux("kill-server").catch(() => undefined);
		this.stub.stop();
		this.relay.stop();
		this.#pushServer?.stop(true);
		if (!options.keepHome) await fs.rm(this.home, { recursive: true, force: true });
	}
}

interface PushServer {
	server: Bun.Server<undefined>;
	subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
	attach(sink: PushCapture[]): void;
}

/**
 * An HTTPS endpoint (self-signed; the companion runs with `NODE_TLS_REJECT_UNAUTHORIZED=0`) that records the Web Pushes the
 * companion sends to the device's subscription. Null when openssl is missing: pushes are then only checked through the inbox.
 */
async function startPushServer(home: string): Promise<PushServer | null> {
	const key = path.join(home, "push-key.pem");
	const cert = path.join(home, "push-cert.pem");
	const made = Bun.spawn(
		[
			"openssl",
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			key,
			"-out",
			cert,
			"-days",
			"1",
			"-subj",
			"/CN=127.0.0.1",
			"-addext",
			"subjectAltName=IP:127.0.0.1",
		],
		{ stdout: "ignore", stderr: "ignore", stdin: "ignore" },
	);
	if ((await made.exited) !== 0) return null;
	let sink: PushCapture[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		tls: { key: Bun.file(key), cert: Bun.file(cert) },
		async fetch(request) {
			const body = await request.arrayBuffer();
			sink.push({ at: Date.now(), path: new URL(request.url).pathname, bytes: body.byteLength });
			return new Response(null, { status: 201 });
		},
	});
	const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
	const auth = crypto.getRandomValues(new Uint8Array(16));
	return {
		server,
		subscription: {
			endpoint: `https://127.0.0.1:${server.port}/push/e2e-device`,
			keys: { p256dh: Buffer.from(raw).toString("base64url"), auth: Buffer.from(auth).toString("base64url") },
		},
		attach(target) {
			sink = target;
		},
	};
}
