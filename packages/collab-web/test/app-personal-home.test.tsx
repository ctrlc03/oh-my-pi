import { describe, expect, it } from "bun:test";
import type { PersonalInboxItem, PersonalStatus } from "@oh-my-pi/pi-wire/personal";
import { PERSONAL_DEFAULTS, PERSONAL_LOGIN_COMMAND, PERSONAL_ROUTES } from "@oh-my-pi/pi-wire/personal";
import { renderToStaticMarkup } from "react-dom/server";
import { PersonalSlot } from "../src/components/shell/PersonalEntry";
import { type CompanionHost, type CompanionSnapshot, INITIAL_SNAPSHOT } from "../src/lib/companion";
import { type ComputerHandle, defaultComputer, FEATURES, unavailableReason } from "../src/lib/computers";
import { parseRoute } from "../src/lib/notify-route";
import {
	assembleExport,
	chooseHome,
	diffRows,
	entryState,
	hostableComputers,
	mergeInbox,
	openCount,
	originLabel,
	parsePersonalRoute,
	personalHostOf,
	setupBlockedReason,
	spendBar,
	withoutPersonal,
} from "../src/lib/personal";
import { NO_PERSONAL, PersonalContext, type PersonalControl } from "../src/lib/use-personal";
import { visibleSettingsSections } from "../src/lib/settings-ui";

const NOW = 1_800_000_000_000;

function snap(over: Partial<CompanionSnapshot> = {}): CompanionSnapshot {
	return { ...INITIAL_SNAPSHOT, phase: "live", machine: "mac", canPersonal: true, canStart: true, ...over };
}

function computer(id: string, over: Partial<CompanionSnapshot> = {}): ComputerHandle {
	return { id, name: id, client: {} as ComputerHandle["client"], snap: snap(over), error: null };
}

function host(over: Partial<CompanionHost> = {}): CompanionHost {
	return {
		instanceId: "inst-1",
		sessionId: "s-1",
		sessionName: "docs",
		cwd: "/work/docs",
		model: null,
		startedAt: NOW,
		participants: 1,
		busy: false,
		inputRequired: false,
		relayConnected: true,
		...over,
	};
}

function status(over: Partial<PersonalStatus> = {}): PersonalStatus {
	const window = { usd: 1, limitUsd: 5, level: "ok", since: NOW } as const;
	return {
		setUp: true,
		enabled: true,
		homeComputer: { computerId: "home", machine: "mac" },
		login: { state: "ready", providers: ["anthropic"], command: PERSONAL_LOGIN_COMMAND, checkedAt: NOW },
		run: "idle",
		session: { sessionId: "s-p", instanceId: "inst-p", startedAt: NOW, generation: 1 },
		spend: { day: window, month: { ...window, limitUsd: 50 } },
		backups: {
			folder: "/b",
			sameDisk: false,
			lastAt: null,
			lastOk: null,
			dailyKept: 0,
			monthlyKept: 0,
			nextAt: null,
		},
		review: { lastAt: null, ok: null, costUsd: null, proposals: 0, nextAt: null },
		nextRolloverAt: null,
		counts: { questions: 0, proposals: 0, digests: 0 },
		rev: 1,
		...over,
	};
}

const none: PersonalStatus = status({ setUp: false, enabled: false, run: "off" });

