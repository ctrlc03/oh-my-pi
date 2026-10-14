import { afterAll, beforeAll, expect, it } from "bun:test";
import type { PersonalChanged, PersonalSettings } from "@oh-my-pi/pi-wire/personal";
import type { ComputerHandle } from "../../src/lib/computers";
import {
	assembleExport,
	chooseHome,
	entryState,
	hostableComputers,
	mergeInbox,
	openCount,
	personalHostOf,
	withoutPersonal,
} from "../../src/lib/personal";
import { applyMemory, memoryQuery, mergePage, NO_FILTERS } from "../../src/lib/personal-memory";
import { formFromSettings, groupChange, groupDirty } from "../../src/lib/personal-settings";
import { PersonalHarness, until } from "../../scripts/e2e-personal-harness";
import { describeE2e, SCENARIO_TIMEOUT_MS } from "./support";

/**
 * Scenario 14: the app's data layer against the real companion. Every request here goes through the app's own
 * `CompanionClient` over the real room (the transport `usePersonalProvider` and `usePersonalQuery` use), and the answers are read
 * with the helpers those hooks and the Personal screens use. The hooks themselves are React effects: the repository has no DOM or
 * React renderer to mount them in, so what is checked is their inputs and outputs, not the mounting.
 */
describeE2e("the app against the real companion", () => {
	let h: PersonalHarness;

	beforeAll(async () => {
		h = await PersonalHarness.start();
		await h.setUp("Sam, a baker.");
		await h.waitIdle();
	}, SCENARIO_TIMEOUT_MS);

	afterAll(async () => {
		await h?.stop();
	});

	const handle = (): ComputerHandle => ({
		id: "home",
		name: "home",
		client: h.client,
		snap: h.client.getSnapshot(),
		error: null,
	});

	it(
		"shows the status: home choice, the pinned entry, the Personal host row kept out of the session list",
		async () => {
			const computer = handle();
			expect(hostableComputers([computer]).map(c => c.id)).toEqual(["home"]);
			expect(computer.snap.personalRev).toBeDefined();
			const status = await h.status();
			const home = chooseHome([computer], { home: status }, null);
			expect(home.computer?.id).toBe("home");
			expect(home.offline).toBe(false);
			expect(home.status).toEqual(status);

			const host = personalHostOf(computer.snap.hosts);
			expect(host).not.toBeNull();
			expect(host).toMatchObject({ personal: true });
			expect(entryState(status, false, host, computer.snap.canStart === true)).toMatchObject({
				label: "Ready",
				tone: "ok",
				thread: true,
			});
			expect(withoutPersonal(computer.snap.hosts).some(row => row.personal === true)).toBe(false);
			expect(entryState(status, true, host, true)).toMatchObject({
				label: "Home computer is offline",
				thread: false,
			});
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"round-trips settings through the form helpers and hears the change push",
		async () => {
			const frames: PersonalChanged[] = [];
			const stop = h.client.onPersonalChanged(frame => frames.push(frame));
			try {
				const { settings } = await h.call({ t: "personal-settings-get" });
				const form = { ...formFromSettings(settings), dayUsd: "7.5", reviewTime: "5:15" };
				expect(groupDirty("limits", form, settings)).toBe(true);
				const limits = groupChange("limits", form, settings);
				const review = groupChange("review", form, settings);
				expect(limits).toEqual({ patch: { limits: { dayUsd: 7.5 } }, error: null });
				expect(review).toEqual({ patch: { review: { time: "05:15" } }, error: null });
				expect(groupChange("limits", { ...form, dayUsd: "lots" }, settings).error).toMatch(/dollars/);

				const revBefore = (await h.status()).rev;
				const saved = await h.call({ t: "personal-settings-set", patch: { ...limits.patch, ...review.patch } });
				const wanted: PersonalSettings = {
					...settings,
					limits: { ...settings.limits, dayUsd: 7.5 },
					review: { ...settings.review, time: "05:15" },
				};
				expect(saved.settings).toEqual(wanted);
				expect((await h.call({ t: "personal-settings-get" })).settings).toEqual(wanted);
				expect(groupDirty("limits", formFromSettings(saved.settings), saved.settings)).toBe(false);
				await until("the change push", () => frames.some(f => f.what.includes("settings")), { timeoutMs: 20_000 });
				expect(Math.max(...frames.map(f => f.rev))).toBeGreaterThan(revBefore);
				await until("the hosts frame to carry the new revision", () => handle().snap.personalRev! > revBefore, {
					timeoutMs: 20_000,
				});
				// The status shows the new limit, and a refused edit changes nothing.
				expect((await h.status()).spend.day.limitUsd).toBe(7.5);
				await expect(
					h.call({ t: "personal-settings-set", patch: { review: { time: "25:99" } } }),
				).rejects.toThrow();
				expect((await h.call({ t: "personal-settings-get" })).settings).toEqual(wanted);
			} finally {
				stop();
			}
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"lists, pins, retracts and exports memory the way the memory screen does",
		async () => {
			const guest = await h.openSession();
			await h.turn(guest, "Please remember that my oven runs hot.");
			await until(
				"the retention",
				() => h.memoryRows("SELECT id FROM working_memory WHERE content LIKE '%oven%'").length > 0,
				{
					timeoutMs: 60_000,
				},
			);
			const page = await h.call({
				t: "personal-memory-search",
				query: memoryQuery({ ...NO_FILTERS, q: "oven" }, 0),
			});
			expect(page.items).toHaveLength(1);
			let shown = mergePage([], page.items);
			const memory = shown[0]!;
			expect(memory).toMatchObject({ origin: "owner", invalid: false, pinned: false });

			const pinned = (await h.call({ t: "personal-memory-pin", id: memory.id })).memory;
			({ items: shown } = applyMemory(shown, page.total, pinned, false));
			expect(shown[0]).toMatchObject({ pinned: true });
			const pinnedOnly = await h.call({
				t: "personal-memory-search",
				query: memoryQuery({ ...NO_FILTERS, pinnedOnly: true }, 0),
			});
			expect(pinnedOnly.items.map(m => m.id)).toEqual([memory.id]);

			const retracted = (await h.call({ t: "personal-memory-retract", id: memory.id })).memory;
			const after = applyMemory(shown, page.total, retracted, false);
			expect(after.items).toEqual([]);
			expect(after.total).toBe(page.total - 1);
			const withInvalid = await h.call({
				t: "personal-memory-search",
				query: memoryQuery({ ...NO_FILTERS, q: "oven", includeInvalid: true }, 0),
			});
			expect(withInvalid.items[0]).toMatchObject({ id: memory.id, invalid: true, invalidBy: "owner" });

			const exported = await assembleExport(async offset => {
				const {
					t: _t,
					reqId: _reqId,
					...chunk
				} = await h.call({ t: "personal-memory-export", format: "json", offset });
				return chunk;
			});
			expect(exported.name).toMatch(/\.json$/);
			expect(JSON.parse(exported.text)).toBeDefined();
			expect(exported.text).toContain("oven");
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"merges the Personal inbox with the sessions' and counts what waits for the owner",
		async () => {
			const guest = await h.openSession();
			await h.notifyOnPrompt(guest, "APP-ASK-1", {
				title: "Which branch?",
				body: "main or develop?",
				kind: "question",
				options: ["main", "develop"],
			});
			const { items } = await h.call({ t: "personal-inbox" });
			const question = items.find(item => item.title === "Which branch?")!;
			expect(question).toMatchObject({ kind: "question", state: "open" });
			const status = await h.status();
			expect(openCount(status)).toBe(1);

			const session = { computerId: "home", item: { at: question.at + 60_000, title: "A session waits" } };
			const merged = mergeInbox([session], items);
			// The open question outranks a newer session item: it stays until acted on.
			expect(merged[0]).toMatchObject({ source: "personal", item: { id: question.id } });
			expect(merged.some(entry => entry.source === "session")).toBe(true);

			const answered = await h.call({ t: "personal-answer", itemId: question.id, option: "develop" });
			expect(answered.item).toMatchObject({ state: "done", answer: { option: "develop" } });
			await until("the count to drop", async () => openCount(await h.status()) === 0, { timeoutMs: 20_000 });
			const again = mergeInbox([session], (await h.call({ t: "personal-inbox", includeDone: true })).items);
			expect(again[0]).toMatchObject({ source: "session" });
		},
		SCENARIO_TIMEOUT_MS,
	);
});
