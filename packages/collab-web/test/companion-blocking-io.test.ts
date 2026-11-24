/**
 * The companion is one process with one thread for JavaScript. macOS holds the first access to a protected folder
 * (`~/Documents`, `~/Desktop`, removable and network volumes) until the user answers a privacy prompt, and the folders
 * of sessions often are such folders. A synchronous read there froze the loopback app, the relay heartbeat and every poll
 * until someone clicked Allow. A named pipe stands in for the prompt: opening it for reading waits until something opens
 * it for writing. Each scenario runs in a child process (companion-blocking-io-fixture.ts) so that a regression shows as
 * an unanswered request here, not as a test run that never ends.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { skipWhileRunning } from "../scripts/companion-tick";

const FIXTURE = path.join(import.meta.dir, "companion-blocking-io-fixture.ts");
/**
 * Time for the child to reach the stalled open: it starts the operation right after it prints `STALLING`. Real time is the
 * point of this test: a frozen process prints nothing and fires no event, so the only evidence is how long it stays silent.
 */
const SETTLE_MS = 500;
const ANSWER_WITHIN_MS = 1_000;

let dir: string;
let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;

beforeEach(async () => {
	dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "companion-blocking-io-")));
});

afterEach(async () => {
	child?.kill("SIGKILL");
	await child?.exited;
	child = undefined;
	await fs.rm(dir, { recursive: true, force: true });
});

/** The lines the child prints, as they arrive. */
class Lines {
	readonly seen: string[] = [];
	#waiting: Array<() => void> = [];

