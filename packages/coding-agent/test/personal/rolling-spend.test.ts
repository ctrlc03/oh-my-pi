import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import {
	appendSpendLedger,
	dayStart,
	monthStart,
	RollingSpendController,
	RollingSpendExceededError,
	type RollingSpendHost,
	SPEND_LEDGER_FILE,
} from "../../src/session/rolling-spend";
import { cfgSessionSpendLimitsDayUsd } from "../../src/session/settings";
import { SPEND_CAP_NOTICE_SOURCE, SpendCapController, SpendCapExceededError } from "../../src/session/spend-cap";

const HOUR = 60 * 60 * 1000;

interface Notice {
	level: string;
	message: string;
	source: string;
}

let dir: string;
let now: number;
let usage: { costUsd: number; tokens: number };
let notices: Notice[];

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "rolling-spend-"));
	// Mid-month, mid-afternoon, local time.
	now = new Date(2026, 4, 14, 15, 0, 0).getTime();
	usage = { costUsd: 0, tokens: 0 };
	notices = [];
});

afterEach(() => fs.rm(dir, { recursive: true, force: true }));

function controller(
	settings: Record<string, unknown>,
	sessionId = "sess-1",
): { rolling: RollingSpendController; host: RollingSpendHost } {
	const host: RollingSpendHost = {
		settings: Settings.isolated(settings),
		agentDir: dir,
		sessionId: () => sessionId,
		readSpend: () => ({ ...usage }),
		emitNotice: (level, message, source) => notices.push({ level, message, source }),
	};
	return { rolling: new RollingSpendController(host, { now: () => now }), host };
}

const ledger = () => path.join(dir, SPEND_LEDGER_FILE);
const lines = async () => (await Bun.file(ledger()).text()).trim().split("\n");

describe("windows", () => {
	it("start at local midnight and the first of the month", () => {
		expect(dayStart(now)).toBe(new Date(2026, 4, 14).getTime());
		expect(monthStart(now)).toBe(new Date(2026, 4, 1).getTime());
	});
});

