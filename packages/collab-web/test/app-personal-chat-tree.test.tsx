import { describe, expect, it } from "bun:test";
import type { PersonalSettings, PersonalStatus } from "@oh-my-pi/pi-wire/personal";
import { PERSONAL_DEFAULTS, PERSONAL_LOGIN_COMMAND } from "@oh-my-pi/pi-wire/personal";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsForms } from "../src/components/personal/SettingsTab";
import { type CompanionSnapshot, INITIAL_SNAPSHOT } from "../src/lib/companion";
import type { ComputerHandle } from "../src/lib/computers";
import {
	chatTreeLine,
	formFromSettings,
	groupChange,
	groupDirty,
	resetGroup,
	syncForm,
} from "../src/lib/personal-settings";
import { NO_PERSONAL, PersonalContext, type PersonalControl } from "../src/lib/use-personal";

const NOW = 1_800_000_000_000;

const settings = (over: Partial<PersonalSettings> = {}): PersonalSettings => ({
	limits: { ...PERSONAL_DEFAULTS.limits },
	review: { ...PERSONAL_DEFAULTS.review },
	rollover: { ...PERSONAL_DEFAULTS.rollover },
	backup: { folder: null },
	sources: [],
	...over,
});

const computer = (over: Partial<CompanionSnapshot> = {}): ComputerHandle => ({
	id: "home",
	name: "mac",
	client: {} as ComputerHandle["client"],
	snap: { ...INITIAL_SNAPSHOT, phase: "live", machine: "mac", canPersonal: true, ...over },
	error: null,
});

const status = (over: Partial<PersonalStatus> = {}): PersonalStatus => {
	const window = { usd: 1, limitUsd: 5, level: "ok", since: NOW } as const;
	return {
		setUp: true,
		enabled: true,
		homeComputer: { computerId: "home", machine: "mac" },
		login: { state: "ready", providers: ["anthropic"], command: PERSONAL_LOGIN_COMMAND, checkedAt: NOW },
		run: "idle",
		session: null,
		spend: { day: window, month: { ...window, limitUsd: 50 } },
		backups: { folder: "/b", sameDisk: false, lastAt: null, lastOk: null, dailyKept: 0, monthlyKept: 0, nextAt: null },
		review: { lastAt: null, ok: null, costUsd: null, proposals: 0, nextAt: null },
		nextRolloverAt: null,
		counts: { questions: 0, proposals: 0, digests: 0 },
		rev: 1,
		...over,
	};
};

const render = (home: ComputerHandle, saved: PersonalSettings, homeStatus: PersonalStatus): string => {
	const value: PersonalControl = {
		...NO_PERSONAL,
		home: { computer: home, status: homeStatus, offline: false, duplicates: [] },
	};
	return renderToStaticMarkup(
		<PersonalContext.Provider value={value}>
			<SettingsForms answer={{ settings: saved, mcpServers: [] }} />
		</PersonalContext.Provider>,
	);
};

describe("the memory choice in the settings form", () => {
	it("is recall for a companion that sent no mode, and clean", () => {
		const base = settings();
		expect(formFromSettings(base).memoryMode).toBe("recall");
		expect(groupDirty("memory", formFromSettings(base), base)).toBe(false);
		expect(groupChange("memory", formFromSettings(base), base)).toEqual({ patch: {}, error: null });
	});

	it("sends only the mode, and only when it changed", () => {
		const base = settings({ memoryMode: "recall" });
		const form = { ...formFromSettings(base), memoryMode: "chat-tree" } as const;
		expect(groupChange("memory", form, base)).toEqual({ patch: { memoryMode: "chat-tree" }, error: null });
		expect(groupDirty("memory", form, base)).toBe(true);
		const saved = settings({ memoryMode: "chat-tree" });
		expect(groupChange("memory", form, saved).patch).toEqual({});
		expect(groupChange("memory", { ...form, memoryMode: "recall" }, saved).patch).toEqual({ memoryMode: "recall" });
	});

	it("takes another device's change into a clean group and keeps an edit in progress", () => {
		const before = settings({ memoryMode: "recall" });
		const after = settings({ memoryMode: "chat-tree" });
		expect(syncForm(formFromSettings(before), before, after).memoryMode).toBe("chat-tree");
		const editing = { ...formFromSettings(before), memoryMode: "chat-tree" } as const;
		expect(syncForm(editing, before, settings({ memoryMode: "recall", limits: { dayUsd: 9, monthUsd: 9 } })).memoryMode).toBe(
			"chat-tree",
		);
		expect(resetGroup(editing, "memory", before).memoryMode).toBe("recall");
	});
});

describe("the chat's numbers on one line", () => {
	it("names messages, view size in KB, lines still being summarised and failed summaries", () => {
		expect(chatTreeLine({ messages: 1204, nodesPending: 3, viewBytes: 96_400, compactionsFailed: 2 })).toBe(
			"1,204 messages · view 96 KB · 3 lines still being summarised · 2 failed summaries",
		);
		expect(chatTreeLine({ messages: 1, nodesPending: 1, viewBytes: 0, compactionsFailed: 1 })).toBe(
			"1 message · view 0 KB · 1 line still being summarised · 1 failed summary",
		);
	});
});

describe("Settings → Personal agent → Memory mode", () => {
	const chat = { messages: 1204, nodesPending: 3, viewBytes: 96_400, compactionsFailed: 0 };

	it("offers the choice only when the home computer says canPersonalChatTree", () => {
		const html = render(computer({ canPersonalChatTree: true }), settings(), status());
		expect(html).toContain("Memory mode");
		expect(html).toContain("Daily sessions with recall");
		expect(html).toContain("One endless chat");
		expect(html).toContain('aria-label="Rollover time"');

		for (const old of [computer({ canPersonalChatTree: false }), computer()]) {
			const plain = render(old, settings(), status());
			expect(plain).not.toContain("One endless chat");
			expect(plain).not.toContain("Daily sessions with recall");
			expect(plain).toContain('aria-label="Rollover time"');
		}
	});

	it("hides the rollover time and shows the stats line in chat-tree mode", () => {
		const html = render(
			computer({ canPersonalChatTree: true }),
			settings({ memoryMode: "chat-tree" }),
			status({ chatTree: chat }),
		);
		expect(html).toContain("One endless chat");
		expect(html).not.toContain('aria-label="Rollover time"');
		expect(html).not.toContain("Daily rollover");
		expect(html).toContain("1,204 messages · view 96 KB · 3 lines still being summarised · 0 failed summaries");
	});

	it("shows no stats line before the session has written its numbers, nor in recall mode", () => {
		const none = render(computer({ canPersonalChatTree: true }), settings({ memoryMode: "chat-tree" }), status());
		expect(none).not.toContain("still being summarised");
		const recall = render(computer({ canPersonalChatTree: true }), settings(), status());
		expect(recall).not.toContain("still being summarised");
	});

	it("keeps the rollover time when an old companion reports chat-tree, since it cannot run it", () => {
		const html = render(computer(), settings({ memoryMode: "chat-tree" }), status());
		expect(html).toContain('aria-label="Rollover time"');
		expect(html).not.toContain("One endless chat");
	});
});
