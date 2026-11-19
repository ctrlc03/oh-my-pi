/**
 * The mock companion's provider accounts (`accounts` request): two Claude accounts (one a Team workspace) and one
 * Codex account, with the default for new sessions kept in a file of the mock's `--dir`, so a switch survives a page
 * reload and a restarted mock, as omp's `providers.preferredAccounts` setting does. The choice goes through the real
 * `parseAccountChoice`; the refusal of a key no account carries matches `omp usage use`. The windows of these accounts
 * are the mock host's (./mock-usage-limits), which labels them by the same emails. See ./companion-accounts for the real thing.
 */

import * as path from "node:path";
import { type AccountRow, parseAccountChoice } from "@oh-my-pi/pi-wire/accounts";
import type { CompanionRequest } from "../src/lib/companion";

type AccountsRequest = Extract<CompanionRequest, { t: "accounts" }>;

/** What `omp usage accounts --json` would print for the mock's computer, before the default is applied. */
const ACCOUNTS: Omit<AccountRow, "preferred">[] = [
	{ provider: "anthropic", identityKey: "email:dev@example.test", email: "dev@example.test" },
	{
		provider: "anthropic",
		identityKey: "email:team@example.test|org:org-team",
		orgName: "Team",
		email: "team@example.test",
	},
	{ provider: "openai", identityKey: "account:acct-codex", email: "dev@example.test", accountId: "acct-codex" },
];

/** The mock's latency: `omp usage accounts` starts a process and may ask a broker. */
const DELAY_MS = 400;

export interface MockAccounts {
	/** Field of the mock companion's `hosts` frame. */
	capabilities: { canAccounts: true };
	handles(request: CompanionRequest): request is AccountsRequest;
	answer(request: AccountsRequest): Promise<{ t: "accounts"; reqId: number; accounts: AccountRow[] }>;
}

export async function createMockAccounts(options: { dir: string }): Promise<MockAccounts> {
	const file = path.join(options.dir, "collab-companion-accounts.json");
	const stored = Bun.file(file);
	// Provider id → identity key of the default; a provider with no entry is automatic.
	let preferred: Record<string, string> = (await stored.exists()) ? await stored.json() : {};
	const rows = (): AccountRow[] =>
		ACCOUNTS.map(account => ({ ...account, preferred: preferred[account.provider] === account.identityKey }));

	return {
		capabilities: { canAccounts: true },
		handles: (request): request is AccountsRequest => request.t === "accounts",
		async answer(request) {
			await Bun.sleep(DELAY_MS);
			if (request.use !== undefined) {
				const choice = parseAccountChoice(request.use);
				if (choice === null) throw new Error("invalid account");
				const { identityKey, provider } = choice;
				if (
					identityKey !== null &&
					!ACCOUNTS.some(account => account.provider === provider && account.identityKey === identityKey)
				) {
					throw new Error(
						`omp usage use failed: No OAuth account "${identityKey}" for provider "${provider}". \`omp usage accounts\` lists the keys.`,
					);
				}
				const next = { ...preferred };
				if (identityKey === null) delete next[provider];
				else next[provider] = identityKey;
				preferred = next;
				await Bun.write(file, JSON.stringify(preferred));
			}
			return { t: "accounts", reqId: request.reqId, accounts: rows() };
		},
	};
}