describe("home computer", () => {
	const a = computer("a");
	const b = computer("b");

	it("is none while no computer is set up", () => {
		const choice = chooseHome([a, b], { a: none, b: none }, null);
		expect(choice).toEqual({ computer: null, status: null, offline: false, duplicates: [] });
	});

	it("is the computer whose status says enabled", () => {
		const choice = chooseHome([a, b], { a: none, b: status() }, null);
		expect(choice.computer).toBe(b);
		expect(choice.status?.enabled).toBe(true);
		expect(choice.duplicates).toEqual([]);
	});

	it("takes the first of two enabled computers and reports the other", () => {
		const choice = chooseHome([a, b], { a: status(), b: status() }, null);
		expect(choice.computer).toBe(a);
		expect(choice.duplicates).toEqual([b]);
	});

	it("keeps a turned-off home so it can be turned on again, preferring an enabled one", () => {
		const off = status({ enabled: false, run: "off" });
		expect(chooseHome([a, b], { a: off }, null).computer).toBe(a);
		expect(chooseHome([a, b], { a: off, b: status() }, null).computer).toBe(b);
	});

	it("stands in a remembered home that is not reachable, calmly", () => {
		const gone = computer("a", { phase: "offline", canPersonal: false });
		const choice = chooseHome([gone, b], {}, { computerId: "a", enabled: true });
		expect(choice.computer).toBe(gone);
		expect(choice.offline).toBe(true);
		expect(choice.status).toBeNull();
		expect(chooseHome([gone, b], {}, { computerId: "a", enabled: false }).computer).toBeNull();
		expect(chooseHome([a, b], {}, { computerId: "a", enabled: true }).computer).toBeNull();
	});

	it("marks an unreachable computer that last answered as set up", () => {
		const gone = computer("a", { phase: "offline" });
		const choice = chooseHome([gone], { a: status() }, null);
		expect(choice.offline).toBe(true);
		expect(choice.status?.run).toBe("idle");
	});

	it("refuses to set up a second computer while another is the home", () => {
		const choice = chooseHome([a, b], { a: status() }, null);
		expect(setupBlockedReason(choice, b)).toContain("Personal already lives on a");
		expect(setupBlockedReason(choice, a)).toBeNull();
		expect(setupBlockedReason(chooseHome([a, b], {}, null), b)).toBeNull();
	});

	it("offers only reachable computers that can host", () => {
		const old = computer("old", { canPersonal: false });
		const down = computer("down", { phase: "offline" });
		expect(hostableComputers([a, old, down]).map(c => c.id)).toEqual(["a"]);
	});
});

describe("feature gate", () => {
	it("needs canPersonal and says to update omp", () => {
		expect(FEATURES.personal.can).toBe("canPersonal");
		expect(unavailableReason(computer("a"), "personal")).toBeNull();
		expect(unavailableReason(computer("a", { canPersonal: false }), "personal")).toBe(
			"This computer can't host the Personal agent. Update omp there.",
		);
		expect(defaultComputer([computer("a", { canPersonal: false }), computer("b")], "personal", null, null)?.id).toBe(
			"b",
		);
	});

	it("lists the Personal settings section only while a computer can host it", () => {
		expect(visibleSettingsSections(true, false)).not.toContain("personal");
		expect(visibleSettingsSections(true, true)).toContain("personal");
	});
});

describe("host rows", () => {
	const personal = host({ instanceId: "inst-p", personal: true });
	const plain = host();

	it("finds the live Personal session and hides it from the listing", () => {
		expect(personalHostOf([plain, personal])).toBe(personal);
		expect(personalHostOf([plain])).toBeNull();
		expect(withoutPersonal([plain, personal])).toEqual([plain]);
	});

	it("returns the same array when there is no Personal row, so the listing is untouched", () => {
		const hosts = [plain];
		expect(withoutPersonal(hosts)).toBe(hosts);
	});
});

describe("entry state", () => {
	const alive = host({ personal: true });

	it("is a thread while a session is up and listed", () => {
		expect(entryState(status(), false, alive, true)).toEqual({
			label: "Ready",
			tone: "ok",
			thread: true,
			startable: false,
		});
		expect(entryState(status({ run: "working" }), false, alive, true).tone).toBe("busy");
		expect(entryState(status({ run: "waiting" }), false, alive, true).tone).toBe("warn");
	});

	it("says the spend limit is reached instead of Ready or Waiting for you", () => {
		const day = { usd: 5, limitUsd: 5, level: "capped", since: NOW } as const;
		const month = { usd: 1, limitUsd: 50, level: "ok", since: NOW } as const;
		const capped = (over: Partial<PersonalStatus> = {}): PersonalStatus => status({ spend: { day, month }, ...over });
		expect(entryState(capped(), false, alive, true)).toEqual({
			label: "Spend limit reached",
			tone: "warn",
			thread: true,
			startable: false,
		});
		expect(entryState(capped({ run: "waiting" }), false, alive, true).label).toBe("Spend limit reached");
		expect(entryState(capped({ run: "working" }), false, alive, true).label).toBe("Working");
		expect(entryState(capped({ run: "stopped" }), false, null, true).label).toBe("Stopped");
		const monthly = status({ spend: { day: { ...day, level: "ok" }, month: { ...month, level: "capped" } } });
		expect(entryState(monthly, false, alive, true).label).toBe("Spend limit reached");
	});

	it("offers Start instead of a thread when stopped or failed, if the computer can start", () => {
		expect(entryState(status({ run: "stopped" }), false, null, true)).toEqual({
			label: "Stopped",
			tone: "off",
			thread: false,
			startable: true,
		});
		expect(entryState(status({ run: "failed" }), false, null, true).startable).toBe(true);
		expect(entryState(status({ run: "stopped" }), false, null, false).startable).toBe(false);
	});

	it("shows the state, not a dead thread, between rollovers", () => {
		const between = entryState(status({ run: "starting" }), false, null, true);
		expect(between).toEqual({ label: "Starting…", tone: "busy", thread: false, startable: false });
	});

	it("says the home computer is offline, and asks for a login when there is none", () => {
		expect(entryState(null, true, null, true).label).toBe("Home computer is offline");
		const login = status({
			run: "stopped",
			login: { state: "missing", providers: [], command: PERSONAL_LOGIN_COMMAND, checkedAt: NOW },
		});
		expect(entryState(login, false, null, true)).toEqual({
			label: "Needs a login",
			tone: "warn",
			thread: false,
			startable: false,
		});
	});

	it("counts what waits for the owner", () => {
		expect(openCount(null)).toBe(0);
		expect(openCount(status({ counts: { questions: 1, proposals: 2, digests: 3 } }))).toBe(6);
	});
});

