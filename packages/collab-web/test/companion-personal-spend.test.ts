import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PERSONAL_DEFAULTS, type PersonalSpendWindow } from "@oh-my-pi/pi-wire/personal";
import {
	createPersonalSpend,
	parseLedger,
	spendLevel,
	spendNotice,
	spendWindows,
	sumLedger,
	windowAlert,
	windowStarts,
} from "../scripts/companion-personal-spend";
import { openPersonalState, personalPaths } from "../scripts/companion-personal-store";

const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const line = (when: number, costUsd: number) => `${JSON.stringify({ at: when, sessionId: "s", costUsd, tokens: 1 })}\n`;

describe("ledger windows", () => {
	it("starts the day at local midnight and the month on the first", () => {
		const starts = windowStarts(at(2026, 10, 14));
		expect(starts.day).toBe(at(2026, 10, 14, 0));
		expect(starts.month).toBe(at(2026, 10, 1, 0));
	});

	it("counts an entry at midnight for the new day and one a minute before for the old one", () => {
		const entries = parseLedger(
			line(at(2026, 10, 13, 23, 59), 1) + line(at(2026, 10, 14, 0, 0), 2) + line(at(2026, 10, 14, 9), 4),
		);
		expect(sumLedger(entries, at(2026, 10, 14, 10))).toEqual({ day: 6, month: 7 });
		expect(sumLedger(entries, at(2026, 10, 13, 23, 59))).toEqual({ day: 1, month: 1 });
	});

	it("leaves the previous month out at month end", () => {
		const entries = parseLedger(line(at(2026, 9, 30, 23, 59), 3) + line(at(2026, 10, 1, 0, 0), 5));
		expect(sumLedger(entries, at(2026, 10, 1, 8))).toEqual({ day: 5, month: 5 });
		expect(sumLedger(entries, at(2026, 9, 30, 23, 59))).toEqual({ day: 3, month: 3 });
	});

	it("skips a torn last line, junk, and negative or non-numeric costs", () => {
		const text = `${line(at(2026, 10, 14), 1)}not json\n{"at":1,"costUsd":-5}\n{"at":"x","costUsd":1}\n{"at":${at(2026, 10, 14)},"costUs`;
		expect(parseLedger(text)).toEqual([{ at: at(2026, 10, 14), costUsd: 1 }]);
	});
});

describe("levels", () => {
	it("is off without a limit, ok, warning from 80%, capped at 100%", () => {
		expect(spendLevel(100, null)).toBe("off");
		expect(spendLevel(3.99, 5)).toBe("ok");
		expect(spendLevel(4, 5)).toBe("warning");
		expect(spendLevel(4.99, 5)).toBe("warning");
		expect(spendLevel(5, 5)).toBe("capped");
	});

	it("treats a limit of 0 as none and carries since", () => {
		const now = at(2026, 10, 14);
		const spend = spendWindows({ day: 6, month: 9 }, { dayUsd: 0, monthUsd: 10 }, now);
		expect(spend.day).toEqual({ usd: 6, limitUsd: null, level: "off", since: at(2026, 10, 14, 0) });
		expect(spend.month).toMatchObject({ limitUsd: 10, level: "warning", since: at(2026, 10, 1, 0) });
	});
});

describe("windowAlert", () => {
	const win = (usd: number, over: Partial<PersonalSpendWindow> = {}): PersonalSpendWindow => ({
		usd,
		limitUsd: 5,
		level: spendLevel(usd, over.limitUsd === undefined ? 5 : over.limitUsd),
		since: 1000,
		...over,
	});

	it("warns once at 80%, caps once at 100%, and stays quiet between", () => {
		const warn = windowAlert(undefined, win(4));
		expect(warn.notice).toBe("warning");
		expect(windowAlert(warn.next, win(4.5)).notice).toBeNull();
		const cap = windowAlert(warn.next, win(5));
		expect(cap.notice).toBe("capped");
		expect(windowAlert(cap.next, win(9)).notice).toBeNull();
	});

	it("sends only the capped alert when spend jumps past the limit", () => {
		const jump = windowAlert(undefined, win(7));
		expect(jump.notice).toBe("capped");
		expect(windowAlert(jump.next, win(7)).notice).toBeNull();
	});

	it("starts over in a new window and when the limit changes", () => {
		const cap = windowAlert(undefined, win(5)).next;
		expect(windowAlert(cap, win(5, { since: 2000 })).notice).toBe("capped");
		expect(windowAlert(cap, win(5, { limitUsd: 4, level: "capped" })).notice).toBe("capped");
		expect(windowAlert(cap, win(5, { limitUsd: 10, level: "ok" })).notice).toBeNull();
	});

	it("words the notices for the day and the month", () => {
		const day = spendNotice("day", win(5), "capped");
		expect(day.title).toContain("daily");
		expect(day.body).toContain("$5.00 of $5.00 spent today");
		expect(spendNotice("month", win(4), "warning").title).toContain("80%");
	});
});

