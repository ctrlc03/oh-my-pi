import { describe, expect, it } from "bun:test";
import type { PersonalSettings, PersonalSource } from "@oh-my-pi/pi-wire/personal";
import {
	countsLine,
	draftFromSource,
	estimateTokens,
	formFromSettings,
	groupChange,
	groupDirty,
	isAbsolutePath,
	newSourceId,
	parseMoney,
	parseTime,
	resetGroup,
	runControls,
	sourceFromDraft,
	syncForm,
	upsertSource,
	validateDraft,
	whenLabel,
} from "../src/lib/personal-settings";

const source: PersonalSource = {
	id: "src-aaaa0001",
	label: "Work email",
	kind: "mcp-poll",
	mcpServer: "gmail",
	everyMinutes: 30,
	prompt: "Anything from my landlord",
	enabled: true,
	lastPollAt: 1_700_000_000_000,
	lastError: "timed out",
};

const base: PersonalSettings = {
	limits: { dayUsd: 5, monthUsd: 50 },
	review: { enabled: true, time: "03:30", budgetUsd: 0.5 },
	rollover: { time: "04:00" },
	backup: { folder: null },
	sources: [source],
};

describe("parseMoney", () => {
	it("reads dollar amounts", () => {
		expect(parseMoney("5")).toBe(5);
		expect(parseMoney(" $5.50 ")).toBe(5.5);
		expect(parseMoney("0")).toBe(0);
		expect(parseMoney("0.0125")).toBe(0.0125);
	});

	it("refuses anything else", () => {
		for (const text of ["", "-1", "5.", ".5", "1e3", "five", "5,50", "1.23456", "100000.01", "NaN"]) {
			expect(parseMoney(text)).toBeNull();
		}
	});
});

describe("parseTime", () => {
	it("normalizes to HH:MM", () => {
		expect(parseTime("04:00")).toBe("04:00");
		expect(parseTime("4:05")).toBe("04:05");
		expect(parseTime("23:59:30")).toBe("23:59");
		expect(parseTime(" 00:00 ")).toBe("00:00");
	});

	it("refuses things that are not a time of day", () => {
		for (const text of ["", "24:00", "12:60", "1200", "12:5", "noon", "12:00 pm"]) expect(parseTime(text)).toBeNull();
	});
});

describe("isAbsolutePath", () => {
	it("accepts a root, a drive letter or a share", () => {
		expect(isAbsolutePath("/Volumes/backup")).toBe(true);
		expect(isAbsolutePath("C:\\backups")).toBe(true);
		expect(isAbsolutePath("d:/backups")).toBe(true);
		expect(isAbsolutePath("\\\\nas\\share")).toBe(true);
	});

	it("refuses relative paths", () => {
		for (const path of ["backups", "./backups", "~/backups", "C:", "../x"]) expect(isAbsolutePath(path)).toBe(false);
	});
});

describe("estimateTokens", () => {
	it("counts four characters to a token, rounding up", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("abcd")).toBe(1);
		expect(estimateTokens("abcde")).toBe(2);
	});
});

describe("settings form", () => {
	it("starts clean", () => {
		const form = formFromSettings(base);
		for (const group of ["limits", "review", "rollover", "backup"] as const) {
			expect(groupDirty(group, form, base)).toBe(false);
			expect(groupChange(group, form, base).patch).toEqual({});
		}
	});

	it("sends only the fields that changed", () => {
		const form = { ...formFromSettings(base), dayUsd: "8" };
		expect(groupChange("limits", form, base)).toEqual({ patch: { limits: { dayUsd: 8 } }, error: null });
		const review = { ...formFromSettings(base), reviewTime: "2:15", reviewBudgetUsd: "0.50" };
		expect(groupChange("review", review, base)).toEqual({ patch: { review: { time: "02:15" } }, error: null });
		const off = { ...formFromSettings(base), reviewEnabled: false };
		expect(groupChange("review", off, base).patch).toEqual({ review: { enabled: false } });
	});

	it("treats a retyped but equal value as clean", () => {
		const form = { ...formFromSettings(base), dayUsd: "5.0", rolloverTime: "4:00" };
		expect(groupDirty("limits", form, base)).toBe(false);
		expect(groupDirty("rollover", form, base)).toBe(false);
	});

	it("explains what is wrong and stays dirty", () => {
		const money = { ...formFromSettings(base), monthUsd: "lots" };
		expect(groupChange("limits", money, base).error).toContain("dollars");
		expect(groupDirty("limits", money, base)).toBe(true);
		const time = { ...formFromSettings(base), rolloverTime: "" };
		expect(groupChange("rollover", time, base).error).toContain("time of day");
		const folder = { ...formFromSettings(base), backupFolder: "relative/dir" };
		expect(groupChange("backup", folder, base).error).toBe("The backup folder must be an absolute path.");
	});

	it("maps an empty folder to the default (null) and back", () => {
		const custom: PersonalSettings = { ...base, backup: { folder: "/Volumes/b" } };
		const cleared = { ...formFromSettings(custom), backupFolder: "  " };
		expect(groupChange("backup", cleared, custom).patch).toEqual({ backup: { folder: null } });
		const typed = { ...formFromSettings(base), backupFolder: " /Volumes/b " };
		expect(groupChange("backup", typed, base).patch).toEqual({ backup: { folder: "/Volumes/b" } });
	});

	it("re-syncs only the groups nothing was typed into", () => {
		const next: PersonalSettings = { ...base, limits: { dayUsd: 9, monthUsd: 90 }, rollover: { time: "05:00" } };
		const form = { ...formFromSettings(base), dayUsd: "7" };
		const synced = syncForm(form, base, next);
		expect(synced.dayUsd).toBe("7");
		expect(synced.monthUsd).toBe("50");
		expect(synced.rolloverTime).toBe("05:00");
	});

	it("resets one group to the saved values", () => {
		const form = { ...formFromSettings(base), dayUsd: "7", rolloverTime: "09:00" };
		const reset = resetGroup(form, "limits", base);
		expect(reset.dayUsd).toBe("5");
		expect(reset.rolloverTime).toBe("09:00");
	});
});