describe("PersonalSlot", () => {
	const homeHost = host({ instanceId: "inst-p", sessionId: "s-p", personal: true });
	const control = (over: Partial<PersonalControl>): PersonalControl => ({ ...NO_PERSONAL, ...over });
	const render = (value: PersonalControl, forComputer: ComputerHandle, grouped = false): string =>
		renderToStaticMarkup(
			<PersonalContext.Provider value={value}>
				<PersonalSlot
					computer={forComputer}
					grouped={grouped}
					currentSessionId={null}
					onOpenHost={async () => {}}
				/>
			</PersonalContext.Provider>,
		);

	it("renders nothing without a Personal agent: no request, no row", () => {
		expect(render(NO_PERSONAL, computer("home"))).toBe("");
	});

	it("renders nothing for a computer that merely can host, or a turned-off Personal", () => {
		const home = computer("home", { hosts: [homeHost] });
		const off = control({
			home: { computer: home, status: status({ enabled: false, run: "off" }), offline: false, duplicates: [] },
		});
		expect(render(off, home)).toBe("");
	});

	it("pins the entry on the home computer with its state and badge, and no session actions", () => {
		const home = computer("home", { hosts: [homeHost] });
		const html = render(
			control({
				home: {
					computer: home,
					status: status({ counts: { questions: 1, proposals: 1, digests: 0 } }),
					offline: false,
					duplicates: [],
				},
			}),
			home,
		);
		expect(html).toContain("Personal");
		expect(html).toContain("Ready");
		expect(html).toContain(">2<");
		expect(html).toContain('aria-label="Open Personal settings"');
		for (const action of ["Settle", "Snooze", "Pin", "End", "Archive"]) expect(html).not.toContain(action);
	});

	it("offers Start when no session is up, and a hint on the other computers of a group", () => {
		const home = computer("home", { hosts: [] });
		const stopped = control({
			home: { computer: home, status: status({ run: "stopped" }), offline: false, duplicates: [] },
		});
		expect(render(stopped, home)).toContain("Start");
		const other = computer("other");
		expect(render(stopped, other, true)).toBe("");
		const live = computer("home", { hosts: [homeHost] });
		const running = control({ home: { computer: live, status: status(), offline: false, duplicates: [] } });
		const hint = render(running, other, true);
		expect(hint).toContain("Personal lives on home.");
		expect(hint).toContain("Open Personal");
		expect(render(running, other, false)).toBe("");
	});

	it("says the home computer is offline without an error", () => {
		const home = computer("home", { phase: "offline" });
		const html = render(control({ home: { computer: home, status: null, offline: true, duplicates: [] } }), home);
		expect(html).toContain("Home computer is offline");
		expect(html).not.toContain("sh-connect-error");
	});
});

describe("routes", () => {
	it("parses the Personal routes by name", () => {
		for (const [name, route] of Object.entries(PERSONAL_ROUTES))
			expect(parsePersonalRoute(route)).toBe(name as never);
		expect(parsePersonalRoute("personal/other")).toBeNull();
		expect(parsePersonalRoute("open:abc")).toBeNull();
	});

	it("lets a hash route without a colon through the notification parser, with its computer", () => {
		expect(parseRoute("personal")).toEqual({ kind: "route", route: "personal", computerId: null });
		expect(parseRoute("personal/inbox&computer=roomA")).toEqual({
			kind: "route",
			route: "personal/inbox",
			computerId: "roomA",
		});
		expect(parseRoute("personal/memory")).toEqual({ kind: "route", route: "personal/memory", computerId: null });
		expect(parseRoute("personalities")).toBeNull();
		expect(parseRoute("personal/")).toBeNull();
	});
});