	constructor(stream: ReadableStream<Uint8Array>) {
		void (async () => {
			const decoder = new TextDecoder();
			let rest = "";
			for await (const chunk of stream) {
				rest += decoder.decode(chunk, { stream: true });
				for (let end = rest.indexOf("\n"); end >= 0; end = rest.indexOf("\n")) {
					this.seen.push(rest.slice(0, end));
					rest = rest.slice(end + 1);
				}
				for (const wake of this.#waiting.splice(0)) wake();
			}
		})();
	}

	/** The first line starting with `prefix`; null when none arrives within `ms`. */
	async next(prefix: string, ms: number): Promise<string | null> {
		const deadline = Date.now() + ms;
		for (;;) {
			const line = this.seen.find(candidate => candidate.startsWith(prefix));
			if (line !== undefined) return line;
			const left = deadline - Date.now();
			if (left <= 0) return null;
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#waiting.push(resolve);
			setTimeout(resolve, left);
			await promise;
		}
	}
}

async function makeFifo(file: string): Promise<void> {
	const made = Bun.spawn(["mkfifo", file], { stdout: "ignore", stderr: "pipe" });
	if ((await made.exited) !== 0) throw new Error(`mkfifo failed: ${await new Response(made.stderr).text()}`);
}

async function git(cwd: string, ...args: string[]): Promise<void> {
	const run = Bun.spawn(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
		cwd,
		stdout: "ignore",
		stderr: "pipe",
	});
	if ((await run.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(run.stderr).text()}`);
}

/**
 * Run `scenario` in a child whose repository holds a named pipe at `fifo`. While the pipe is unopened, the child's
 * loopback app must still answer, its timer must still tick, and the operation must still be waiting; once the pipe
 * is written to, the operation finishes. Returns what the operation reported.
 */
async function stallsWithoutFreezing(scenario: "lsp" | "codemap", repo: string, fifo: string, content: string) {
	child = Bun.spawn(["bun", FIXTURE, scenario, repo], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, OMP_JUDGMENT_CACHE_DB: path.join(dir, "judgment-cache.db") },
	});
	const lines = new Lines(child.stdout);
	// Drained once from the start: both exit reporters below want it, and a stream can only be read once.
	const stderr = new Response(child.stderr).text();
	const running = (): NonNullable<typeof child> => {
		if (child === undefined) throw new Error("the fixture was never spawned");
		return child;
	};
	/** Reports the fixture's own output when it dies: an early exit (a synchronous read that never resumed) must not read as a timeout. */
	const childExited = async (what: string): Promise<never> => {
		const code = await running().exited;
		throw new Error(
			`${what}: the fixture exited with ${code}: ${(await stderr).slice(0, 400)}`,
		);
	};
	/** The child died within a short window of `phase`: report its output instead of waiting for the next timeout. */
	const exitedEarly = async (phase: string) => {
		const outcome = await Promise.race([
			running()
				.exited.then(
					async code => `exited with ${code}: ${(await stderr).slice(0, 400)}`,
				)
				.then(why => ({ why })),
			Bun.sleep(20).then(() => null),
		]);
		if (outcome !== null) throw new Error(`during "${phase}" the fixture ${outcome.why}`);
	};
	const ready = (await lines.next("READY ", 30_000)) ?? (await childExited("waiting for the fixture to serve"));
	const base = `http://127.0.0.1:${ready.slice("READY ".length)}`;
	(await lines.next("STALLING", 5_000)) ?? (await childExited("waiting for the fixture to start the stalled read"));
	await exitedEarly("just after the stalled read began");
	await Bun.sleep(SETTLE_MS);

	// The loopback app answers at once; `POST /` is refused by a handler that runs on the same thread as everything else.
	const started = Date.now();
	const post = await fetch(`${base}/`, { method: "POST", signal: AbortSignal.timeout(ANSWER_WITHIN_MS) }).catch(
		async (error: unknown) => await childExited(`the loopback app refused the request (${String(error)})`),
	);
	expect(post.status).toBe(405);
	expect(Date.now() - started).toBeLessThan(ANSWER_WITHIN_MS);

	// Timers (the companion's polls and heartbeats) keep firing.
	const ticks = async () =>
		await fetch(`${base}/__ticks`, { signal: AbortSignal.timeout(ANSWER_WITHIN_MS) })
			.then(response => response.text())
			.catch(async (error: unknown) => await childExited(`the timer request failed (${String(error)})`));
	const before = Number(await ticks());
	await Bun.sleep(300);
	const after = Number(await ticks());
	expect(after - before).toBeGreaterThanOrEqual(4);

	// The operation itself is still waiting for the pipe.
	expect(lines.seen.some(line => line.startsWith("DONE "))).toBe(false);

	// Answering the "prompt": the open completes and so does the operation.
	await fs.writeFile(fifo, content);
	const done = (await lines.next("DONE ", 30_000)) ?? (await childExited("waiting for the stalled read to finish"));
	return done.slice("DONE ".length);
}

describe.skipIf(process.platform === "win32")("a repository folder whose first read waits", () => {
	it("language servers: configuring them reads the repository without freezing the companion", async () => {
		const repo = path.join(dir, "repo");
		await fs.mkdir(repo);
		await git(repo, "init", "-q");
		await Bun.write(path.join(repo, "notes.zzunknown"), "x\n");
		await makeFifo(path.join(repo, ".lsp.json"));
		const answer = await stallsWithoutFreezing("lsp", repo, path.join(repo, ".lsp.json"), "{}");
		expect(JSON.parse(answer)).toMatchObject({ kind: "unavailable" });
	}, 60_000);

	it("code map: reading a circuit's manifest does not freeze the companion", async () => {
		const repo = path.join(dir, "repo");
		await fs.mkdir(path.join(repo, "circuit", "src"), { recursive: true });
		await git(repo, "init", "-q");
		await Bun.write(path.join(repo, "circuit", "src", "main.nr"), "fn main(x: Field) {\n    assert(x == x);\n}\n");
		await fs.mkdir(path.join(repo, "crates", "prover", "src"), { recursive: true });
		await Bun.write(path.join(repo, "crates", "prover", "src", "lib.rs"), 'pub const CIRCUIT: &str = "stalled";\n');
		await makeFifo(path.join(repo, "circuit", "Nargo.toml"));
		const answer = await stallsWithoutFreezing(
			"codemap",
			repo,
			path.join(repo, "circuit", "Nargo.toml"),
			'[package]\nname = "stalled"\ntype = "bin"\n',
		);
		// The Rust file names the circuit by the manifest's package name, which only the manifest can give.
		expect(JSON.parse(answer).edges).toContain("crates/prover/src/lib.rs -> circuit/src/main.nr");
	}, 60_000);
});

describe("periodic work that waits on a folder", () => {
	it("does not start another run while the previous one is still waiting", async () => {
		let started = 0;
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		const tick = skipWhileRunning(async (_rows: readonly string[]) => {
			started++;
			await gate;
		});
		const first = tick(["a"]);
		await tick(["b"]);
		await tick(["c"]);
		expect(started).toBe(1);
		release();
		await first;
		await tick(["d"]);
		expect(started).toBe(2);
	});

	it("runs again after a run that failed", async () => {
		let started = 0;
		const tick = skipWhileRunning(async () => {
			started++;
			throw new Error("stalled folder gave up");
		});
		await expect(tick()).rejects.toThrow("gave up");
		await expect(tick()).rejects.toThrow("gave up");
		expect(started).toBe(2);
	});
});
