import { describe, expect, it } from "bun:test";
import {
	applyOrg,
	autoSettleIdle,
	autoSettlePr,
	DAY_MS,
	emptyOrg,
	endedSettledKeys,
	mergeOrg,
	moveTarget,
	type OrgDoc,
	parseOrg,
	pinnedKeys,
	pruneOrg,
	sameOrg,
	sectionize,
	snoozeChoices,
	statusOf,
	withSettings,
} from "../src/lib/session-org";

const T0 = Date.UTC(2026, 9, 10, 12);

describe("transitions", () => {
	it("pin, snooze and settle exclude one another", () => {
		let doc = applyOrg(emptyOrg(), "a", { type: "pin" }, T0);
		expect(statusOf(doc, "a", T0)).toBe("pinned");
		doc = applyOrg(doc, "a", { type: "snooze", until: T0 + 1000 }, T0 + 1);
		expect(statusOf(doc, "a", T0 + 2)).toBe("snoozed");
		doc = applyOrg(doc, "a", { type: "settle" }, T0 + 2);
		expect(statusOf(doc, "a", T0 + 3)).toBe("settled");
		doc = applyOrg(doc, "a", { type: "pin" }, T0 + 3);
		expect(statusOf(doc, "a", T0 + 4)).toBe("pinned");
		expect(doc.entries.a.until).toBeUndefined();
		expect(doc.entries.a.reason).toBeUndefined();
	});

	it("a snooze wakes by itself when its time passes, and a snooze in the past is refused", () => {
		const doc = applyOrg(emptyOrg(), "a", { type: "snooze", until: T0 + 60_000 }, T0);
		expect(statusOf(doc, "a", T0 + 59_999)).toBe("snoozed");
		expect(statusOf(doc, "a", T0 + 60_000)).toBe("active");
		expect(applyOrg(emptyOrg(), "a", { type: "snooze", until: T0 }, T0).entries).toEqual({});
	});

	it("actions that change nothing return the same document", () => {
		const doc = applyOrg(emptyOrg(), "a", { type: "pin" }, T0);
		expect(applyOrg(doc, "a", { type: "pin" }, T0 + 1)).toBe(doc);
		expect(applyOrg(doc, "b", { type: "unpin" }, T0 + 1)).toBe(doc);
		expect(applyOrg(doc, "a", { type: "unsettle" }, T0 + 1)).toBe(doc);
		expect(applyOrg(doc, "a", { type: "wake" }, T0 + 1)).toBe(doc);
	});

	it("a local action always outranks the entry it replaces, even with a slow clock", () => {
		const doc = applyOrg(emptyOrg(), "a", { type: "pin" }, T0 + 5000);
		const next = applyOrg(doc, "a", { type: "unpin" }, T0);
		expect(next.entries.a.at).toBeGreaterThan(doc.entries.a.at);
	});

	it("restore puts the entry back as it was, newer than the action it undoes", () => {
		const pinned = applyOrg(emptyOrg(), "a", { type: "pin" }, T0);
		const settled = applyOrg(pinned, "a", { type: "settle" }, T0 + 10);
		const undone = applyOrg(settled, "a", { type: "restore", entry: pinned.entries.a }, T0 + 11);
		expect(statusOf(undone, "a", T0 + 12)).toBe("pinned");
		expect(undone.entries.a.at).toBeGreaterThan(settled.entries.a.at);
		const cleared = applyOrg(settled, "a", { type: "restore", entry: null }, T0 + 11);
		expect(statusOf(cleared, "a", T0 + 12)).toBe("active");
	});
});

describe("pin order", () => {
	const pin3 = (): OrgDoc => {
		let doc = emptyOrg();
		for (const [i, key] of ["a", "b", "c"].entries()) doc = applyOrg(doc, key, { type: "pin" }, T0 + i);
		return doc;
	};

	it("pins append, and move puts a pin between its neighbours changing only its own entry", () => {
		const doc = pin3();
		expect(pinnedKeys(doc)).toEqual(["a", "b", "c"]);
		const moved = applyOrg(doc, "c", moveTarget(pinnedKeys(doc), 2, 0), T0 + 10);
		expect(pinnedKeys(moved)).toEqual(["c", "a", "b"]);
		expect(moved.entries.a).toBe(doc.entries.a);
		expect(moved.entries.b).toBe(doc.entries.b);
		const down = applyOrg(moved, "c", moveTarget(pinnedKeys(moved), 0, 1), T0 + 11);
		expect(pinnedKeys(down)).toEqual(["a", "c", "b"]);
		const end = applyOrg(down, "a", moveTarget(pinnedKeys(down), 0, 2), T0 + 12);
		expect(pinnedKeys(end)).toEqual(["c", "b", "a"]);
	});

	it("repeated moves into the same gap keep the order (precision runs out, then it renumbers)", () => {
		let doc = pin3();
		for (let i = 0; i < 80; i++) {
			const keys = pinnedKeys(doc);
			// Alternate c and b into the gap right after a.
			const key = i % 2 === 0 ? "c" : "b";
			doc = applyOrg(doc, key, moveTarget(keys, keys.indexOf(key), 1), T0 + 100 + i);
			expect(pinnedKeys(doc)[1]).toBe(key);
		}
		expect(new Set(pinnedKeys(doc))).toEqual(new Set(["a", "b", "c"]));
	});
});

