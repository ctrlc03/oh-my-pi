import { describe, expect, test } from "bun:test";
import type { WireLimitWindow } from "@oh-my-pi/pi-wire";
import type { AccountRow } from "@oh-my-pi/pi-wire/accounts";
import { accountLabel, limitSections } from "../src/lib/accounts";
import { groupWindows } from "../src/lib/usage-limits";

const window = (provider: string, account: string | undefined, label: string, resetsAt?: number): WireLimitWindow => ({
	provider,
	account,
	label,
	resetsAt,
});
const row = (provider: string, identityKey: string, over: Partial<AccountRow> = {}): AccountRow => ({
	provider,
	identityKey,
	preferred: false,
	...over,
});

describe("accountLabel", () => {
	test("prefers the email, then the account id, then what the identity key names", () => {
		expect(accountLabel(row("anthropic", "email:a@example.com|org:o", { email: "A@example.com" }))).toBe("A@example.com");
		expect(accountLabel(row("openai-codex", "account:acct", { accountId: "acct" }))).toBe("acct");
		expect(accountLabel(row("anthropic", "email:a@example.com|org:o"))).toBe("a@example.com");
	});
});

describe("limitSections", () => {
	const windows = [
		window("anthropic", "a@example.com", "5 Hour", 20),
		window("anthropic", "a@example.com", "7 Day", 10),
		window("anthropic", "b@example.com", "5 Hour", 30),
		window("openai-codex", "c@example.com", "5 Hour", 40),
	];
	const rows = [
		row("anthropic", "email:a@example.com"),
		row("anthropic", "email:b@example.com|org:team", { orgName: "Team", preferred: true }),
		row("openai-codex", "account:acct", { accountId: "acct", email: "c@example.com" }),
	];

	test("gives a provider with two accounts one section, windows under the account they are labelled with, soonest reset first", () => {
		const sections = limitSections(groupWindows(windows, undefined), rows, undefined);
		expect(sections.map(section => section.kind)).toEqual(["accounts", "plain"]);
		const accounts = sections[0];
		if (accounts?.kind !== "accounts") throw new Error("expected an accounts section");
		expect(accounts.automatic).toBe(false);
		expect(accounts.accounts.map(entry => [entry.label, entry.windows.map(w => w.label)])).toEqual([
			["a@example.com", ["7 Day", "5 Hour"]],
			["b@example.com", ["5 Hour"]],
		]);
		// One account has nothing to choose, even though a row names it.
		expect(sections[1]).toMatchObject({ kind: "plain", group: { provider: "openai-codex" } });
	});

	test("is automatic while no account is the default", () => {
		const unpinned = rows.map(entry => ({ ...entry, preferred: false }));
		const [section] = limitSections(groupWindows(windows, undefined), unpinned, undefined);
		expect(section).toMatchObject({ kind: "accounts", automatic: true });
	});

	test("keeps windows unattributed when two accounts answer to their label, instead of guessing", () => {
		const shared = [
			row("anthropic", "email:a@example.com|org:team", { email: "a@example.com" }),
			row("anthropic", "email:a@example.com|org:personal", { email: "a@example.com" }),
		];
		const [section] = limitSections(groupWindows(windows.slice(0, 2), undefined), shared, undefined);
		if (section?.kind !== "accounts") throw new Error("expected an accounts section");
		expect(section.accounts.every(entry => entry.windows.length === 0)).toBe(true);
		expect(section.unattributed.map(group => group.account)).toEqual(["a@example.com"]);
	});

	test("lists a provider's accounts even when the host reports no windows for it, and puts the open session's provider first", () => {
		const sections = limitSections(groupWindows([window("openai-codex", "c@example.com", "5 Hour")], "anthropic"), rows, "anthropic");
		expect(sections.map(section => (section.kind === "plain" ? section.group.provider : section.provider))).toEqual([
			"anthropic",
			"openai-codex",
		]);
	});

	test("shows only the windows when no accounts are known", () => {
		const sections = limitSections(groupWindows(windows, undefined), null, undefined);
		expect(sections.every(section => section.kind === "plain")).toBe(true);
		expect(sections).toHaveLength(3);
	});
});