describe("merged inbox", () => {
	const q = (id: string, at: number, state: PersonalInboxItem["state"] = "open"): PersonalInboxItem => ({
		id,
		kind: "question",
		title: id,
		body: "",
		at,
		origin: "agent",
		state,
	});

	it("puts open Personal items first, then everything newest first", () => {
		const merged = mergeInbox(
			[
				{ computerId: "a", item: { at: 500 } },
				{ computerId: "a", item: { at: 100 } },
			],
			[q("old-open", 50), q("new-done", 900, "done"), q("mid-open", 300)],
		);
		expect(merged.map(entry => (entry.source === "personal" ? entry.item.id : entry.at))).toEqual([
			"mid-open",
			"old-open",
			"new-done",
			500,
			100,
		]);
	});

	it("is the session items alone when Personal has none", () => {
		const merged = mergeInbox([{ computerId: "a", item: { at: 1 } }], []);
		expect(merged).toEqual([{ source: "session", at: 1, item: { at: 1 }, computerId: "a" }]);
	});
});

describe("proposal diff rows", () => {
	it("marks changes with a sign, and keeps only the context near them", () => {
		const lines = [
			{ op: "keep", text: "## Who I am" },
			{ op: "keep", text: "- a" },
			{ op: "keep", text: "- b" },
			{ op: "keep", text: "- c" },
			{ op: "add", text: "- Prefer squash merges" },
			{ op: "keep", text: "- d" },
			{ op: "del", text: "- old" },
			{ op: "keep", text: "- e" },
			{ op: "keep", text: "- f" },
			{ op: "keep", text: "- g" },
			{ op: "keep", text: "- far" },
		] as const;
		const rows = diffRows(lines, 1);
		expect(rows.map(row => row.marker + row.text)).toEqual([
			" - c",
			"+- Prefer squash merges",
			" - d",
			"\u2212- old",
			" - e",
		]);
		expect(rows[1]!.word).toBe("Added");
		expect(rows[3]!.word).toBe("Removed");
	});

	it("shows everything when nothing changed", () => {
		expect(diffRows([{ op: "keep", text: "x" }], 1)).toHaveLength(1);
	});
});

describe("spend and origin labels", () => {
	it("fills the bar by share, caps at full, and says so without a limit", () => {
		expect(spendBar({ usd: 4.3, limitUsd: 5, level: "warning", since: 0 })).toEqual({
			share: 0.86,
			level: "warning",
			text: "$4.30 of $5.00",
		});
		expect(spendBar({ usd: 9, limitUsd: 5, level: "capped", since: 0 }).share).toBe(1);
		expect(spendBar({ usd: 2, limitUsd: null, level: "off", since: 0 })).toEqual({
			share: 0,
			level: "off",
			text: "$2.00 so far",
		});
		expect(PERSONAL_DEFAULTS.spendWarnShare).toBe(0.8);
	});

	it("names the origin and the source of external memories", () => {
		expect(originLabel({ origin: "owner", authorId: "owner" })).toMatchObject({ label: "You", source: null });
		expect(originLabel({ origin: "external", authorId: "external:github" })).toMatchObject({
			label: "External",
			source: "github",
		});
		expect(originLabel({ origin: "agent", authorId: "agent:personal" }).source).toBeNull();
	});
});

describe("export assembly", () => {
	const parts = ['[{"a":', '1},{"b"', ":2}]"];
	const chunk = (offset: number | undefined) => {
		const at = offset ?? 0;
		return Promise.resolve({
			name: "personal-memory-2027-01-31.json",
			mime: "application/json",
			text: parts[at]!,
			next: at + 1 < parts.length ? at + 1 : null,
		});
	};

	it("joins the chunks in order into one valid file", async () => {
		const out = await assembleExport(chunk);
		expect(out.name).toBe("personal-memory-2027-01-31.json");
		expect(JSON.parse(out.text)).toEqual([{ a: 1 }, { b: 2 }]);
	});

	it("refuses a computer that sends parts out of order", async () => {
		const stuck = () => Promise.resolve({ name: "x", mime: "text/plain", text: "a", next: 0 });
		await expect(assembleExport(stuck)).rejects.toThrow("out of order");
	});
});