describe("merge", () => {
	it("keeps the newer entry per session whichever side it comes from", () => {
		const base = applyOrg(emptyOrg(), "a", { type: "pin" }, T0);
		const phone = applyOrg(base, "a", { type: "settle" }, T0 + 100);
		const laptop = applyOrg(
			applyOrg(base, "a", { type: "snooze", until: T0 + DAY_MS }, T0 + 50),
			"b",
			{ type: "pin" },
			T0 + 60,
		);
		const merged = mergeOrg(phone, laptop);
		expect(statusOf(merged, "a", T0 + 200)).toBe("settled");
		expect(statusOf(merged, "b", T0 + 200)).toBe("pinned");
		expect(sameOrg(merged, mergeOrg(laptop, phone))).toBe(true);
	});

	it("is idempotent, and an exact timestamp tie resolves the same way on every device", () => {
		const left = applyOrg(emptyOrg(), "a", { type: "pin" }, T0);
		const right = applyOrg(emptyOrg(), "a", { type: "settle" }, T0);
		expect(left.entries.a.at).toBe(right.entries.a.at);
		expect(sameOrg(mergeOrg(left, right), mergeOrg(right, left))).toBe(true);
		const once = mergeOrg(left, right);
		expect(sameOrg(mergeOrg(once, once), once)).toBe(true);
	});

	it("settings merge as one unit, newest first", () => {
		const a = withSettings(emptyOrg(), { idleDays: 7 }, T0);
		const b = withSettings(emptyOrg(), { settleOnPr: true }, T0 + 5);
		expect(mergeOrg(a, b).settings).toMatchObject({ idleDays: null, settleOnPr: true });
		expect(mergeOrg(b, a).settings).toMatchObject({ idleDays: null, settleOnPr: true });
	});

	describe("end on settle", () => {
		const legacy = (at: number, over: object = {}): OrgDoc => ({
			entries: {},
			settings: parseOrg({ settings: { at, idleDays: null, settleOnPr: false, ...over } }).settings,
		});

		it("is off unless set, and only a boolean counts", () => {
			expect(emptyOrg().settings.endOnSettle).toBeUndefined();
			expect(parseOrg({ settings: { at: 1, idleDays: null, settleOnPr: false } }).settings).not.toHaveProperty(
				"endOnSettle",
			);
			expect(parseOrg({ settings: { at: 1, endOnSettle: "yes" } }).settings).not.toHaveProperty("endOnSettle");
			expect(parseOrg({ settings: { at: 1, endOnSettle: true } }).settings.endOnSettle).toBe(true);
			expect(parseOrg({ settings: { at: 1, endOnSettle: false } }).settings.endOnSettle).toBe(false);
		});

		it("is changed with the other settings, which keep their values", () => {
			const on = withSettings(withSettings(emptyOrg(), { idleDays: 7 }, T0), { endOnSettle: true }, T0 + 1);
			expect(on.settings).toEqual({ at: T0 + 1, idleDays: 7, settleOnPr: false, endOnSettle: true });
			const kept = withSettings(on, { idleDays: 14 }, T0 + 2);
			expect(kept.settings).toEqual({ at: T0 + 2, idleDays: 14, settleOnPr: false, endOnSettle: true });
			// Absent already means off: switching it off is no change; switching it off after it was on is one.
			const empty = emptyOrg();
			expect(withSettings(empty, { endOnSettle: false }, T0)).toBe(empty);
			const off = withSettings(on, { endOnSettle: false }, T0 + 3);
			expect(off.settings.endOnSettle).toBe(false);
			expect(withSettings(off, { endOnSettle: false }, T0 + 4)).toBe(off);
		});

		it("survives a copy from an older app or computer that dropped it", () => {
			const mine = withSettings(emptyOrg(), { endOnSettle: true }, T0);
			// The same time: the copy that kept the field wins.
			const sameTime = legacy(T0);
			expect(mergeOrg(mine, sameTime).settings.endOnSettle).toBe(true);
			expect(mergeOrg(sameTime, mine).settings.endOnSettle).toBe(true);
			// A newer copy from an app that does not know it: its other settings win, the option stays.
			const newerLegacy = legacy(T0 + 50, { idleDays: 7 });
			for (const merged of [mergeOrg(mine, newerLegacy), mergeOrg(newerLegacy, mine)]) {
				expect(merged.settings).toEqual({ at: T0 + 50, idleDays: 7, settleOnPr: false, endOnSettle: true });
			}
			// And it stays off when it was switched off.
			const mineOff = withSettings(
				withSettings(emptyOrg(), { endOnSettle: true }, T0),
				{ endOnSettle: false },
				T0 + 1,
			);
			expect(mergeOrg(mineOff, newerLegacy).settings.endOnSettle).toBe(false);
		});

		it("a newer copy that has the field wins over an older one, either way round", () => {
			const off = withSettings(withSettings(emptyOrg(), { endOnSettle: true }, T0), { endOnSettle: false }, T0 + 1);
			const on = withSettings(off, { endOnSettle: true }, T0 + 5);
			expect(mergeOrg(off, on).settings.endOnSettle).toBe(true);
			expect(mergeOrg(on, off).settings.endOnSettle).toBe(true);
			expect(mergeOrg(on, on)).toEqual(on);
		});

		it("lists the settled sessions that are not running, never rooms", () => {
			let doc = applyOrg(emptyOrg(), "ended", { type: "settle" }, T0);
			doc = applyOrg(doc, "running", { type: "settle" }, T0 + 1);
			doc = applyOrg(doc, "pinned", { type: "pin" }, T0 + 2);
			doc = applyOrg(doc, "room:abc", { type: "settle" }, T0 + 3);
			expect(endedSettledKeys(doc, new Set(["running"]))).toEqual(["ended"]);
			expect(endedSettledKeys(doc, new Set())).toEqual(["ended", "running"]);
		});
	});

	it("an un-settle on one device beats an older settle from another", () => {
		const settled = applyOrg(emptyOrg(), "a", { type: "settle" }, T0);
		const back = applyOrg(settled, "a", { type: "unsettle" }, T0 + 1000);
		expect(statusOf(mergeOrg(settled, back), "a", T0 + 2000)).toBe("active");
	});
});

