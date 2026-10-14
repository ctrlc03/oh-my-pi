import { describe, expect, it } from "bun:test";
import type { MenuItemConstructorOptions } from "electron";
import { buildAppMenu, buildTrayMenu, type MenuActions, type MenuModel } from "../src/main/menu";
import { DEFAULT_SETTINGS } from "../src/main/settings";

const calls: string[] = [];
const actions = new Proxy({} as MenuActions, {
	get:
		(_target, name: string) =>
		(...args: unknown[]) =>
			calls.push([name, ...args.map(String)].join(" ")),
});

const model = (patch: Partial<MenuModel> = {}): MenuModel => ({
	platform: "darwin",
	appName: "omp collab",
	devTools: false,
	settings: DEFAULT_SETTINGS,
	openAtLogin: false,
	companion: { kind: "starting" },
	serviceInstalled: false,
	update: { kind: "idle" },
	windowVisible: true,
	waiting: [],
	shortcutLabel: "⌥⌘O",
	...patch,
});

const labels = (items: MenuItemConstructorOptions[] | MenuItemConstructorOptions["submenu"]): string[] =>
	(Array.isArray(items) ? items : []).map(item => item.label ?? item.role ?? item.type ?? "");

describe("application menu", () => {
	it("has the standard edit and window roles, so copy and paste work", () => {
		const menu = buildAppMenu(model(), actions);
		const edit = menu.find(item => item.label === "Edit");
		expect(labels(edit?.submenu)).toEqual(
			expect.arrayContaining(["undo", "redo", "cut", "copy", "paste", "selectAll"]),
		);
		expect(labels(menu.find(item => item.label === "Window")?.submenu)).toContain("minimize");
	});

	it("puts the preferences in the app menu on macOS and in File elsewhere", () => {
		const mac = buildAppMenu(model(), actions);
		expect(mac[0]?.label).toBe("omp collab");
		expect(labels(mac[0]?.submenu)).toContain("Open at Login");
		const linux = buildAppMenu(model({ platform: "linux" }), actions);
		expect(linux[0]?.label).toBe("File");
		expect(labels(linux[0]?.submenu)).toContain("Open at Login");
	});

	it("shows developer tools only when asked", () => {
		const view = (devTools: boolean) =>
			labels(buildAppMenu(model({ devTools }), actions).find(item => item.label === "View")?.submenu);
		expect(view(false)).not.toContain("toggleDevTools");
		expect(view(true)).toContain("toggleDevTools");
	});

	it("offers moving the service into the app only when a service is installed", () => {
		const companion = (serviceInstalled: boolean) =>
			labels(buildAppMenu(model({ serviceInstalled }), actions).find(item => item.label === "Companion")?.submenu);
		expect(companion(false).some(label => label.includes("Inside This App"))).toBe(false);
		expect(companion(true).some(label => label.includes("Inside This App"))).toBe(true);
	});

	it("wires the preference checkboxes to settings", () => {
		calls.length = 0;
		const app = buildAppMenu(model(), actions)[0]?.submenu as MenuItemConstructorOptions[];
		const keep = app.find(item => item.label === "Keep the Companion Running After Quit")!;
		expect(keep.checked).toBe(false);
		(keep.click as (item: { checked: boolean }) => void)({ checked: true });
		expect(calls).toEqual(["setSetting [object Object]"]);
	});
});

describe("tray menu", () => {
	it("lists the sessions that need input, and opens one", () => {
		calls.length = 0;
		const waiting = [
			{ computerId: "c", instanceId: "1", title: "fix login", computerName: "laptop", activity: "input" as const },
			{ computerId: "c", instanceId: "2", title: "docs", computerName: null, activity: "input" as const },
		];
		const items = buildTrayMenu(model({ waiting }), actions);
		expect(labels(items).slice(0, 3)).toEqual(["2 sessions need your input", "fix login · laptop", "docs"]);
		(items[1]!.click as () => void)();
		expect(calls).toEqual(["openSession c 1"]);
	});

	it("says nothing needs you, and offers show or hide and quit", () => {
		const hidden = labels(buildTrayMenu(model({ windowVisible: false }), actions));
		expect(hidden[0]).toBe("Nothing needs your input");
		expect(hidden).toContain("Show omp collab");
		expect(labels(buildTrayMenu(model(), actions))).toContain("Hide omp collab");
		expect(hidden.at(-1)).toBe("Quit omp collab");
	});

	it("caps a long list", () => {
		const waiting = Array.from({ length: 12 }, (_, i) => ({
			computerId: "c",
			instanceId: String(i),
			title: `s${i}`,
			computerName: null,
			activity: "input" as const,
		}));
		const items = labels(buildTrayMenu(model({ waiting }), actions));
		expect(items.filter(label => /^s\d+$/.test(label)).length).toBe(8);
		expect(items).toContain("and 4 more");
	});
});