describe("RollingSpendController", () => {
	it("is inert without Personal and without a limit: nothing read, written or refused", async () => {
		const { rolling } = controller({});
		expect(rolling.isActive()).toBe(false);
		usage.costUsd = 100;
		rolling.onTurnEnd();
		rolling.assertCanPrompt();
		expect(rolling.shouldStop()).toBe(false);
		expect(rolling.capped()).toBeUndefined();
		expect(await Bun.file(ledger()).exists()).toBe(false);
	});

	it("is active under personal.enabled even with no limit, and keeps the ledger", async () => {
		const { rolling } = controller({ "personal.enabled": true });
		rolling.onTurnEnd();
		usage.costUsd = 1.5;
		usage.tokens = 300;
		rolling.onTurnEnd();
		const [entry] = (await lines()).map(line => JSON.parse(line));
		expect(entry).toEqual({ at: now, sessionId: "sess-1", costUsd: 1.5, tokens: 300 });
		expect(rolling.status().level).toBe("off");
		expect(rolling.capped()).toBeUndefined();
	});

	it("appends only what was spent since the last line, and not what the session had before it started counting", async () => {
		usage.costUsd = 7;
		const { rolling } = controller({ "session.spendLimits.dayUsd": 100 });
		rolling.onTurnEnd();
		usage.costUsd = 9;
		rolling.onTurnEnd();
		usage.costUsd = 9.5;
		rolling.onTurnEnd();
		expect((await lines()).map(line => JSON.parse(line).costUsd)).toEqual([2, 0.5]);
		expect(rolling.status().day.usedUsd).toBeCloseTo(2.5);
	});

	it("counts spend not yet written to the ledger, so a turn cannot slip past the cap", () => {
		const { rolling } = controller({ "session.spendLimits.dayUsd": 5 });
		expect(rolling.status().day.usedUsd).toBe(0);
		usage.costUsd = 6;
		expect(rolling.status().capped).toBe("day");
		expect(rolling.shouldStop()).toBe(true);
	});

	it("sums every session of the profile", () => {
		appendSpendLedger(ledger(), { at: now - HOUR, sessionId: "other", costUsd: 4, tokens: 0 });
		appendSpendLedger(ledger(), { at: now - 2 * HOUR, sessionId: "review", costUsd: 0.75, tokens: 0 });
		const { rolling } = controller({ "session.spendLimits.dayUsd": 5 });
		expect(rolling.status()).toMatchObject({ level: "warning", day: { usedUsd: 4.75, level: "warning" } });
		usage.costUsd = 0.5;
		expect(rolling.status().capped).toBe("day");
	});

	it("refuses prompts and ends the loop at the limit, with an error notice on the budget source", () => {
		const { rolling } = controller({ "session.spendLimits.dayUsd": 5 });
		rolling.onTurnEnd();
		usage.costUsd = 6;
		rolling.onTurnEnd();
		expect(notices.at(-1)).toMatchObject({ level: "error", source: SPEND_CAP_NOTICE_SOURCE });
		expect(notices.at(-1)?.message).toContain("session.spendLimits.dayUsd");
		expect(() => rolling.assertCanPrompt()).toThrow(RollingSpendExceededError);
		expect(rolling.shouldStop()).toBe(true);
		expect(rolling.capped()).toBe("day");
		const before = notices.length;
		rolling.onTurnEnd();
		expect(notices.length).toBe(before);
	});

	it("warns once on the way to the limit", () => {
		const { rolling } = controller({ "session.spendLimits.dayUsd": 10 });
		rolling.onTurnEnd();
		usage.costUsd = 8.5;
		rolling.onTurnEnd();
		rolling.onTurnEnd();
		expect(notices.map(n => n.level)).toEqual(["warning"]);
	});

	it("lifts the day cap at midnight while the month keeps counting", () => {
		appendSpendLedger(ledger(), { at: now - HOUR, sessionId: "other", costUsd: 6, tokens: 0 });
		const { rolling } = controller({ "session.spendLimits.dayUsd": 5, "session.spendLimits.monthUsd": 100 });
		expect(rolling.status().capped).toBe("day");
		now = new Date(2026, 4, 15, 0, 0, 1).getTime();
		const next = rolling.status();
		expect(next.capped).toBeUndefined();
		expect(next.day.usedUsd).toBe(0);
		expect(next.month.usedUsd).toBe(6);
		expect(() => rolling.assertCanPrompt()).not.toThrow();
		expect(rolling.shouldStop()).toBe(false);
	});

	it("lifts the month cap on the first of the next month, across a year end", () => {
		now = new Date(2026, 11, 20, 12, 0, 0).getTime();
		appendSpendLedger(ledger(), { at: new Date(2026, 11, 2).getTime(), sessionId: "other", costUsd: 60, tokens: 0 });
		const { rolling } = controller({ "session.spendLimits.monthUsd": 50 });
		const december = rolling.status();
		expect(december.capped).toBe("month");
		expect(december.month.endsAt).toBe(new Date(2027, 0, 1).getTime());
		now = new Date(2027, 0, 1, 0, 0, 5).getTime();
		expect(rolling.status().capped).toBeUndefined();
		expect(rolling.status().month.usedUsd).toBe(0);
	});

	it("ignores lines that are torn or not entries, and a line still being written", async () => {
		await Bun.write(
			ledger(),
			`${JSON.stringify({ at: now, sessionId: "a", costUsd: 2, tokens: 1 })}\nnot json\n{"at":"x"}\n{"at":${now},"costUs`,
		);
		const { rolling } = controller({ "session.spendLimits.dayUsd": 100 });
		expect(rolling.status().day.usedUsd).toBe(2);
		await fs.appendFile(ledger(), `d":3,"sessionId":"b"}\n`);
		expect(rolling.status().day.usedUsd).toBe(5);
	});

	it("starts over when the ledger is replaced by a shorter file", async () => {
		appendSpendLedger(ledger(), { at: now, sessionId: "a", costUsd: 4, tokens: 0 });
		appendSpendLedger(ledger(), { at: now, sessionId: "a", costUsd: 4, tokens: 0 });
		const { rolling } = controller({ "session.spendLimits.dayUsd": 100 });
		expect(rolling.status().day.usedUsd).toBe(8);
		await Bun.write(ledger(), `${JSON.stringify({ at: now, sessionId: "a", costUsd: 1, tokens: 0 })}\n`);
		expect(rolling.status().day.usedUsd).toBe(1);
	});

	it("reads the ledger incrementally across many checks", () => {
		const { rolling } = controller({ "session.spendLimits.dayUsd": 1000 });
		for (let i = 0; i < 50; i++) {
			appendSpendLedger(ledger(), { at: now, sessionId: "a", costUsd: 1, tokens: 0 });
			expect(rolling.status().day.usedUsd).toBe(i + 1);
		}
	});

	it("follows a settings change without a restart", () => {
		const { rolling, host } = controller({});
		usage.costUsd = 0;
		appendSpendLedger(ledger(), { at: now, sessionId: "a", costUsd: 20, tokens: 0 });
		expect(rolling.capped()).toBeUndefined();
		cfgSessionSpendLimitsDayUsd.override(host.settings, 5);
		expect(rolling.capped()).toBe("day");
		cfgSessionSpendLimitsDayUsd.override(host.settings, 0);
		expect(rolling.capped()).toBeUndefined();
	});

	it("is a SpendCapExceededError so print mode exits with the spend-cap code", () => {
		const { rolling } = controller({ "session.spendLimits.dayUsd": 1 });
		rolling.assertCanPrompt();
		usage.costUsd = 2;
		expect(() => rolling.assertCanPrompt()).toThrow(SpendCapExceededError);
	});
});

