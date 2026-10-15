/**
 * Reader of the high-stakes state file the collab companion publishes per checkout
 * (`<agent dir>/collab-companion-stakes/<hash of the checkout path>`; format and parser in `@oh-my-pi/pi-wire/stakes`).
 * Read-only on purpose: the agent has no way to write the file or to answer a quiz.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseStakesState, STAKES_STATE_DIR, type StakesState, stakesStateKey } from "@oh-my-pi/pi-wire/stakes";
import { getAgentDir } from "@oh-my-pi/pi-utils";

/** A checkout and the state the companion published for it. */
export interface CheckoutStakes {
	checkout: string;
	state: StakesState;
}

function git(cwd: string, args: string[]): string | null {
	try {
		const run = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
		if (run.exitCode !== 0) return null;
		const text = run.stdout.toString().trim();
		return text === "" ? null : text;
	} catch {
		return null;
	}
}

/** Top-level folder of the checkout `dir` is in (symlinks resolved), or null when it is not in one. */
export function resolveCheckout(dir: string): string | null {
	const top = git(dir, ["rev-parse", "--show-toplevel"]);
	if (top === null) return null;
	try {
		return fs.realpathSync(top);
	} catch {
		return top;
	}
}

/** The state file of a checkout. */
export function stakesStatePath(checkout: string, agentDir: string = getAgentDir()): string {
	return path.join(agentDir, STAKES_STATE_DIR, stakesStateKey(checkout));
}

/** The parsed state file of `checkout`, or null when there is none or it is not ours. */
export function readStakesFile(checkout: string, agentDir: string = getAgentDir()): StakesState | null {
	try {
		return parseStakesState(fs.readFileSync(stakesStatePath(checkout, agentDir), "utf8"));
	} catch {
		return null;
	}
}

/** The checkout `cwd` is in and the state published for it; null when `cwd` is in no checkout or nothing is published. */
export function readCheckoutStakes(cwd: string, agentDir: string = getAgentDir()): CheckoutStakes | null {
	const checkout = resolveCheckout(cwd);
	if (checkout === null) return null;
	const state = readStakesFile(checkout, agentDir);
	return state === null ? null : { checkout, state };
}

/** Tree id of `HEAD` in `checkout`; null when there is no commit yet. */
export function headTree(checkout: string): string | null {
	return git(checkout, ["rev-parse", "--verify", "--quiet", "HEAD^{tree}"]);
}

/**
 * Cheap repeated reads of one checkout's state file for a long-lived watcher: the checkout is resolved once per
 * folder (a folder that was in none is looked at again after {@link RETRY_MS}), and the file is only read and parsed
 * when its mtime or size changed.
 */
export class StakesFileReader {
	static readonly RETRY_MS = 30_000;
	#cwd = "";
	#checkout: string | null = null;
	#resolvedAt = 0;
	#stamp = "";
	#state: StakesState | null = null;

	constructor(private readonly now: () => number = Date.now) {}

	read(cwd: string, agentDir: string): StakesState | null {
		// No companion has published anything: nothing to run git for.
		if (!fs.existsSync(path.join(agentDir, STAKES_STATE_DIR))) return this.#reset(null);
		const now = this.now();
		if (cwd !== this.#cwd || (this.#checkout === null && now - this.#resolvedAt >= StakesFileReader.RETRY_MS)) {
			this.#cwd = cwd;
			this.#checkout = resolveCheckout(cwd);
			this.#resolvedAt = now;
			this.#stamp = "";
		}
		if (this.#checkout === null) return this.#reset(null);
		const file = stakesStatePath(this.#checkout, agentDir);
		let stamp: string;
		try {
			const stat = fs.statSync(file);
			stamp = `${file}:${stat.mtimeMs}:${stat.size}`;
		} catch {
			this.#stamp = "";
			this.#state = null;
			return null;
		}
		if (stamp !== this.#stamp) {
			this.#stamp = stamp;
			this.#state = readStakesFile(this.#checkout, agentDir);
		}
		return this.#state;
	}

	#reset(state: StakesState | null): StakesState | null {
		this.#stamp = "";
		this.#state = state;
		return state;
	}
}
