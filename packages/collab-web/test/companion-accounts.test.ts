import { describe, expect, test } from "bun:test";
import { parseAccountChoice } from "@oh-my-pi/pi-wire/accounts";
import { parseAccountRows } from "../scripts/companion-accounts";

describe("parseAccountRows", () => {
	test("keeps what omp lists, marks the default, and leaves out an account no key can name", () => {
		const json = JSON.stringify({
			accounts: [
				{ provider: "anthropic", identityKey: "email:a@example.com|org:o", orgName: "Team", email: "a@example.com" },
				{ provider: "anthropic", identityKey: "email:b@example.com", preferred: true },
				{ provider: "openai-codex", identityKey: null },
				{ provider: "openai-codex", identityKey: "account:acct", accountId: "acct", email: "" },
			],
		});
		expect(parseAccountRows(json)).toEqual([
			{ provider: "anthropic", identityKey: "email:a@example.com|org:o", orgName: "Team", email: "a@example.com", preferred: false },
			{ provider: "anthropic", identityKey: "email:b@example.com", preferred: true },
			{ provider: "openai-codex", identityKey: "account:acct", accountId: "acct", preferred: false },
		]);
	});

	test("refuses output that is not an account list", () => {
		for (const bad of ["not json", "[]", "{}", '{"accounts":"x"}']) {
			expect(() => parseAccountRows(bad)).toThrow("account list");
		}
	});
});

describe("parseAccountChoice", () => {
	test("accepts a key or null for automatic", () => {
		expect(parseAccountChoice({ provider: "anthropic", identityKey: "email:a@example.com|org:o" })).toEqual({
			provider: "anthropic",
			identityKey: "email:a@example.com|org:o",
		});
		expect(parseAccountChoice({ provider: "openai-codex", identityKey: null })).toEqual({
			provider: "openai-codex",
			identityKey: null,
		});
	});

	test("refuses a provider the CLI could read as a flag or a path, and a key that is empty or padded", () => {
		const bad: unknown[] = [
			null,
			"anthropic",
			{ provider: "--help", identityKey: null },
			{ provider: "a/b", identityKey: null },
			{ provider: "anthropic" },
			{ provider: "anthropic", identityKey: "" },
			{ provider: "anthropic", identityKey: " email:a@example.com" },
			{ provider: "anthropic", identityKey: 7 },
		];
		for (const choice of bad) expect(parseAccountChoice(choice)).toBeNull();
	});
});