describe("parse and prune", () => {
	it("drops damaged entries, hostile keys and bad settings instead of throwing", () => {
		const raw = JSON.parse(
			'{"entries":{"ok":{"at":5,"status":"pinned","order":2},"bad":{"at":"x","status":"pinned"},"snz":{"at":1,"status":"snoozed"},"__proto__":{"at":1,"status":"settled"},"has space":{"at":1,"status":"settled"}},"settings":{"at":3,"idleDays":0,"settleOnPr":"yes"}}',
		);
		const doc = parseOrg(raw);
		expect(Object.keys(doc.entries)).toEqual(["ok"]);
		expect(doc.settings).toEqual({ at: 3, idleDays: null, settleOnPr: false });
		expect(parseOrg(null)).toEqual(emptyOrg());
		expect(parseOrg("junk")).toEqual(emptyOrg());
	});

	it("forgets old default entries but keeps pinned and recent ones", () => {
		let doc = applyOrg(emptyOrg(), "old", { type: "pin" }, T0);
		doc = applyOrg(doc, "old", { type: "unpin" }, T0 + 1);
		doc = applyOrg(doc, "kept", { type: "pin" }, T0);
		expect(Object.keys(pruneOrg(doc, T0 + 31 * DAY_MS).entries)).toEqual(["kept"]);
		expect(Object.keys(pruneOrg(doc, T0 + DAY_MS).entries).sort()).toEqual(["kept", "old"]);
	});
});

describe("sections", () => {
	it("sorts into pinned, working, active, snoozed and settled, in the order each section wants", () => {
		let doc = emptyOrg();
		doc = applyOrg(doc, "p2", { type: "pin" }, T0);
		doc = applyOrg(doc, "p1", { type: "pin" }, T0 + 1);
		doc = applyOrg(doc, "p1", moveTarget(pinnedKeys(doc), 1, 0), T0 + 2);
		doc = applyOrg(doc, "s-late", { type: "snooze", until: T0 + 2 * DAY_MS }, T0);
		doc = applyOrg(doc, "s-soon", { type: "snooze", until: T0 + DAY_MS }, T0);
		doc = applyOrg(doc, "done-old", { type: "settle" }, T0);
		doc = applyOrg(doc, "done-new", { type: "settle" }, T0 + 5);
		doc = applyOrg(doc, "woke", { type: "snooze", until: T0 + 10 }, T0);
		const keys = ["run", "idle", "p2", "p1", "s-late", "s-soon", "done-old", "done-new", "woke"];
		const sections = sectionize(
			keys,
			k => k,
			k => k === "run" || k === "woke",
			doc,
			T0 + 20,
		);
		expect(sections.pinned).toEqual(["p1", "p2"]);
		expect(sections.working).toEqual(["run", "woke"]);
		expect(sections.active).toEqual(["idle"]);
		expect(sections.snoozed).toEqual(["s-soon", "s-late"]);
		expect(sections.settled).toEqual(["done-new", "done-old"]);
	});

	it("offers the limit reset as a snooze only while it is ahead", () => {
		expect(snoozeChoices(T0, T0 + 1000).map(c => c.id)[0]).toBe("limit");
		expect(snoozeChoices(T0, T0 - 1).map(c => c.id)).not.toContain("limit");
		expect(snoozeChoices(T0, null).every(c => c.until > T0)).toBe(true);
	});
});

