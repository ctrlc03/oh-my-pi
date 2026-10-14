/**
 * The application menu and the menu-bar icon's menu, as templates. They are built from a model of what the app
 * knows and a set of actions, and rebuilt whenever either changes, so they never go stale.
 */
import type { MenuItemConstructorOptions } from "electron";
import { companionLine } from "./status-text";
import type { CompanionStatus } from "./companion-supervisor";
import type { ReportedSession } from "../shared/bridge";
import type { Settings } from "./settings";
import { type UpdateStatus, updateMenuItem } from "./update-status";

export interface MenuModel {
	platform: NodeJS.Platform;
	appName: string;
	/** Developer tools are offered (an unpackaged app, or when asked for). */
	devTools: boolean;
	settings: Settings;
	openAtLogin: boolean;
	companion: CompanionStatus;
	/** A launchd or systemd companion service is installed and the app could take its place. */
	serviceInstalled: boolean;
	update: UpdateStatus;
	windowVisible: boolean;
	waiting: readonly ReportedSession[];
	/** The accelerator text of the global shortcut, for the menu label. */
	shortcutLabel: string;
}

export interface MenuActions {
	toggleWindow(): void;
	openSession(computerId: string, instanceId: string): void;
	checkForUpdates(): void;
	restartToUpdate(): void;
	restartCompanion(): void;
	openCompanionLog(): void;
	pairAgain(): void;
	migrateService(): void;
	setSetting(patch: Partial<Settings>): void;
	setOpenAtLogin(value: boolean): void;
	quit(): void;
}

const MAX_TRAY_SESSIONS = 8;

function updateItems(model: MenuModel, actions: MenuActions): MenuItemConstructorOptions[] {
	const item = updateMenuItem(model.update);
	if (item === null) return [];
	return [
		{
			label: item.label,
			enabled: item.enabled,
			click: () => (item.action === "restart" ? actions.restartToUpdate() : actions.checkForUpdates()),
		},
	];
}

function preferenceItems(model: MenuModel, actions: MenuActions): MenuItemConstructorOptions[] {
	const { settings } = model;
	return [
		{
			label: "Open at Login",
			type: "checkbox",
			checked: model.openAtLogin,
			click: item => actions.setOpenAtLogin(item.checked),
		},
		{
			label: `Show or Hide with ${model.shortcutLabel}`,
			type: "checkbox",
			checked: settings.globalShortcut,
			click: item => actions.setSetting({ globalShortcut: item.checked }),
		},
		{
			label: "Keep the Companion Running After Quit",
			type: "checkbox",
			checked: settings.keepCompanionRunning,
			click: item => actions.setSetting({ keepCompanionRunning: item.checked }),
		},
		{
			label: "Notifications",
			submenu: [
				{
					label: "When a Session Needs Input",
					type: "checkbox",
					checked: settings.notifyInput,
					click: item => actions.setSetting({ notifyInput: item.checked }),
				},
				{
					label: "When a Session Finishes a Turn",
					type: "checkbox",
					checked: settings.notifyFinished,
					click: item => actions.setSetting({ notifyFinished: item.checked }),
				},
			],
		},
		{
			label: "Check for Updates Automatically",
			type: "checkbox",
			checked: settings.checkUpdates,
			click: item => actions.setSetting({ checkUpdates: item.checked }),
		},
	];
}

function companionMenu(model: MenuModel, actions: MenuActions): MenuItemConstructorOptions {
	const submenu: MenuItemConstructorOptions[] = [
		{ label: companionLine(model.companion), enabled: false },
		{ type: "separator" },
		{ label: "Restart Companion", click: actions.restartCompanion },
		{ label: "Show Companion Log", click: actions.openCompanionLog },
		{ label: "Pair This Computer Again", click: actions.pairAgain },
	];
	if (model.serviceInstalled) {
		submenu.push(
			{ type: "separator" },
			{ label: "Run the Companion Inside This App…", click: actions.migrateService },
		);
	}
	return { label: "Companion", submenu };
}

/** The application menu. On macOS the first menu is the app's own; elsewhere the preferences live under File. */
export function buildAppMenu(model: MenuModel, actions: MenuActions): MenuItemConstructorOptions[] {
	const mac = model.platform === "darwin";
	const edit: MenuItemConstructorOptions = {
		label: "Edit",
		submenu: [
			{ role: "undo" },
			{ role: "redo" },
			{ type: "separator" },
			{ role: "cut" },
			{ role: "copy" },
			{ role: "paste" },
			{ role: "pasteAndMatchStyle" },
			{ role: "delete" },
			{ role: "selectAll" },
		],
	};
	const view: MenuItemConstructorOptions = {
		label: "View",
		submenu: [
			{ role: "reload" },
			{ role: "forceReload" },
			...(model.devTools ? [{ role: "toggleDevTools" } as MenuItemConstructorOptions] : []),
			{ type: "separator" },
			{ role: "resetZoom" },
			{ role: "zoomIn" },
			{ role: "zoomOut" },
			{ type: "separator" },
			{ role: "togglefullscreen" },
		],
	};
	const windowMenu: MenuItemConstructorOptions = {
		label: "Window",
		submenu: mac
			? [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }]
			: [{ role: "minimize" }, { role: "close" }],
	};
	const appMenu: MenuItemConstructorOptions = {
		label: model.appName,
		submenu: [
			{ role: "about" },
			...updateItems(model, actions),
			{ type: "separator" },
			...preferenceItems(model, actions),
			{ type: "separator" },
			{ role: "services" },
			{ type: "separator" },
			{ role: "hide" },
			{ role: "hideOthers" },
			{ role: "unhide" },
			{ type: "separator" },
			{ role: "quit" },
		],
	};
	const file: MenuItemConstructorOptions = {
		label: "File",
		submenu: [
			...updateItems(model, actions),
			...preferenceItems(model, actions),
			{ type: "separator" },
			{ label: "Quit", click: actions.quit },
		],
	};
	return mac
		? [appMenu, edit, view, companionMenu(model, actions), windowMenu]
		: [file, edit, view, companionMenu(model, actions), windowMenu];
}

/** The menu of the menu-bar (tray) icon. */
export function buildTrayMenu(model: MenuModel, actions: MenuActions): MenuItemConstructorOptions[] {
	const sessions: MenuItemConstructorOptions[] =
		model.waiting.length === 0
			? [{ label: "Nothing needs your input", enabled: false }]
			: [
					{
						label:
							model.waiting.length === 1
								? "1 session needs your input"
								: `${model.waiting.length} sessions need your input`,
						enabled: false,
					},
					...model.waiting.slice(0, MAX_TRAY_SESSIONS).map((session): MenuItemConstructorOptions => ({
						label: session.computerName === null ? session.title : `${session.title} · ${session.computerName}`,
						click: () => actions.openSession(session.computerId, session.instanceId),
					})),
					...(model.waiting.length > MAX_TRAY_SESSIONS
						? [
								{
									label: `and ${model.waiting.length - MAX_TRAY_SESSIONS} more`,
									enabled: false,
								} as MenuItemConstructorOptions,
							]
						: []),
				];
	return [
		...sessions,
		{ type: "separator" },
		{ label: model.windowVisible ? `Hide ${model.appName}` : `Show ${model.appName}`, click: actions.toggleWindow },
		{ type: "separator" },
		{ label: companionLine(model.companion), enabled: false },
		...updateItems(model, actions),
		{ type: "separator" },
		{ label: `Quit ${model.appName}`, click: actions.quit },
	];
}