describe("sources", () => {
	const servers = ["gmail", "calendar"];

	it("starts a draft on the first server", () => {
		expect(draftFromSource(null, servers)).toMatchObject({
			id: null,
			mcpServer: "gmail",
			everyMinutes: "30",
			enabled: true,
		});
		expect(draftFromSource(source, servers)).toMatchObject({
			id: source.id,
			label: "Work email",
			everyMinutes: "30",
		});
	});

	it("validates a draft", () => {
		const draft = draftFromSource(source, servers);
		expect(validateDraft(draft, servers)).toBeNull();
		expect(validateDraft({ ...draft, label: "  " }, servers)).toContain("name");
		expect(validateDraft({ ...draft, mcpServer: "slack" }, servers)).toContain("mcp.json");
		expect(validateDraft({ ...draft, everyMinutes: "4" }, servers)).toContain("minutes");
		expect(validateDraft({ ...draft, everyMinutes: "1.5" }, servers)).toContain("minutes");
		expect(validateDraft({ ...draft, prompt: " " }, servers)).toContain("check and report");
	});

	it("builds the source: trimmed, history kept, old error dropped", () => {
		const draft = { ...draftFromSource(source, servers), label: " Mail ", everyMinutes: "15" };
		expect(sourceFromDraft(draft, source)).toEqual({
			id: source.id,
			label: "Mail",
			kind: "mcp-poll",
			mcpServer: "gmail",
			everyMinutes: 15,
			prompt: "Anything from my landlord",
			enabled: true,
			lastPollAt: 1_700_000_000_000,
		});
	});

	it("gives a new source an id", () => {
		const draft = { ...draftFromSource(null, servers), label: "Cal", prompt: "Today's events" };
		const made = sourceFromDraft(draft, null, () => "src-test0001");
		expect(made.id).toBe("src-test0001");
		expect(made.lastPollAt).toBeUndefined();
		expect(newSourceId()).toMatch(/^src-[0-9a-f]{8}$/);
	});

	it("replaces by id or appends", () => {
		const other = { ...source, id: "src-bbbb0002" };
		expect(upsertSource([source], { ...source, label: "New" })).toEqual([{ ...source, label: "New" }]);
		expect(upsertSource([source], other)).toEqual([source, other]);
	});
});

describe("whenLabel", () => {
	const now = new Date(2026, 9, 14, 21, 30).getTime(); // Wed 14 Oct 2026, local

	it("says today and tomorrow", () => {
		expect(whenLabel(new Date(2026, 9, 14, 23, 0).getTime(), now)).toBe("today 23:00");
		expect(whenLabel(new Date(2026, 9, 15, 4, 0).getTime(), now)).toBe("tomorrow 04:00");
	});

	it("names the weekday within the week, then the date", () => {
		expect(whenLabel(new Date(2026, 9, 17, 9, 5).getTime(), now)).toBe("Sat 09:05");
		expect(whenLabel(new Date(2026, 9, 20, 9, 5).getTime(), now)).toBe("Tue 09:05");
		expect(whenLabel(new Date(2026, 9, 21, 9, 5).getTime(), now)).toBe("21 Oct 09:05");
	});

	it("counts calendar days across the month end and for earlier days", () => {
		const lateNow = new Date(2026, 9, 31, 23, 59).getTime();
		expect(whenLabel(new Date(2026, 10, 1, 0, 1).getTime(), lateNow)).toBe("tomorrow 00:01");
		expect(whenLabel(new Date(2026, 9, 13, 4, 0).getTime(), now)).toBe("13 Oct 04:00");
	});
});

describe("status wording", () => {
	it("lists what waits", () => {
		expect(countsLine({ questions: 0, proposals: 0, digests: 0 })).toBeNull();
		expect(countsLine({ questions: 2, proposals: 1, digests: 0 })).toBe("2 questions, 1 proposal waiting");
		expect(countsLine({ questions: 1, proposals: 0, digests: 3 })).toBe("1 question, 3 digests waiting");
	});

	it("offers the controls that apply", () => {
		expect(runControls("stopped")).toEqual({ start: true, stop: false, restart: false });
		expect(runControls("failed")).toEqual({ start: true, stop: false, restart: false });
		expect(runControls("starting")).toEqual({ start: false, stop: true, restart: false });
		expect(runControls("working")).toEqual({ start: false, stop: true, restart: true });
		expect(runControls("off")).toEqual({ start: false, stop: false, restart: false });
	});
});