describe("PersonalSpendMonitor", () => {
	let dir: string;
	let paths: ReturnType<typeof personalPaths>;
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "personal-spend-"));
		paths = personalPaths(dir);
		await fs.mkdir(paths.agentDir, { recursive: true });
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	async function harness(opts: { enabled?: boolean } = {}) {
		const state = await openPersonalState(paths.stateFile);
		await state.update(s => ({ ...s, settings: { ...s.settings, limits: { dayUsd: 5, monthUsd: 50 } } }));
		let now = at(2026, 10, 14, 9);
		const alerts: { title: string; body: string; tag: string }[] = [];
		const monitor = createPersonalSpend({
			paths,
			state,
			now: () => now,
			enabled: () => opts.enabled ?? true,
			alert: async a => void alerts.push(a),
			onError: err => {
				throw err;
			},
		});
		return {
			monitor,
			alerts,
			state,
			clock: (next: number) => {
				now = next;
			},
		};
	}

	it("alerts once at 80% and once at 100% of the day, and again the next day", async () => {
		const h = await harness();
		await fs.writeFile(paths.ledgerFile, line(at(2026, 10, 14, 8), 4.2));
		await h.monitor.tick();
		await h.monitor.tick();
		expect(h.alerts.map(a => a.tag)).toEqual(["personal-spend-day-warning"]);
		await fs.appendFile(paths.ledgerFile, line(at(2026, 10, 14, 8, 30), 1));
		await h.monitor.tick();
		await h.monitor.tick();
		expect(h.alerts.map(a => a.tag)).toEqual(["personal-spend-day-warning", "personal-spend-day-capped"]);
		expect(await h.monitor.capped()).toBe("day");
		expect(await h.monitor.limitsAllow()).toBe(false);

		// Past midnight the day window is empty: un-capped, and the flags start over.
		h.clock(at(2026, 10, 15, 0, 1));
		expect(await h.monitor.limitsAllow()).toBe(true);
		await h.monitor.tick();
		h.clock(at(2026, 10, 15, 0, 10));
		await fs.appendFile(paths.ledgerFile, line(at(2026, 10, 15, 0, 5), 4.5));
		await h.monitor.tick();
		expect(h.alerts.map(a => a.tag).at(-1)).toBe("personal-spend-day-warning");
		expect(h.alerts).toHaveLength(3);
	});

	it("caps on the month window across days", async () => {
		const h = await harness();
		await fs.writeFile(
			paths.ledgerFile,
			line(at(2026, 10, 2), 30) + line(at(2026, 10, 9), 21) + line(at(2026, 9, 30), 99),
		);
		await h.monitor.tick();
		expect(h.alerts.map(a => a.tag)).toEqual(["personal-spend-month-capped"]);
		expect(await h.monitor.capped()).toBe("month");
		const spend = await h.monitor.read();
		expect(spend.month).toMatchObject({ usd: 51, limitUsd: 50, level: "capped" });
		expect(spend.day).toMatchObject({ usd: 0, level: "ok" });
	});

	it("keeps the alert state across a restart", async () => {
		const h = await harness();
		await fs.writeFile(paths.ledgerFile, line(at(2026, 10, 14, 8), 6));
		await h.monitor.tick();
		const reopened = await openPersonalState(paths.stateFile);
		const again: string[] = [];
		const monitor = createPersonalSpend({
			paths,
			state: reopened,
			now: () => at(2026, 10, 14, 10),
			enabled: () => true,
			alert: async a => void again.push(a.tag),
			onError: err => {
				throw err;
			},
		});
		await monitor.tick();
		expect(again).toEqual([]);
	});

	it("reports the new limits at once and re-arms when a limit is raised", async () => {
		const h = await harness();
		await fs.writeFile(paths.ledgerFile, line(at(2026, 10, 14, 8), 6));
		await h.monitor.tick();
		await h.state.update(s => ({ ...s, settings: { ...s.settings, limits: { dayUsd: 20, monthUsd: 50 } } }));
		expect((await h.monitor.read()).day).toMatchObject({ limitUsd: 20, level: "ok" });
		await h.monitor.tick();
		await fs.appendFile(paths.ledgerFile, line(at(2026, 10, 14, 9), 14));
		await h.monitor.tick();
		expect(h.alerts.map(a => a.tag)).toEqual(["personal-spend-day-capped", "personal-spend-day-capped"]);
	});

	it("never alerts or writes while Personal is off, and a missing ledger is zero", async () => {
		const off = await harness({ enabled: false });
		await fs.writeFile(paths.ledgerFile, line(at(2026, 10, 14, 8), 99));
		await off.monitor.tick();
		expect(off.alerts).toEqual([]);
		expect(off.state.read().spendAlerts).toBeUndefined();

		await fs.rm(paths.ledgerFile);
		const on = await harness();
		expect((await on.monitor.read()).day.usd).toBe(0);
		expect(await on.monitor.limitsAllow()).toBe(true);
	});

	it("uses the documented defaults for its warning share", () => {
		expect(PERSONAL_DEFAULTS.spendWarnShare).toBe(0.8);
	});
});
