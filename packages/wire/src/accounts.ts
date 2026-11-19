/**
 * Provider accounts on a computer, and which one new sessions start on. A computer can hold several OAuth
 * accounts of one provider (two Claude subscriptions, say); omp normally ranks them by usage headroom for every
 * new session ("automatic"). Naming an account here pins new sessions to it (`omp usage use`, which writes
 * `providers.preferredAccounts` in omp's global config); naming none returns the provider to automatic. Sessions
 * already running keep the account they are on, because a provider's prompt cache is scoped to the account.
 *
 * Shared by the companion (which reads and writes omp's account store through the `omp` CLI) and the web app
 * (which shows the accounts beside the usage limits). A companion advertises `canAccounts` when it answers
 * `accounts` requests.
 */

/** One stored OAuth account, as `omp usage accounts --json` lists it. */
export interface AccountRow {
	/** Provider id (`anthropic`, `openai-codex`, ...). */
	provider: string;
	/** What `omp usage use` and the account pools name the account by, such as `email:you@example.com|org:<org-id>`. */
	identityKey: string;
	/** The organization or workspace the account is scoped to, when the provider reports one. */
	orgName?: string;
	/** The login email and the provider's account id: what a usage window labels the account by, so a window can be matched to its account. */
	email?: string;
	accountId?: string;
	/** New sessions start on this account; false for every account of a provider that is automatic. */
	preferred: boolean;
}

/** Which account new sessions of `provider` start on; `identityKey: null` returns the provider to automatic. */
export interface AccountChoice {
	provider: string;
	identityKey: string | null;
}

/** `accounts`: list the computer's accounts, or make `use` the default first (the reply lists them as they are then). */
export type AccountsRequest = { t: "accounts"; reqId: number; use?: AccountChoice };

export type AccountsReply = { t: "accounts"; reqId: number; accounts: AccountRow[] };

/** Provider ids as omp writes them; anything else could be read as a flag by the CLI the choice is passed to. */
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * A choice from an untrusted frame, or null when it is malformed. The identity key is passed to omp, which
 * accepts only a key some stored account carries; this check only keeps the frame well-formed.
 */
export function parseAccountChoice(value: unknown): AccountChoice | null {
	if (typeof value !== "object" || value === null) return null;
	const provider: unknown = Reflect.get(value, "provider");
	const identityKey: unknown = Reflect.get(value, "identityKey");
	if (typeof provider !== "string" || !PROVIDER_ID.test(provider)) return null;
	if (identityKey === null) return { provider, identityKey: null };
	if (typeof identityKey !== "string" || identityKey.length === 0 || identityKey.trim() !== identityKey) return null;
	if (identityKey.length > 512) return null;
	return { provider, identityKey };
}