describe("auto-settle", () => {
	const idleDoc = (days: number | null): OrgDoc => withSettings(emptyOrg(), { idleDays: days }, T0 - 100 * DAY_MS);
	const cand = (key: string, ageDays: number, working = false) => ({
		key,
		lastActive: T0 - ageDays * DAY_MS,
		working,
	});

	it("does nothing while the idle setting is off", () => {
		const doc = idleDoc(null);
		expect(autoSettleIdle(doc, [cand("a", 400)], T0)).toBe(doc);
	});

	it("settles active sessions idle for the configured days, marking why", () => {
		const doc = autoSettleIdle(idleDoc(7), [cand("old", 8), cand("fresh", 6), cand("busy", 30, true)], T0);
		expect(statusOf(doc, "old", T0)).toBe("settled");
		expect(doc.entries.old.reason).toBe("idle");
		expect(statusOf(doc, "fresh", T0)).toBe("active");
		expect(statusOf(doc, "busy", T0)).toBe("active");
	});

	it("leaves pinned, snoozed and already settled sessions alone", () => {
		let doc = idleDoc(7);
		doc = applyOrg(doc, "pin", { type: "pin" }, T0 - 50 * DAY_MS);
		doc = applyOrg(doc, "snz", { type: "snooze", until: T0 + DAY_MS }, T0 - 50 * DAY_MS);
		const next = autoSettleIdle(doc, [cand("pin", 40), cand("snz", 40)], T0);
		expect(next).toBe(doc);
	});

	it("a session the user just moved back is not settled again", () => {
		let doc = idleDoc(7);
		doc = applyOrg(doc, "a", { type: "settle" }, T0 - 20 * DAY_MS);
		doc = applyOrg(doc, "a", { type: "unsettle" }, T0 - 1000);
		expect(statusOf(autoSettleIdle(doc, [cand("a", 30)], T0), "a", T0)).toBe("active");
		// ...until it has sat idle for the full period again.
		expect(statusOf(autoSettleIdle(doc, [cand("a", 30)], T0 + 8 * DAY_MS), "a", T0 + 8 * DAY_MS)).toBe("settled");
	});

	const pr = (key: string, doneAt: number, startedAt: number, working = false) => ({
		key,
		doneAt,
		startedAt,
		working,
	});

	it("settles a session whose pull request finished while it ran, only with the rule on", () => {
		const off = emptyOrg();
		expect(autoSettlePr(off, [pr("a", T0 - 10, T0 - 1000)], T0)).toBe(off);
		const on = withSettings(emptyOrg(), { settleOnPr: true }, T0 - DAY_MS);
		const doc = autoSettlePr(
			on,
			[pr("a", T0 - 10, T0 - 1000), pr("old", T0 - 5000, T0 - 1000), pr("busy", T0 - 10, T0 - 1000, true)],
			T0,
		);
		expect(statusOf(doc, "a", T0)).toBe("settled");
		expect(doc.entries.a.reason).toBe("pr");
		// `old`: the pull request finished before this session started; `busy`: still working.
		expect(statusOf(doc, "old", T0)).toBe("active");
		expect(statusOf(doc, "busy", T0)).toBe("active");
	});

	it("does not settle again after the user moved the session back, nor override pins", () => {
		let doc = withSettings(emptyOrg(), { settleOnPr: true }, T0 - DAY_MS);
		doc = applyOrg(doc, "back", { type: "settle" }, T0 - 500);
		doc = applyOrg(doc, "back", { type: "unsettle" }, T0 - 100);
		doc = applyOrg(doc, "pinned", { type: "pin" }, T0 - 100);
		const next = autoSettlePr(doc, [pr("back", T0 - 400, T0 - 1000), pr("pinned", T0 - 400, T0 - 1000)], T0);
		expect(statusOf(next, "back", T0)).toBe("active");
		expect(statusOf(next, "pinned", T0)).toBe("pinned");
	});
});
