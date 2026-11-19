/**
 * Provider accounts beside the usage limits (companion capability `canAccounts`): which windows belong to
 * which of a provider's stored accounts, and which account new sessions start on. A provider with one
 * account has nothing to choose, so it keeps the plain window group; from two accounts on, the provider
 * shows each account with its own windows and a way to make one the default. Pure.
 */

import type { WireLimitWindow } from "@oh-my-pi/pi-wire";
import type { AccountRow } from "@oh-my-pi/pi-wire/accounts";
import type { LimitGroup } from "./usage-limits";

/** An account's identity key without its kind and organization: `email:a@b.c|org:x` is `a@b.c`. */
function identityBase(identityKey: string): string {
	const base = identityKey.split("|")[0] ?? identityKey;
	const colon = base.indexOf(":");
	return colon === -1 ? base : base.slice(colon + 1);
}

/** What the account is called: its email, else the provider's account id, else what its identity key names. */
export function accountLabel(row: AccountRow): string {
	return row.email ?? row.accountId ?? identityBase(row.identityKey);
}

/** The labels a usage window may carry for this account (the host labels by email, else account id). */
function windowLabels(row: AccountRow): string[] {
	return [row.email, row.accountId, identityBase(row.identityKey)]
		.filter((label): label is string => label !== undefined)
		.map(label => label.toLowerCase());
}

export interface AccountEntry {
	row: AccountRow;
	label: string;
	/** Soonest reset first, like a plain group's. */
	windows: WireLimitWindow[];
}

/** A provider with two or more stored accounts. */
export interface AccountsSection {
	kind: "accounts";
	provider: string;
	/** The provider of the open session. */
	active: boolean;
	accounts: AccountEntry[];
	/** True while no account is the default: omp ranks the accounts by usage headroom for each new session. */
	automatic: boolean;
	/** Windows the host reports that no single account owns (two accounts share an email, or none matches). */
	unattributed: LimitGroup[];
}

export interface PlainSection {
	kind: "plain";
	group: LimitGroup;
}

export type LimitSection = AccountsSection | PlainSection;

/**
 * The limits as sections: a provider with two or more `rows` becomes one accounts section, every other
 * provider keeps its window groups. A window goes to the account whose email or account id it is labelled
 * with; when two accounts answer to that label (one login in two organizations) the host's report cannot
 * tell them apart, so those windows stay unattributed rather than being shown under the wrong account.
 * The open session's provider comes first, then providers by name.
 */
export function limitSections(
	groups: readonly LimitGroup[],
	rows: readonly AccountRow[] | null,
	activeProvider: string | undefined,
): LimitSection[] {
	const byProvider = new Map<string, AccountRow[]>();
	for (const row of rows ?? []) byProvider.set(row.provider, [...(byProvider.get(row.provider) ?? []), row]);
	const sections: LimitSection[] = [];
	const done = new Set<string>();
	for (const group of groups) {
		const accounts = byProvider.get(group.provider);
		if (accounts === undefined || accounts.length < 2) {
			sections.push({ kind: "plain", group });
			continue;
		}
		if (done.has(group.provider)) continue;
		done.add(group.provider);
		sections.push(
			accountsSection(
				group.provider,
				accounts,
				groups.filter(candidate => candidate.provider === group.provider),
				activeProvider,
			),
		);
	}
	// A provider with accounts but no reported windows still lists its accounts: they are the thing to choose between.
	for (const [provider, accounts] of byProvider) {
		if (accounts.length < 2 || done.has(provider)) continue;
		sections.push(accountsSection(provider, accounts, [], activeProvider));
	}
	return sections.sort(
		(a, b) => Number(isActive(b)) - Number(isActive(a)) || sectionProvider(a).localeCompare(sectionProvider(b)),
	);
}

function accountsSection(
	provider: string,
	rows: readonly AccountRow[],
	groups: readonly LimitGroup[],
	activeProvider: string | undefined,
): AccountsSection {
	const accounts: AccountEntry[] = rows.map(row => ({ row, label: accountLabel(row), windows: [] }));
	const unattributed: LimitGroup[] = [];
	for (const group of groups) {
		const owner = group.account?.toLowerCase();
		const owners = owner === undefined ? [] : accounts.filter(entry => windowLabels(entry.row).includes(owner));
		if (owners.length === 1) owners[0]?.windows.push(...group.windows);
		else unattributed.push(group);
	}
	for (const entry of accounts) {
		entry.windows.sort((a, b) => (a.resetsAt ?? Number.POSITIVE_INFINITY) - (b.resetsAt ?? Number.POSITIVE_INFINITY));
	}
	return {
		kind: "accounts",
		provider,
		active: provider === activeProvider,
		accounts,
		automatic: !rows.some(row => row.preferred),
		unattributed,
	};
}

function isActive(section: LimitSection): boolean {
	return section.kind === "plain" ? section.group.active : section.active;
}

function sectionProvider(section: LimitSection): string {
	return section.kind === "plain" ? section.group.provider : section.provider;
}
