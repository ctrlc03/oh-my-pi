import { afterAll, beforeAll, expect, it } from "bun:test";
import type { GuestClient } from "../../src/lib/client";
import { PersonalHarness, until } from "../../scripts/e2e-personal-harness";
import type { StubRequest } from "../../scripts/e2e-personal-stub";
import { describeE2e, SCENARIO_TIMEOUT_MS } from "./support";

/** Scenario 3 of docs/personal-agent.md's plan: the memory loop, from a paired device through the agent and back to the app. */
describeE2e("the memory loop", () => {
	let h: PersonalHarness;
	let guest: GuestClient;
	let first: StubRequest;

	beforeAll(async () => {
		h = await PersonalHarness.start();
		await h.setUp();
		await h.waitIdle();
		guest = await h.openSession();
	}, SCENARIO_TIMEOUT_MS);

	afterAll(async () => {
		await h?.stop();
	});

	/** Send a prompt from the device and wait until the turn is over; returns the agent-loop request that carried it. */
	async function say(text: string): Promise<StubRequest> {
		const after = h.stub.requests.at(-1)?.n ?? 0;
		guest.sendPrompt(text);
		const request = await h.stub.waitForRequest(r => r.transcript.includes(text), { after });
		await h.settle(guest);
		return request;
	}

	/** The hidden recall message of a request: text, or "" when it has none. */
	function recallNotice(request: StubRequest): string {
		return request.messages.find(m => m.text.includes("Long-term memory for this message"))?.text ?? "";
	}

	it(
		"keeps an owner prompt from a paired device as owner/TRUSTED, once",
		async () => {
			first = await say("Please remember that my cat is called Biscuit.");
			await until("the turn's retention", () => h.memoryRows("select id from working_memory").length > 0, {
				timeoutMs: 60_000,
			});
			const rows = h.memoryRows(
				"SELECT author_id, author_type, trust_tier FROM working_memory WHERE source = 'coding-agent-transcript' AND content LIKE '%Biscuit%'",
			);
			expect(rows).toEqual([{ author_id: "owner", author_type: "owner", trust_tier: "TRUSTED" }]);
			expect(h.memoryRows("SELECT id FROM working_memory WHERE author_id = 'coding-agent'")).toEqual([]);
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"finds it in the app's memory search with origin owner",
		async () => {
			const found = await h.call({ t: "personal-memory-search", query: { q: "Biscuit" } });
			expect(found.items).toHaveLength(1);
			expect(found.items[0]).toMatchObject({ origin: "owner", trustTier: "TRUSTED", invalid: false, pinned: false });
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"recalls it in the next turn through a hidden message and leaves the system prompt alone",
		async () => {
			const second = await say("What is my cat called?");
			expect(second.system).toBe(first.system);
			expect(recallNotice(second)).toContain("Biscuit");
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"puts a pinned memory in every turn, even one that is about something else",
		async () => {
			const id = (await h.call({ t: "personal-memory-search", query: { q: "Biscuit" } })).items[0]!.id;
			const pinned = await h.call({ t: "personal-memory-pin", id });
			expect(pinned.memory.pinned).toBe(true);
			expect(pinned.memory.importance).toBe(1);
			for (const text of ["What is the capital of Portugal?", "Name a prime number."]) {
				expect(recallNotice(await say(text))).toContain("Biscuit");
			}
			expect((await h.call({ t: "personal-memory-unpin", id })).memory.pinned).toBe(false);
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"hides a retracted memory from recall, and keeps it findable with includeInvalid",
		async () => {
			await say("Remember that my dentist is Dr Okafor.");
			await until("the dentist to be retained", async () =>
				(await h.call({ t: "personal-memory-search", query: { q: "Okafor" } })).items.length > 0 ? true : undefined,
			);
			const items = (await h.call({ t: "personal-memory-search", query: { q: "Okafor" } })).items;
			// Whatever the extraction made of that turn is the owner's to retract: the transcript row and any fact row.
			for (const item of items) await h.call({ t: "personal-memory-retract", id: item.id });

			const asked = await say("Who is my dentist, from memory?");
			expect(recallNotice(asked)).not.toContain("Okafor");

			expect((await h.call({ t: "personal-memory-search", query: { q: "Okafor" } })).items).toEqual([]);
			const withInvalid = await h.call({
				t: "personal-memory-search",
				query: { q: "Okafor", includeInvalid: true },
			});
			expect(withInvalid.items.length).toBeGreaterThan(0);
			for (const item of withInvalid.items) {
				expect(item).toMatchObject({ invalid: true, invalidBy: "owner" });
			}
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"keeps 1,100 old rows through writes and a consolidation, and a forget only invalidates",
		async () => {
			h.seedWorkingRows(1_100, 3, "bulk");
			const count = (): number => Number(h.memoryRows("SELECT COUNT(*) AS n FROM working_memory")[0]!.n);
			const before = count();
			expect(before).toBeGreaterThanOrEqual(1_100);

			// A write by the session (the default retention would trim to 1000 and drop what is older than a day).
			await say("Another thing to remember: the router password lives in the safe.");
			await until("the turn's retention", () => count() > before, { timeoutMs: 60_000 });
			expect(count()).toBeGreaterThanOrEqual(before);
			expect(Number(h.memoryRows("SELECT COUNT(*) AS n FROM working_memory WHERE id LIKE 'bulk-%'")[0]!.n)).toBe(
				1_100,
			);

			// The agent forgets one of them: the row stays, marked invalid.
			h.stub.enqueue({
				tools: [
					{
						name: "write",
						args: { path: "xd://memory_edit", content: JSON.stringify({ op: "forget", id: "bulk-7" }) },
					},
				],
			});
			await say("Forget the seventh bulk memory.");
			const row = h.memoryRows("SELECT id, valid_until FROM working_memory WHERE id = 'bulk-7'");
			expect(row).toHaveLength(1);
			expect(row[0]!.valid_until).not.toBeNull();
			const found = await h.call({ t: "personal-memory-get", id: "w:bulk-7" });
			expect(found.memory).toMatchObject({ invalid: true, invalidBy: "agent" });
		},
		SCENARIO_TIMEOUT_MS,
	);
});
