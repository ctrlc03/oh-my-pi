import { afterAll, beforeAll, expect, it } from "bun:test";
import * as path from "node:path";
import type { NotifyOwnerInput } from "@oh-my-pi/pi-wire/personal-ipc";
import type { GuestClient } from "../../src/lib/client";
import { PersonalHarness, until } from "../../scripts/e2e-personal-harness";
import { describeE2e, SCENARIO_TIMEOUT_MS } from "./support";

/** Scenario 5: `notify_owner`, the inbox, answers, proposals and About you. */
describeE2e("talking to the owner", () => {
	let h: PersonalHarness;
	let guest: GuestClient;

	beforeAll(async () => {
		h = await PersonalHarness.start();
		await h.setUp();
		await h.waitIdle();
		guest = await h.openSession();
	}, SCENARIO_TIMEOUT_MS);

	afterAll(async () => {
		await h?.stop();
	});

	const notifyOnPrompt = (marker: string, item: NotifyOwnerInput): Promise<string[]> =>
		h.notifyOnPrompt(guest, marker, item);

	it(
		"turns a question into an inbox item and a Web Push, and the answer comes back signed",
		async () => {
			const pushesBefore = h.pushes.length;
			await notifyOnPrompt("ASK-ME-1", {
				title: "Which branch?",
				body: "Should I use main or develop for the release notes?",
				kind: "question",
				options: ["main", "develop"],
			});
			const { items } = await h.call({ t: "personal-inbox" });
			const question = items.find(item => item.title === "Which branch?");
			expect(question).toMatchObject({
				kind: "question",
				state: "open",
				options: ["main", "develop"],
				origin: "owner",
			});
			await until("the push", () => h.pushes.length > pushesBefore, { timeoutMs: 20_000 });
			expect((await h.status()).counts.questions).toBe(1);

			const after = h.stub.requests.at(-1)?.n ?? 0;
			const answered = await h.call({ t: "personal-answer", itemId: question!.id, option: "develop" });
			expect(answered.item).toMatchObject({ state: "done", answer: { option: "develop" } });
			// The answer arrives as an owner event: delivered as a turn, not fenced as untrusted text.
			const request = await h.stub.waitForRequest(r => r.transcript.includes("develop") && r.n > after, {
				after,
				timeoutMs: 60_000,
			});
			const message = request.messages.findLast(m => m.text.includes("develop"))!;
			expect(message.text).not.toContain("<<<UNTRUSTED");
			await h.settle(guest);
			expect((await h.status()).counts.questions).toBe(0);
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"keeps a proposal pending with its diff, and applies an accepted one to About you",
		async () => {
			const about = (await h.call({ t: "personal-about-get" })).about;
			await notifyOnPrompt("PROPOSE-1", {
				title: "Squash merges?",
				body: "You asked for squash merges four times this week.",
				kind: "proposal",
				proposal: {
					op: "add",
					section: "How I like to work",
					text: "Prefer squash merges",
					rationale: "Asked for squash merges four times this week.",
				},
			});
			const pending = (await h.call({ t: "personal-proposals" })).proposals;
			expect(pending).toHaveLength(1);
			expect(pending[0]).toMatchObject({ status: "pending", fromExternal: false, baseRev: about.rev });
			expect(pending[0]!.diff.filter(line => line.op === "add").map(line => line.text.trim())).toContain(
				"- Prefer squash merges",
			);

			const accepted = await h.call({ t: "personal-proposal-accept", id: pending[0]!.id });
			expect(accepted.applied).toBe(true);
			expect(accepted.about.rev).toBe(about.rev + 1);
			const file = await Bun.file(path.join(h.agentDir, "AGENTS.md")).text();
			expect(file).toContain("- Prefer squash merges");
			expect(file.indexOf("Prefer squash merges")).toBeGreaterThan(file.indexOf("## How I like to work"));
			expect(file.indexOf("Prefer squash merges")).toBeLessThan(file.indexOf("## Hard rules"));

			const versions = (await h.call({ t: "personal-about-history" })).versions;
			expect(versions[0]).toMatchObject({ rev: about.rev + 1, by: "proposal", proposalId: pending[0]!.id });
			expect(versions[0]!.text).toContain("Prefer squash merges");

			// The live session reads AGENTS.md only at start, so the change reaches it as an owner event that starts no turn
			// of its own: the next prompt's request carries it.
			await until(
				"the about-updated event to be delivered",
				async () =>
					(await h.call({ t: "personal-events" })).events.some(
						event => event.kind === "about-updated" && event.status === "delivered",
					),
				{ timeoutMs: 60_000, everyMs: 500 },
			);
			const next = h.stub.requests.at(-1)?.n ?? 0;
			guest.sendPrompt("ABOUT-CHECK: what do you know about me?");
			const request = await h.stub.waitForRequest(r => r.transcript.includes("ABOUT-CHECK"), { after: next });
			await h.settle(guest);
			const notice = request.messages.find(m => m.text.includes("the owner changed About you"))!;
			expect(notice.text).toContain("Prefer squash merges");
			expect(notice.text).not.toContain("<<<UNTRUSTED");
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"remembers a rejected proposal and refuses the same one from the agent",
		async () => {
			const proposal: NotifyOwnerInput = {
				title: "Tabs?",
				body: "You always use tabs.",
				kind: "proposal",
				proposal: {
					op: "add",
					section: "How I like to work",
					text: "Use tabs, never spaces.",
					rationale: "Every file you wrote uses tabs.",
				},
			};
			await notifyOnPrompt("PROPOSE-2", proposal);
			const pending = (await h.call({ t: "personal-proposals" })).proposals.find(
				p => p.text === "Use tabs, never spaces.",
			)!;
			const rejected = await h.call({ t: "personal-proposal-reject", id: pending.id });
			expect(rejected.proposal.status).toBe("rejected");

			// Same line again, with different punctuation and case: the companion refuses it and the tool says why.
			const retry = await notifyOnPrompt("PROPOSE-3", {
				...proposal,
				title: "Tabs again?",
				proposal: { ...proposal.proposal!, text: "  USE TABS,   never spaces. " },
			});
			expect(retry.join("\n")).toMatch(/Rejected before/);
			const still = (await h.call({ t: "personal-proposals" })).proposals;
			expect(still.filter(p => p.status === "pending")).toEqual([]);
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"refuses a digest in a live session",
		async () => {
			const result = await notifyOnPrompt("DIGEST-1", {
				title: "What I learned",
				body: "Nothing much.",
				kind: "digest",
				digest: { day: "2026-10-14" },
			});
			expect(result.join("\n")).toMatch(/digest/i);
			expect((await h.call({ t: "personal-digests" })).digests).toEqual([]);
		},
		SCENARIO_TIMEOUT_MS,
	);
});
