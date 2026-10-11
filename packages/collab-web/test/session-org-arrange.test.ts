import { describe, expect, it } from "bun:test";
import { gapTop, insertionIndex, type RowBox, rowAt, rowsBetween, slideDelta, zoneAt } from "../src/lib/org-drag";
import {
	applyMany,
	applyOrg,
	arrangeActive,
	autoSettleIdle,
	autoSettlePr,
	changedEntries,
	DAY_MS,
	type DropLayout,
	dropIntent,
	dropSession,
	emptyOrg,
	mergeOrg,
	type OrgDoc,
	type OrgSection,
	parseOrg,
	pinnedKeys,
	placeKey,
	pruneOrg,
	restoreEntries,
	sameOrg,
	sectionize,
	statusOf,
	withSettings,
} from "../src/lib/session-org";

const T0 = Date.UTC(2026, 9, 10, 12);

const activeOf = (doc: OrgDoc, keys: readonly string[], working: readonly string[] = []): string[] =>
	sectionize(
		keys,
		k => k,
		k => working.includes(k),
		doc,
		T0 + 1,
	).active;

describe("active order", () => {
	it("sessions without a place sit above the arranged ones, which follow their ranks", () => {
		const doc = arrangeActive(emptyOrg(), ["c", "a", "b"], T0);
		expect(activeOf(doc, ["new", "a", "b", "c"])).toEqual(["new", "c", "a", "b"]);
		expect(activeOf(doc, ["n2", "new", "c", "b", "a"])).toEqual(["n2", "new", "c", "a", "b"]);
	});

	it("writes only the entries whose rank changes, and nothing when the order stands", () => {
		const doc = arrangeActive(emptyOrg(), ["a", "b", "c"], T0);
		const next = arrangeActive(doc, ["b", "a", "c"], T0 + 10);
		expect(next.entries.c).toBe(doc.entries.c);
		expect(next.entries.a.rank).toBe(1);
		expect(next.entries.b.rank).toBe(0);
		expect(arrangeActive(next, ["b", "a", "c"], T0 + 20)).toBe(next);
	});

	it("settling clears the place; pinning and snoozing keep it", () => {
		let doc = arrangeActive(emptyOrg(), ["a", "b", "c"], T0);
		doc = applyOrg(doc, "b", { type: "pin" }, T0 + 1);
		expect(doc.entries.b.rank).toBe(1);
		doc = applyOrg(doc, "b", { type: "unpin" }, T0 + 2);
		expect(activeOf(doc, ["a", "b", "c"])).toEqual(["a", "b", "c"]);
		doc = applyOrg(doc, "b", { type: "snooze", until: T0 + 10_000 }, T0 + 3);
		expect(doc.entries.b.rank).toBe(1);
		doc = applyOrg(doc, "b", { type: "wake" }, T0 + 4);
		expect(activeOf(doc, ["a", "b", "c"])).toEqual(["a", "b", "c"]);
		doc = applyOrg(doc, "b", { type: "settle" }, T0 + 5);
		expect(doc.entries.b.rank).toBeUndefined();
		// Un-settling returns it to the top, above the arranged ones.
		doc = applyOrg(doc, "b", { type: "unsettle" }, T0 + 6);
		expect(activeOf(doc, ["a", "b", "c"])).toEqual(["b", "a", "c"]);
	});

	it("a working session shows in Working whatever its place, and returns to its place when it stops", () => {
		const doc = arrangeActive(emptyOrg(), ["a", "b", "c"], T0);
		const sections = sectionize(
			["a", "b", "c"],
			k => k,
			k => k === "b",
			doc,
			T0 + 1,
		);
		expect(sections.working).toEqual(["b"]);
		expect(sections.active).toEqual(["a", "c"]);
		expect(activeOf(doc, ["a", "b", "c"])).toEqual(["a", "b", "c"]);
	});

	it("placeKey puts a key at an index of the list without it", () => {
		expect(placeKey(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
		expect(placeKey(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
		expect(placeKey(["a", "b"], "x", 9)).toEqual(["a", "b", "x"]);
	});
});

describe("dropping between sections", () => {
	const build = (): { doc: OrgDoc; layout: DropLayout } => {
		let doc = emptyOrg();
		doc = applyOrg(doc, "p1", { type: "pin" }, T0);
		doc = applyOrg(doc, "p2", { type: "pin" }, T0 + 1);
		doc = applyOrg(doc, "s1", { type: "snooze", until: T0 + DAY_MS }, T0);
		doc = applyOrg(doc, "d1", { type: "settle" }, T0);
		doc = arrangeActive(doc, ["a1", "a2", "a3"], T0);
		return { doc, layout: { pinned: ["p1", "p2"], active: ["a1", "a2", "a3"] } };
	};
	const drop = (
		doc: OrgDoc,
		key: string,
		from: OrgSection,
		zone: "pinned" | "active" | "settled",
		index: number,
		layout: DropLayout,
	): OrgDoc => dropSession(doc, key, from, zone, index, layout, T0 + 100);

	it("names what a drop does for every pair of sections", () => {
		expect(dropIntent("active", "pinned", true)).toBe("pin");
		expect(dropIntent("working", "pinned", true)).toBe("pin");
		expect(dropIntent("snoozed", "pinned", true)).toBe("pin");
		expect(dropIntent("settled", "pinned", true)).toBe("pin");
		expect(dropIntent("pinned", "pinned", true)).toBe("reorder");
		expect(dropIntent("pinned", "active", true)).toBe("unpin");
		expect(dropIntent("snoozed", "active", true)).toBe("wake");
		expect(dropIntent("settled", "active", true)).toBe("unsettle");
		expect(dropIntent("active", "active", true)).toBe("reorder");
		expect(dropIntent("active", "active", false)).toBeNull();
		expect(dropIntent("working", "active", true)).toBeNull();
		expect(dropIntent("pinned", "settled", true)).toBe("settle");
		expect(dropIntent("active", "settled", true)).toBe("settle");
		expect(dropIntent("snoozed", "settled", true)).toBe("settle");
		expect(dropIntent("settled", "settled", true)).toBeNull();
	});

	it("dropping into Pinned pins at the spot", () => {
		const { doc, layout } = build();
		const next = drop(doc, "a2", "active", "pinned", 1, layout);
		expect(pinnedKeys(next)).toEqual(["p1", "a2", "p2"]);
		expect(next.entries.a2.rank).toBe(1);
		const top = drop(doc, "a3", "active", "pinned", 0, layout);
		expect(pinnedKeys(top)).toEqual(["a3", "p1", "p2"]);
		const into = drop(emptyOrg(), "x", "active", "pinned", 0, { pinned: [], active: [] });
		expect(pinnedKeys(into)).toEqual(["x"]);
	});

	it("dropping a pinned row into Active unpins it at the spot", () => {
		const { doc, layout } = build();
		const next = drop(doc, "p1", "pinned", "active", 2, layout);
		expect(statusOf(next, "p1", T0 + 200)).toBe("active");
		expect(activeOf(next, ["a1", "a2", "a3", "p1"])).toEqual(["a1", "a2", "p1", "a3"]);
	});

	it("dropping onto Settled settles, from any section, and clears the pin and the place", () => {
		const { doc, layout } = build();
		for (const [key, from] of [
			["p1", "pinned"],
			["a1", "active"],
			["s1", "snoozed"],
		] as const) {
			const next = drop(doc, key, from, "settled", 0, layout);
			expect(statusOf(next, key, T0 + 200)).toBe("settled");
			expect(next.entries[key].rank).toBeUndefined();
			expect(next.entries[key].order).toBeUndefined();
		}
		expect(drop(doc, "d1", "settled", "settled", 0, layout)).toBe(doc);
	});

	it("dragging a settled row into Active un-settles it, and a snoozed one out of Snoozed wakes it, at the spot", () => {
		const { doc, layout } = build();
		const back = drop(doc, "d1", "settled", "active", 1, layout);
		expect(statusOf(back, "d1", T0 + 200)).toBe("active");
		expect(activeOf(back, ["a1", "a2", "a3", "d1"])).toEqual(["a1", "d1", "a2", "a3"]);
		const woke = drop(doc, "s1", "snoozed", "active", 0, layout);
		expect(statusOf(woke, "s1", T0 + 200)).toBe("active");
		expect(woke.entries.s1.until).toBeUndefined();
		expect(activeOf(woke, ["a1", "a2", "a3", "s1"])).toEqual(["s1", "a1", "a2", "a3"]);
	});

	it("reorders within a section, and refuses an Active reorder when the order is not kept", () => {
		const { doc, layout } = build();
		expect(activeOf(drop(doc, "a1", "active", "active", 2, layout), ["a1", "a2", "a3"])).toEqual(["a2", "a3", "a1"]);
		expect(pinnedKeys(drop(doc, "p2", "pinned", "pinned", 0, layout))).toEqual(["p2", "p1"]);
		expect(drop(doc, "a1", "active", "active", 2, { ...layout, active: null })).toBe(doc);
		// Without a kept order a wake still happens, just without a place.
		const woke = drop(doc, "s1", "snoozed", "active", 1, { ...layout, active: null });
		expect(statusOf(woke, "s1", T0 + 200)).toBe("active");
		expect(woke.entries.s1.rank).toBeUndefined();
	});
});

describe("bulk changes and undo", () => {
	it("applies one action to many sessions and one restore puts every entry back", () => {
		let doc = arrangeActive(emptyOrg(), ["a", "b", "c", "d"], T0);
		doc = applyOrg(doc, "b", { type: "pin" }, T0 + 1);
		const settled = applyMany(doc, ["a", "b", "c"], { type: "settle" }, T0 + 10);
		for (const key of ["a", "b", "c"]) expect(statusOf(settled, key, T0 + 20)).toBe("settled");
		expect(statusOf(settled, "d", T0 + 20)).toBe("active");
		const prev = changedEntries(doc, settled);
		expect(Object.keys(prev).sort()).toEqual(["a", "b", "c"]);
		const undone = restoreEntries(settled, prev, T0 + 30);
		expect(statusOf(undone, "b", T0 + 40)).toBe("pinned");
		expect(undone.entries.a.rank).toBe(0);
		expect(undone.entries.c.rank).toBe(2);
		expect(pinnedKeys(undone)).toEqual(["b"]);
		expect(undone.entries.a.at).toBeGreaterThan(settled.entries.a.at);
	});

	it("a session that had no entry goes back to default, and unchanged sessions are not reported", () => {
		const doc = applyOrg(emptyOrg(), "kept", { type: "pin" }, T0);
		const next = applyMany(doc, ["new", "kept"], { type: "settle" }, T0 + 5);
		const prev = changedEntries(doc, next);
		expect(prev.new).toBeNull();
		expect(Object.keys(applyMany(next, ["new", "kept"], { type: "settle" }, T0 + 6).entries)).toEqual([
			"kept",
			"new",
		]);
		expect(applyMany(next, ["new", "kept"], { type: "settle" }, T0 + 6)).toBe(next);
		const undone = restoreEntries(next, prev, T0 + 9);
		expect(statusOf(undone, "new", T0 + 10)).toBe("active");
		expect(statusOf(undone, "kept", T0 + 10)).toBe("pinned");
	});

	it("picked sessions pin in the order given, and wake only the snoozed", () => {
		let doc = applyOrg(emptyOrg(), "z", { type: "snooze", until: T0 + DAY_MS }, T0);
		doc = applyMany(doc, ["x", "y", "z"], { type: "pin" }, T0 + 1);
		expect(pinnedKeys(doc)).toEqual(["x", "y", "z"]);
		const woke = applyMany(doc, ["x", "y"], { type: "wake" }, T0 + 2);
		expect(woke).toBe(doc);
	});
});

describe("auto-settle opt-out", () => {
	const idleDoc = (): OrgDoc => withSettings(emptyOrg(), { idleDays: 3, settleOnPr: true }, T0 - 100 * DAY_MS);
	const old = (key: string) => ({ key, lastActive: T0 - 10 * DAY_MS, working: false });

	it("keeps a session out of the idle rule, and out again when switched back on", () => {
		const off = applyOrg(idleDoc(), "a", { type: "autosettle", on: false }, T0 - 20 * DAY_MS);
		const settled = autoSettleIdle(off, [old("a"), old("b")], T0);
		expect(statusOf(settled, "a", T0)).toBe("active");
		expect(statusOf(settled, "b", T0)).toBe("settled");
		const on = applyOrg(off, "a", { type: "autosettle", on: true }, T0 - 15 * DAY_MS);
		expect(on.entries.a.autoSettle).toBeUndefined();
		expect(statusOf(autoSettleIdle(on, [old("a")], T0), "a", T0)).toBe("settled");
	});

	it("keeps it out of the pull request rule too", () => {
		const off = applyOrg(idleDoc(), "a", { type: "autosettle", on: false }, T0 - 20 * DAY_MS);
		const pr = (key: string) => ({ key, doneAt: T0 - DAY_MS, startedAt: T0 - 5 * DAY_MS, working: false });
		const settled = autoSettlePr(off, [pr("a"), pr("b")], T0);
		expect(statusOf(settled, "a", T0)).toBe("active");
		expect(statusOf(settled, "b", T0)).toBe("settled");
	});

	it("manual settle and snooze still work, and the choice survives every status change", () => {
		let doc = applyOrg(emptyOrg(), "a", { type: "autosettle", on: false }, T0);
		doc = applyOrg(doc, "a", { type: "settle" }, T0 + 1);
		expect(statusOf(doc, "a", T0 + 2)).toBe("settled");
		expect(doc.entries.a.autoSettle).toBe(false);
		doc = applyOrg(doc, "a", { type: "unsettle" }, T0 + 2);
		doc = applyOrg(doc, "a", { type: "pin" }, T0 + 3);
		doc = applyOrg(doc, "a", { type: "snooze", until: T0 + DAY_MS }, T0 + 4);
		expect(doc.entries.a.autoSettle).toBe(false);
		expect(doc.entries.a.status).toBe("snoozed");
	});

	it("switching it off on a pinned session keeps the pin, and a change nothing needs is refused", () => {
		const pinned = applyOrg(emptyOrg(), "a", { type: "pin" }, T0);
		const off = applyOrg(pinned, "a", { type: "autosettle", on: false }, T0 + 1);
		expect(statusOf(off, "a", T0 + 2)).toBe("pinned");
		expect(off.entries.a.order).toBe(pinned.entries.a.order);
		expect(applyOrg(off, "a", { type: "autosettle", on: false }, T0 + 2)).toBe(off);
		expect(applyOrg(emptyOrg(), "a", { type: "autosettle", on: true }, T0)).toEqual(emptyOrg());
	});

	it("an active entry that only carries the choice or a place is not forgotten as a tombstone", () => {
		let doc = applyOrg(emptyOrg(), "off", { type: "autosettle", on: false }, T0);
		doc = arrangeActive(doc, ["ranked"], T0);
		doc = applyOrg(doc, "plain", { type: "pin" }, T0);
		doc = applyOrg(doc, "plain", { type: "unpin" }, T0 + 1);
		expect(Object.keys(pruneOrg(doc, T0 + 40 * DAY_MS).entries).sort()).toEqual(["off", "ranked"]);
	});
});

describe("merging the new fields", () => {
	it("two copies keep each other's places and opt-outs, whichever merges first", () => {
		const base = arrangeActive(emptyOrg(), ["a", "b", "c"], T0);
		const phone = arrangeActive(base, ["c", "a", "b"], T0 + 10);
		const laptop = applyOrg(base, "d", { type: "autosettle", on: false }, T0 + 20);
		const merged = mergeOrg(phone, laptop);
		expect(merged.entries.c.rank).toBe(0);
		expect(merged.entries.d.autoSettle).toBe(false);
		expect(sameOrg(merged, mergeOrg(laptop, phone))).toBe(true);
		expect(sameOrg(mergeOrg(merged, merged), merged)).toBe(true);
	});

	it("the later write of one session wins whole", () => {
		const base = arrangeActive(emptyOrg(), ["a", "b"], T0);
		const mine = applyOrg(base, "a", { type: "autosettle", on: false }, T0 + 5);
		const theirs = arrangeActive(base, ["b", "a"], T0 + 9);
		expect(mergeOrg(mine, theirs).entries.a).toEqual(theirs.entries.a);
		expect(mergeOrg(theirs, mine).entries.a).toEqual(theirs.entries.a);
	});

	it("an entry an older computer returned without the new fields does not undo them here", () => {
		const mine = applyOrg(arrangeActive(emptyOrg(), ["a"], T0), "a", { type: "autosettle", on: false }, T0 + 1);
		const stripped: OrgDoc = {
			entries: { a: { at: mine.entries.a.at, status: "active" } },
			settings: mine.settings,
		};
		expect(mergeOrg(mine, stripped).entries.a).toEqual(mine.entries.a);
		expect(mergeOrg(stripped, mine).entries.a).toEqual(mine.entries.a);
	});
});

describe("parsing", () => {
	it("reads a document from before the new fields", () => {
		const raw = JSON.parse(
			'{"entries":{"a":{"at":5,"status":"pinned","order":2},"b":{"at":6,"status":"active"},"c":{"at":7,"status":"settled","reason":"idle"},"d":{"at":8,"status":"snoozed","until":99}},"settings":{"at":3,"idleDays":7,"settleOnPr":true}}',
		);
		const doc = parseOrg(raw);
		expect(doc.entries.a).toEqual({ at: 5, status: "pinned", order: 2 });
		expect(doc.entries.b).toEqual({ at: 6, status: "active" });
		expect(doc.entries.c).toEqual({ at: 7, status: "settled", reason: "idle" });
		expect(doc.entries.d).toEqual({ at: 8, status: "snoozed", until: 99 });
		expect(doc.settings).toEqual({ at: 3, idleDays: 7, settleOnPr: true });
	});

	it("reads the new fields, drops bad ones, and ignores a place on a settled entry", () => {
		const raw = JSON.parse(
			'{"entries":{"a":{"at":5,"status":"active","rank":3,"autoSettle":false},"b":{"at":5,"status":"active","rank":"x","autoSettle":true},"c":{"at":5,"status":"settled","rank":1,"autoSettle":false},"d":{"at":5,"status":"pinned","order":1,"rank":-2}}}',
		);
		const doc = parseOrg(raw);
		expect(doc.entries.a).toEqual({ at: 5, status: "active", rank: 3, autoSettle: false });
		expect(doc.entries.b).toEqual({ at: 5, status: "active" });
		expect(doc.entries.c).toEqual({ at: 5, status: "settled", reason: "user", autoSettle: false });
		expect(doc.entries.d).toEqual({ at: 5, status: "pinned", order: 1, rank: -2 });
		// What the app writes parses back to itself.
		expect(sameOrg(parseOrg(JSON.parse(JSON.stringify(doc))), doc)).toBe(true);
	});
});

describe("drag geometry", () => {
	const rows = (...tops: number[]): RowBox[] =>
		tops.map((top, i) => ({ key: `r${i}`, section: "active", top, height: 40 }));

	it("finds the zone under the pointer, or the nearest one in a gap", () => {
		const zones = [
			{ section: "pinned" as const, top: 0, bottom: 100 },
			{ section: "active" as const, top: 116, bottom: 300 },
		];
		expect(zoneAt(zones, 50)?.section).toBe("pinned");
		expect(zoneAt(zones, 110)?.section).toBe("active");
		expect(zoneAt(zones, 105)?.section).toBe("pinned");
		expect(zoneAt(zones, 900)?.section).toBe("active");
		expect(zoneAt([], 5)).toBeNull();
	});

	it("counts the rows above the pointer for the landing index, and places the gap there", () => {
		const list = rows(0, 44, 88);
		expect(insertionIndex(list, 10)).toBe(0);
		expect(insertionIndex(list, 30)).toBe(1);
		expect(insertionIndex(list, 500)).toBe(3);
		expect(gapTop(list, 1)).toBe(44);
		expect(gapTop(list, 3)).toBe(128);
		expect(gapTop([], 0)).toBeNull();
	});

	it("slides what lies between the old place and the gap by one row", () => {
		// Row at 44 is dragged up to the gap at 0: the rows from 0 up to it move down.
		expect([0, 44, 88].map(top => slideDelta(top, 44, 0, 44))).toEqual([44, 0, 0]);
		// Dragged down to the gap at the end (132): what lies after it moves up.
		expect([0, 44, 88].map(top => slideDelta(top, 0, 132, 44))).toEqual([0, -44, -44]);
		expect(slideDelta(88, 44, 88, 44)).toBe(0);
	});

	it("sweeps the rows between the pressed one and the one under the pointer, either way", () => {
		const list = rows(0, 44, 88, 132);
		expect(rowsBetween(list, "r1", "r3")).toEqual(["r1", "r2", "r3"]);
		expect(rowsBetween(list, "r2", "r0")).toEqual(["r0", "r1", "r2"]);
		expect(rowsBetween(list, "r1", "nope")).toEqual([]);
		expect(rowAt(list, -50)).toBe("r0");
		expect(rowAt(list, 60)).toBe("r1");
		expect(rowAt(list, 900)).toBe("r3");
	});
});