describe("concurrent appends", () => {
	it("never interleave lines across processes", async () => {
		const modulePath = path.resolve(import.meta.dir, "../../src/session/rolling-spend.ts");
		const writers = 6;
		const perWriter = 150;
		const script = `
			import { appendSpendLedger } from ${JSON.stringify(modulePath)};
			const [file, id, count] = process.argv.slice(1);
			for (let i = 0; i < Number(count); i++) {
				appendSpendLedger(file, { at: Date.now(), sessionId: id, costUsd: 0.01, tokens: 1000, });
			}
		`;
		const children = Array.from({ length: writers }, (_, i) =>
			Bun.spawn(["bun", "-e", script, ledger(), `writer-${i}`, String(perWriter)], {
				stdout: "ignore",
				stderr: "pipe",
			}),
		);
		for (const child of children) expect(await child.exited).toBe(0);
		const all = await lines();
		expect(all).toHaveLength(writers * perWriter);
		const bySession = new Map<string, number>();
		for (const line of all) {
			const entry = JSON.parse(line);
			bySession.set(entry.sessionId, (bySession.get(entry.sessionId) ?? 0) + 1);
		}
		expect([...bySession.values()]).toEqual(Array(writers).fill(perWriter));
	}, 60_000);
});

describe("SpendCapController with a rolling limit", () => {
	function capController(settings: Record<string, unknown>, enforced = true) {
		const { rolling, host } = controller(settings);
		return new SpendCapController(
			{ settings: host.settings, readSpend: host.readSpend, emitNotice: host.emitNotice },
			enforced,
			rolling,
		);
	}

	it("stops, refuses and reports the capped window", () => {
		const cap = capController({ "session.spendLimits.dayUsd": 3 });
		cap.assertCanPrompt();
		usage.costUsd = 4;
		expect(cap.shouldStop()).toBe(true);
		expect(cap.rollingCapped()).toBe("day");
		expect(() => cap.assertCanPrompt()).toThrow(RollingSpendExceededError);
		cap.onTurnEnd();
		expect(JSON.parse(readFileSync(ledger(), "utf8").trim().split("\n")[0]).costUsd).toBe(4);
	});

	it("does nothing for a session that does not enforce (a subagent)", () => {
		const cap = capController({ "session.spendLimits.dayUsd": 3 }, false);
		usage.costUsd = 4;
		expect(cap.shouldStop()).toBe(false);
		expect(cap.rollingCapped()).toBeUndefined();
		expect(() => cap.assertCanPrompt()).not.toThrow();
	});

	it("leaves the per-session limits alone when no rolling limit is set", () => {
		const cap = capController({});
		usage.costUsd = 1000;
		expect(cap.shouldStop()).toBe(false);
		expect(cap.rollingCapped()).toBeUndefined();
	});
});
