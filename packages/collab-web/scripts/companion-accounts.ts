/**
 * Provider accounts for the app's limits sheet (`accounts` request): the computer's OAuth accounts and which
 * one new sessions start on. omp owns the account store and the setting that records the choice
 * (`providers.preferredAccounts`), so the companion asks the `omp` CLI (`omp usage accounts --json`,
 * `omp usage use`) instead of opening the credential database itself: tokens never reach this process, and a
 * broker-backed computer lists the accounts omp sees.
 */

import { type AccountChoice, type AccountRow, parseAccountChoice } from "@oh-my-pi/pi-wire/accounts";

/** Listing revalidates against an auth broker, which may be slow. */
const LIST_TIMEOUT_MS = 30_000;
/** Switching reads the account store, then writes the global config. */
const USE_TIMEOUT_MS = 30_000;
/** How much of omp's error output reaches the app. */
const ERROR_MAX_CHARS = 300;

/**
 * The accounts in `omp usage accounts --json` output. An account that carries no identity key is left out:
 * nothing can name it, so it cannot be made the default.
 *
 * @throws Error when the output is not the shape omp prints.
 */
export function parseAccountRows(json: string): AccountRow[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw new Error("omp printed an account list the companion could not read");
	}
	const list: unknown = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "accounts") : undefined;
	if (!Array.isArray(list)) throw new Error("omp printed an account list the companion could not read");
	const rows: AccountRow[] = [];
	for (const entry of list) {
		if (typeof entry !== "object" || entry === null) continue;
		const provider: unknown = Reflect.get(entry, "provider");
		const identityKey: unknown = Reflect.get(entry, "identityKey");
		const orgName: unknown = Reflect.get(entry, "orgName");
		const email: unknown = Reflect.get(entry, "email");
		const accountId: unknown = Reflect.get(entry, "accountId");
		if (typeof provider !== "string" || typeof identityKey !== "string" || identityKey.length === 0) continue;
		rows.push({
			provider,
			identityKey,
			...(typeof orgName === "string" && orgName.length > 0 ? { orgName } : {}),
			...(typeof email === "string" && email.length > 0 ? { email } : {}),
			...(typeof accountId === "string" && accountId.length > 0 ? { accountId } : {}),
			preferred: Reflect.get(entry, "preferred") === true,
		});
	}
	return rows;
}

/** The last non-empty line of omp's error output, which is where it names what went wrong. */
function failureReason(stderr: string): string {
	const lines = stderr
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0);
	return (lines.at(-1) ?? "no error output").slice(0, ERROR_MAX_CHARS);
}

async function runOmp(ompBin: string, args: string[], timeoutMs: number): Promise<string> {
	const proc = Bun.spawn([ompBin, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
		env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
		timeout: timeoutMs,
		killSignal: "SIGKILL",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (proc.signalCode === "SIGKILL") throw new Error("omp did not answer in time");
	if (code !== 0) throw new Error(`omp ${args.slice(0, 2).join(" ")} failed: ${failureReason(err)}`);
	return out;
}

export interface AccountsService {
	/** The computer's accounts, `preferred` marking the one new sessions start on. */
	list(): Promise<AccountRow[]>;
	/**
	 * Make `choice` the default for new sessions (`identityKey: null` for automatic), then list the accounts.
	 *
	 * @throws Error when the choice is malformed or omp refuses it (no stored account has that key, or omp
	 * predates `omp usage use`).
	 */
	use(choice: unknown): Promise<AccountRow[]>;
}

export function createAccounts(ompBin: string): AccountsService {
	const list = async (): Promise<AccountRow[]> =>
		parseAccountRows(await runOmp(ompBin, ["usage", "accounts", "--json"], LIST_TIMEOUT_MS));
	// Two switches at once would each read the config, then write it: the later write would drop the earlier.
	let queue: Promise<unknown> = Promise.resolve();
	return {
		list,
		use(choice: unknown): Promise<AccountRow[]> {
			const parsed: AccountChoice | null = parseAccountChoice(choice);
			if (parsed === null) return Promise.reject(new Error("invalid account"));
			const run = queue.then(async () => {
				await runOmp(
					ompBin,
					["usage", "use", `${parsed.provider}/${parsed.identityKey ?? "auto"}`],
					USE_TIMEOUT_MS,
				);
				return await list();
			});
			queue = run.catch(() => undefined);
			return run;
		},
	};
}
