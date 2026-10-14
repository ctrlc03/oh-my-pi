/**
 * omp collab for the desktop: runs this computer's companion (or uses the one that is already running), shows the
 * collab web app the companion serves in a window, and adds what a browser tab cannot: a menu-bar icon that says
 * whether a session needs you, native notifications, a global shortcut, a save dialog, open at login and a
 * self-updater. The app itself is the unchanged web app; this process only loads it from loopback.
 *
 * Environment (for tests and development): `OMP_DESKTOP_DATA_DIR` moves the app's own data; `HOME` and
 * `PI_CONFIG_DIR` move the companion's (the companion computes its directory from them); `OMP_DESKTOP_TEST=1`
 * exposes `globalThis.__ompDesktop` for the end-to-end smoke test; `OMP_BIN` names the `omp` to run.
 */
import * as electron from "electron";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CHANNELS,
	MAX_SAVE_BYTES,
	type OpenSessionTarget,
	type SaveOutcome,
	type SessionReport,
} from "../shared/bridge";
import { appUrl, configDirOf, endpointFile, findRunningEndpoint, stateFile } from "./companion-endpoint";
import {
	checkoutCommand,
	type CompanionCommand,
	installerStateFile,
	type Resolution,
	resolveCompanion,
	searchDirs,
} from "./companion-resolve";
import { CompanionSupervisor, type CompanionStatus } from "./companion-supervisor";
import {
	discoveryDeps,
	hasCompanion,
	isRunnable,
	printLocalLink,
	run,
	serviceInstalled,
	spawnCompanion,
	uninstallService,
} from "./launch";
import { buildAppMenu, buildTrayMenu, type MenuActions, type MenuModel } from "./menu";
import { needsPairing, READ_COMPUTERS_SCRIPT, roomIdFromState } from "./pairing";
import { bundlePathFromExe, parseBuildInfo } from "./release";
import { externalUrl, isAppUrl, permissionAllowed, trustedSender } from "./security";
import { diffReports, notificationsFor, parseReport, trayView, type TrayView } from "./session-state";
import { type Settings, SettingsStore, readText } from "./settings";
import { acceleratorLabel, installCommand, pageForStatus, statusPageHtml } from "./status-text";
import { downloadVerified, fetchOffer, shellQuote, stageUpdate, swapScript } from "./updater";
import type { TestHook } from "./test-hook";
import type { UpdateStatus } from "./update-status";
import { loadWindowState, MIN_SIZE, restoreBounds, saveWindowState } from "./window-state";

const {
	app,
	BrowserWindow,
	Menu,
	Notification,
	Tray,
	dialog,
	globalShortcut,
	ipcMain,
	nativeImage,
	screen,
	session,
	shell,
} = electron;

const APP_NAME = "omp collab";
const BUNDLE_ID = "sh.omp.collab.desktop";
const UPDATE_CHECK_DELAY_MS = 30_000;
const UPDATE_CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const SWAP_WAIT_SECONDS = 30;

const home = os.homedir();
const platform = process.platform;
const testMode = process.env.OMP_DESKTOP_TEST === "1";
const dataDir =
	process.env.OMP_DESKTOP_DATA_DIR || path.join(app.getPath("appData"), app.isPackaged ? APP_NAME : `${APP_NAME} dev`);
app.setName(APP_NAME);
app.setPath("userData", dataDir);

const configDir = configDirOf(home, process.env);
const appDir = app.getAppPath();
const logsDir = path.join(dataDir, "logs");
const desktopLog = path.join(logsDir, "desktop.log");
const companionLog = path.join(logsDir, "companion.log");
const updatesDir = path.join(dataDir, "updates");
const build = parseBuildInfo(readText(path.join(appDir, "dist", "build-info.json")));

function log(line: string): void {
	const text = `${new Date().toISOString()} ${line}\n`;
	try {
		fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });
		fs.appendFileSync(desktopLog, text, { mode: 0o600 });
	} catch {
		// logging must never take the app down
	}
	if (!app.isPackaged) process.stderr.write(text);
}

process.on("uncaughtException", err => log(`uncaught exception: ${err.stack ?? err.message}`));
process.on("unhandledRejection", reason =>
	log(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`),
);

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	void main();
}

async function main(): Promise<void> {
	await app.whenReady();
	const settings = new SettingsStore(path.join(dataDir, "settings.json"));
	const windowFile = path.join(dataDir, "window-state.json");
	const hiddenStart = process.argv.includes("--hidden") || app.getLoginItemSettings().wasOpenedAtLogin;

	let win: electron.BrowserWindow | null = null;
	let tray: electron.Tray | null = null;
	let appOrigin: string | null = null;
	let loadedOrigin: string | null = null;
	let report: SessionReport | null = null;
	let view: TrayView = trayView(null);
	let shuttingDown = false;
	let shortcutRegistered = false;
	let updateStatus: UpdateStatus = { kind: "idle" };
	let staged: { bundle: string; stagingDir: string; tag: string } | null = null;
	let unavailableShown: string | null = null;
	const pairingChecked = new Set<string>();
	const activeNotifications = new Set<electron.Notification>();
	const shown: { title: string; body: string }[] = [];

	const baseEnv = (): Record<string, string | undefined> => ({ ...process.env });

	// ── the companion ────────────────────────────────────────────────────────

	const resolveNow = (): Promise<Resolution> =>
		resolveCompanion(
			{ env: baseEnv(), home, settingsPath: settings.value.ompPath, platform },
			{
				runnable: isRunnable,
				hasCompanion: file =>
					hasCompanion(file, {
						...(baseEnv() as Record<string, string>),
						PATH: searchDirs(home, process.env.PATH, platform).join(path.delimiter),
					}),
				readInstallerState: async () => readText(installerStateFile(home, process.env)),
				checkout: async () => {
					if (app.isPackaged) return null;
					const bun = searchDirs(home, process.env.PATH, platform)
						.map(dir => path.join(dir, "bun"))
						.find(candidate => fs.existsSync(candidate));
					const repoDir = path.resolve(appDir, "..", "..");
					return bun !== undefined &&
						fs.existsSync(path.join(repoDir, "packages", "collab-web", "scripts", "companion.ts"))
						? checkoutCommand(repoDir, bun)
						: null;
				},
			},
		);

	const supervisor = new CompanionSupervisor({
		resolve: resolveNow,
		discover: () => findRunningEndpoint(endpointFile(configDir), discoveryDeps()),
		spawn: (command: CompanionCommand) =>
			spawnCompanion(command, { home, baseEnv: baseEnv(), logFile: companionLog, platform }),
		sleep: ms => new Promise<void>(resolve => setTimeout(resolve, ms)),
		now: Date.now,
		log,
	});

	/** The command to run the companion's own tools with (`--print-local-link`, `--uninstall`), whoever is serving. */
	async function currentCommand(): Promise<CompanionCommand | null> {
		const status = supervisor.status;
		if (status.kind === "running") return status.command;
		const resolved = await resolveNow();
		return resolved.ok ? resolved.command : null;
	}

	// ── window ───────────────────────────────────────────────────────────────

	function showWindow(): void {
		if (win === null || win.isDestroyed()) win = createWindow(false);
		if (win.isMinimized()) win.restore();
		win.show();
		win.focus();
		if (platform === "darwin") app.focus({ steal: true });
		rebuildMenus();
	}

	function toggleWindow(): void {
		if (win !== null && !win.isDestroyed() && win.isVisible() && win.isFocused()) {
			win.hide();
			rebuildMenus();
		} else {
			showWindow();
		}
	}

	function createWindow(hidden: boolean): electron.BrowserWindow {
		const workAreas = [
			screen.getPrimaryDisplay(),
			...screen.getAllDisplays().filter(d => d.id !== screen.getPrimaryDisplay().id),
		].map(d => d.workArea);
		const saved = loadWindowState(windowFile);
		const created = new BrowserWindow({
			...restoreBounds(saved, workAreas),
			minWidth: MIN_SIZE.width,
			minHeight: MIN_SIZE.height,
			show: false,
			title: APP_NAME,
			backgroundColor: "#000000",
			webPreferences: {
				preload: path.join(appDir, "dist", "preload.cjs"),
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
				webSecurity: true,
				allowRunningInsecureContent: false,
			},
		});
		if (saved?.maximized) created.maximize();
		created.once("ready-to-show", () => {
			if (!hidden) created.show();
			rebuildMenus();
		});
		let saveTimer: ReturnType<typeof setTimeout> | undefined;
		const persist = (): void => {
			clearTimeout(saveTimer);
			saveTimer = setTimeout(() => {
				if (created.isDestroyed() || created.isMinimized() || created.isFullScreen()) return;
				const maximized = created.isMaximized();
				saveWindowState(windowFile, {
					...(maximized ? (saved ?? created.getBounds()) : created.getBounds()),
					maximized,
				});
			}, 400);
		};
		created.on("resize", persist);
		created.on("move", persist);
		created.on("maximize", persist);
		created.on("unmaximize", persist);
		created.on("show", rebuildMenus);
		created.on("hide", rebuildMenus);
		created.on("focus", rebuildMenus);
		created.on("close", event => {
			if (shuttingDown) return;
			// Closing the window keeps the app (and its menu-bar icon) running; Quit is how it ends.
			event.preventDefault();
			created.hide();
		});
		created.webContents.on("did-finish-load", () => {
			const origin = appOrigin;
			if (origin === null || pairingChecked.has(origin) || !isAppUrl(created.webContents.getURL(), origin)) return;
			pairingChecked.add(origin);
			void ensurePaired(false).catch(err =>
				log(`pairing failed: ${err instanceof Error ? err.message : String(err)}`),
			);
		});
		created.on("closed", () => {
			if (win === created) win = null;
		});
		if (loadedOrigin === null) showStatusPage(supervisor.status);
		else void created.loadURL(appUrl(Number(new URL(loadedOrigin).port)));
		return created;
	}

	function showStatusPage(status: CompanionStatus): void {
		if (win === null || win.isDestroyed()) return;
		const { title, body } = pageForStatus(status);
		void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(statusPageHtml(title, body))}`);
	}

	function loadApp(origin: string): void {
		appOrigin = origin;
		if (loadedOrigin === origin) return;
		loadedOrigin = origin;
		if (win !== null && !win.isDestroyed()) void win.loadURL(`${origin}/`);
	}

	async function ensurePaired(force: boolean): Promise<void> {
		const origin = appOrigin;
		const target = win;
		if (origin === null || target === null || target.isDestroyed()) return;
		if (!force) {
			const stored = (await target.webContents.executeJavaScript(READ_COMPUTERS_SCRIPT)) as string | null;
			if (!needsPairing(stored, roomIdFromState(readText(stateFile(configDir))))) return;
		}
		const command = await currentCommand();
		const status = supervisor.status;
		if (command === null || (status.kind !== "running" && status.kind !== "attached"))
			throw new Error("no companion to pair with");
		const link = await printLocalLink(command, { home, baseEnv: baseEnv(), platform, endpoint: status.endpoint });
		if (appOrigin !== origin || target.isDestroyed()) return;
		log("pairing this window with the companion");
		// A link that differs from the loaded page only by its fragment would be a same-document jump the app never reads.
		if (target.webContents.getURL().split("#")[0] === link.split("#")[0]) await target.loadURL("about:blank");
		await target.loadURL(link);
	}

	// ── security ─────────────────────────────────────────────────────────────

	session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
		callback(
			permissionAllowed(
				permission,
				details.requestingUrl || contents.getURL(),
				appOrigin ?? "",
				"mediaTypes" in details ? details.mediaTypes : undefined,
			),
		);
	});
	session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
		const mediaType = "mediaType" in details ? details.mediaType : undefined;
		return permissionAllowed(
			permission,
			details.requestingUrl || requestingOrigin || contents?.getURL() || "",
			appOrigin ?? "",
			mediaType === undefined ? undefined : [mediaType],
		);
	});
	app.on("web-contents-created", (_event, contents) => {
		const openOutside = (url: string): void => {
			const target = externalUrl(url);
			if (target !== null) void shell.openExternal(target);
		};
		contents.setWindowOpenHandler(({ url }) => {
			openOutside(url);
			return { action: "deny" };
		});
		const guard = (event: electron.Event, url: string): void => {
			if (appOrigin !== null && isAppUrl(url, appOrigin)) return;
			event.preventDefault();
			openOutside(url);
		};
		contents.on("will-navigate", details => guard(details, details.url));
		contents.on("will-redirect", details => guard(details, details.url));
		contents.on("will-attach-webview", event => event.preventDefault());
	});

	// ── the bridge the page uses ─────────────────────────────────────────────

	function trusted(event: electron.IpcMainEvent | electron.IpcMainInvokeEvent): boolean {
		const frame = event.senderFrame;
		return (
			appOrigin !== null &&
			win !== null &&
			!win.isDestroyed() &&
			event.sender === win.webContents &&
			frame !== null &&
			trustedSender(frame.url, frame === event.sender.mainFrame, appOrigin)
		);
	}

	/** A file name that cannot name a folder or hide itself: the last path segment, control characters dropped. */
	function safeFileName(name: string): string {
		const base = path
			.basename(name.replace(/\\/g, "/"))
			.replace(/[\u0000-\u001f\u007f]/g, "")
			.trim();
		return base === "" || base === "." || base === ".." ? "download" : base.slice(0, 200);
	}

	ipcMain.handle(CHANNELS.saveFile, async (event, name: unknown, data: unknown): Promise<SaveOutcome> => {
		if (!trusted(event)) throw new Error("not allowed");
		if (typeof name !== "string" || !ArrayBuffer.isView(data)) throw new Error("bad save request");
		if (data.byteLength > MAX_SAVE_BYTES) throw new Error("that file is too large to save from the app");
		const owner = win !== null && !win.isDestroyed() ? win : undefined;
		const options = { defaultPath: path.join(app.getPath("downloads"), safeFileName(name)) };
		const picked =
			owner === undefined
				? await electron.dialog.showSaveDialog(options)
				: await electron.dialog.showSaveDialog(owner, options);
		if (picked.canceled || picked.filePath === "") return "cancelled";
		await fs.promises.writeFile(picked.filePath, Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
			mode: 0o644,
		});
		log(`saved ${data.byteLength} bytes to ${picked.filePath}`);
		return "saved";
	});

	ipcMain.on(CHANNELS.reportSessions, (event, raw: unknown) => {
		if (!trusted(event)) return;
		const next = parseReport(raw);
		if (next !== null) handleReport(next);
	});

	function openSession(target: OpenSessionTarget): void {
		showWindow();
		win?.webContents.send(CHANNELS.openSession, target);
	}

	function notify(title: string, body: string, open?: OpenSessionTarget): void {
		shown.push({ title, body });
		if (!Notification.isSupported()) return;
		const notification = new Notification({ title, body });
		activeNotifications.add(notification);
		notification.on("click", () => (open === undefined ? showWindow() : openSession(open)));
		notification.on("close", () => activeNotifications.delete(notification));
		notification.show();
	}

	function handleReport(next: SessionReport): void {
		const events = diffReports(report, next);
		report = next;
		view = trayView(next);
		const watching = win !== null && !win.isDestroyed() && win.isVisible() && win.isFocused();
		if (!watching) {
			const { notifyInput, notifyFinished } = settings.value;
			for (const text of notificationsFor(
				events,
				{ input: notifyInput, finished: notifyFinished },
				next.computersTotal,
			))
				notify(text.title, text.body, text.open);
		}
		applyTray();
		rebuildMenus();
	}

	// ── tray, menus, shortcut ────────────────────────────────────────────────

	function trayImage(state: TrayView["state"]): electron.NativeImage {
		const name = {
			idle: "trayIdleTemplate",
			working: "trayWorkingTemplate",
			offline: "trayOfflineTemplate",
			input: "trayInput",
		}[state];
		return nativeImage.createFromPath(path.join(appDir, "assets", "tray", `${name}.png`));
	}

	function applyTray(): void {
		if (tray === null) return;
		tray.setImage(trayImage(view.state));
		tray.setToolTip(view.tooltip);
		if (platform === "darwin") {
			tray.setTitle(view.waiting.length > 0 ? ` ${view.waiting.length}` : "");
			app.dock?.setBadge(view.waiting.length > 0 ? String(view.waiting.length) : "");
		}
	}

	const actions: MenuActions = {
		toggleWindow,
		openSession: (computerId, instanceId) => openSession({ computerId, instanceId }),
		checkForUpdates: () => void checkForUpdates(true),
		restartToUpdate: () => void shutdown(true),
		restartCompanion: () => void restartCompanion(),
		openCompanionLog: () => void shell.openPath(companionLog),
		pairAgain: () =>
			void ensurePaired(true).catch(err =>
				dialog.showErrorBox("Could not pair this computer", err instanceof Error ? err.message : String(err)),
			),
		migrateService: () => void migrateService(),
		setSetting: patch => {
			settings.update(patch);
			if ("globalShortcut" in patch) registerShortcut();
			if ("checkUpdates" in patch && patch.checkUpdates === true) void checkForUpdates(false);
			rebuildMenus();
		},
		setOpenAtLogin: value => {
			app.setLoginItemSettings({ openAtLogin: value, args: value ? ["--hidden"] : [] });
			rebuildMenus();
		},
		quit: () => void shutdown(false),
	};

	function menuModel(): MenuModel {
		const current: Settings = settings.value;
		return {
			platform,
			appName: APP_NAME,
			devTools: !app.isPackaged || testMode,
			settings: current,
			openAtLogin: app.getLoginItemSettings().openAtLogin,
			companion: supervisor.status,
			serviceInstalled: serviceInstalled(home, platform),
			update: updateStatus,
			windowVisible: win !== null && !win.isDestroyed() && win.isVisible(),
			waiting: view.waiting,
			shortcutLabel: acceleratorLabel(current.shortcut, platform),
		};
	}

	function rebuildMenus(): void {
		const model = menuModel();
		Menu.setApplicationMenu(Menu.buildFromTemplate(buildAppMenu(model, actions)));
		tray?.setContextMenu(Menu.buildFromTemplate(buildTrayMenu(model, actions)));
	}

	function registerShortcut(): void {
		globalShortcut.unregisterAll();
		shortcutRegistered = false;
		if (!settings.value.globalShortcut) return;
		try {
			shortcutRegistered = globalShortcut.register(settings.value.shortcut, toggleWindow);
		} catch (err) {
			log(
				`the shortcut ${settings.value.shortcut} is not valid: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		if (!shortcutRegistered)
			log(`could not register the shortcut ${settings.value.shortcut}; another app may hold it`);
	}

	// ── the companion's lifecycle ────────────────────────────────────────────

	supervisor.onStatus(status => {
		if (status.kind === "attached" || status.kind === "running") {
			unavailableShown = null;
			loadApp(`http://127.0.0.1:${status.endpoint.port}`);
		} else if (loadedOrigin === null) {
			showStatusPage(status);
		}
		if (status.kind === "unavailable" && unavailableShown !== status.reason) {
			unavailableShown = status.reason;
			void explainUnavailable(status);
		}
		rebuildMenus();
	});

	async function explainUnavailable(status: Extract<CompanionStatus, { kind: "unavailable" }>): Promise<void> {
		if (status.reason === "blocked") {
			const answer = await dialog.showMessageBox({
				type: "warning",
				message: "Another companion is in the way",
				detail: status.message,
				buttons: ["Check Again", "Quit"],
				defaultId: 0,
				cancelId: 1,
			});
			if (answer.response === 0) void supervisor.start();
			else void shutdown(false);
			return;
		}
		const command = installCommand(build.repo);
		const detail = `The companion is part of omp, and this app uses the omp on your computer. Install it with this command in a terminal:\n\n${command}\n\nThen choose Check Again.${status.tried.length > 0 ? `\n\nLooked in: ${status.tried.join(", ")}` : ""}`;
		const answer = await dialog.showMessageBox({
			type: "info",
			message: "omp is not installed",
			detail,
			buttons: ["Copy Command", "Check Again", "Quit"],
			defaultId: 1,
			cancelId: 2,
		});
		if (answer.response === 0) {
			electron.clipboard.writeText(command);
			unavailableShown = null;
			await explainUnavailable(status);
		} else if (answer.response === 1) {
			unavailableShown = null;
			void supervisor.start();
		} else {
			void shutdown(false);
		}
	}

	async function restartCompanion(): Promise<void> {
		if (supervisor.status.kind === "attached") {
			await dialog.showMessageBox({
				type: "info",
				message: "This app did not start the companion",
				detail:
					"It runs as a service or in a terminal; restart it there. To let this app run it instead, choose Run the Companion Inside This App.",
				buttons: ["OK"],
			});
			return;
		}
		await supervisor.restart();
	}

	async function migrateService(): Promise<void> {
		const confirm = await dialog.showMessageBox({
			type: "question",
			message: "Run the companion inside this app?",
			detail:
				"This removes the background service that runs the companion today (launchd on macOS, systemd on Linux). Afterwards this app starts the companion and keeps it running while the app is open; turn on Open at Login for it to start with your computer, and Keep the Companion Running After Quit to leave it running when you quit. Paired devices stay paired and running sessions are not touched.",
			buttons: ["Run It Inside This App", "Cancel"],
			defaultId: 1,
			cancelId: 1,
		});
		if (confirm.response !== 0) return;
		try {
			const command = await currentCommand();
			if (command === null) throw new Error("omp was not found, so the service cannot be removed from here");
			const message = await uninstallService(command, { home, baseEnv: baseEnv(), platform });
			const deadline = Date.now() + 15_000;
			while (
				Date.now() < deadline &&
				(await findRunningEndpoint(endpointFile(configDir), discoveryDeps())) !== null
			) {
				await new Promise<void>(resolve => setTimeout(resolve, 500));
			}
			await supervisor.restart();
			await dialog.showMessageBox({
				type: "info",
				message: "The companion now runs inside this app",
				detail: message || "The service was removed.",
				buttons: ["OK"],
			});
		} catch (err) {
			dialog.showErrorBox("Could not remove the service", err instanceof Error ? err.message : String(err));
		}
		rebuildMenus();
	}

	// ── updates ──────────────────────────────────────────────────────────────

	function setUpdate(next: UpdateStatus): void {
		updateStatus = next;
		rebuildMenus();
	}

	/** Why this build cannot update itself, or null. */
	function updateBlocker(): { reason: string; bundle: string } | { reason: null; bundle: string } {
		const bundle = bundlePathFromExe(app.getPath("exe"));
		if (!app.isPackaged || build.tag === null) return { reason: "this is a development build", bundle: bundle ?? "" };
		if (platform !== "darwin" || bundle === null)
			return { reason: "updates are installed with the installer on this platform", bundle: bundle ?? "" };
		try {
			fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
		} catch {
			return { reason: `${path.dirname(bundle)} is not writable, so the app cannot replace itself`, bundle };
		}
		return { reason: null, bundle };
	}

	async function checkForUpdates(manual: boolean): Promise<void> {
		if (updateStatus.kind === "checking" || updateStatus.kind === "downloading" || updateStatus.kind === "ready")
			return;
		const blocker = updateBlocker();
		if (blocker.reason !== null) {
			setUpdate({ kind: "unsupported", reason: blocker.reason });
			if (manual)
				await dialog.showMessageBox({
					type: "info",
					message: "Updates are not available here",
					detail: `${blocker.reason}.`,
					buttons: ["OK"],
				});
			return;
		}
		setUpdate({ kind: "checking" });
		try {
			const offer = await fetchOffer({ repo: build.repo, current: build.tag, platform, arch: process.arch, fetch });
			if (offer === undefined) {
				setUpdate({ kind: "current" });
				if (manual)
					await dialog.showMessageBox({
						type: "info",
						message: `${APP_NAME} is up to date`,
						detail: build.tag ?? "",
						buttons: ["OK"],
					});
				return;
			}
			log(`update ${offer.tag} found; downloading`);
			setUpdate({ kind: "downloading", tag: offer.tag, percent: 0 });
			const zip = path.join(updatesDir, offer.tag, offer.name);
			let lastPercent = -1;
			await downloadVerified(offer, zip, {
				fetch,
				onProgress: (received, total) => {
					const percent = Math.floor((received / total) * 100);
					if (percent !== lastPercent && percent % 5 === 0) {
						lastPercent = percent;
						setUpdate({ kind: "downloading", tag: offer.tag, percent });
					}
				},
			});
			const stagingDir = path.join(path.dirname(blocker.bundle), `.${APP_NAME.replace(/ /g, "-")}-update`);
			const bundle = await stageUpdate(zip, stagingDir, { bundleId: BUNDLE_ID, tag: offer.tag }, run);
			fs.rmSync(path.dirname(zip), { recursive: true, force: true });
			staged = { bundle, stagingDir, tag: offer.tag };
			log(`update ${offer.tag} verified and staged`);
			setUpdate({ kind: "ready", tag: offer.tag });
			notify(
				`${APP_NAME} ${offer.tag} is ready`,
				"It installs when you quit. Choose Restart to Update in the menu to do it now.",
			);
			if (manual) {
				const answer = await dialog.showMessageBox({
					type: "info",
					message: `${offer.tag} is ready to install`,
					detail: "The update is downloaded and checked.",
					buttons: ["Restart Now", "Later"],
					defaultId: 0,
					cancelId: 1,
				});
				if (answer.response === 0) void shutdown(true);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log(`update failed: ${message}`);
			setUpdate({ kind: "failed", message });
			if (manual) dialog.showErrorBox("Could not update", message);
		}
	}

	/** Swap the staged update in after this process exits (the script waits for it). */
	function launchSwap(relaunch: boolean): void {
		if (staged === null) return;
		const blocker = updateBlocker();
		if (blocker.reason !== null) return;
		fs.mkdirSync(updatesDir, { recursive: true, mode: 0o700 });
		const script = path.join(updatesDir, "swap.sh");
		fs.writeFileSync(
			script,
			swapScript({
				pid: process.pid,
				bundle: blocker.bundle,
				staged: staged.bundle,
				stagingDir: staged.stagingDir,
				relaunch,
				waitSeconds: SWAP_WAIT_SECONDS,
			}),
			{ mode: 0o700 },
		);
		// A detached helper outlives this process and does the rename once the app is gone.
		spawn("/bin/sh", [script], { detached: true, stdio: "ignore" }).unref();
		log(`update ${staged.tag} will be installed by ${shellQuote(script)} once the app has quit`);
	}

	// ── quitting ─────────────────────────────────────────────────────────────

	async function shutdown(relaunchForUpdate: boolean): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;
		globalShortcut.unregisterAll();
		try {
			await supervisor.stop({ keepRunning: settings.value.keepCompanionRunning });
		} catch (err) {
			log(`stopping the companion failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		try {
			launchSwap(relaunchForUpdate);
		} catch (err) {
			log(`could not prepare the update: ${err instanceof Error ? err.message : String(err)}`);
		}
		app.exit(0);
	}

	app.on("before-quit", event => {
		if (shuttingDown) {
			event.preventDefault();
			return;
		}
		event.preventDefault();
		void shutdown(false);
	});
	process.on("SIGTERM", () => void shutdown(false));
	process.on("SIGINT", () => void shutdown(false));
	app.on("window-all-closed", () => {
		// The menu-bar icon keeps the app alive; without one the app ends with its last window.
		if (tray === null) void shutdown(false);
	});
	app.on("activate", showWindow);
	app.on("second-instance", showWindow);

	// ── go ───────────────────────────────────────────────────────────────────

	if (platform === "darwin" && !app.isPackaged) {
		const icon = nativeImage.createFromPath(path.join(appDir, "build", "icon.png"));
		if (!icon.isEmpty()) app.dock?.setIcon(icon);
	}
	try {
		tray = new Tray(trayImage("idle"));
		applyTray();
	} catch (err) {
		log(`no menu-bar icon: ${err instanceof Error ? err.message : String(err)}`);
	}
	registerShortcut();
	win = createWindow(hiddenStart);
	rebuildMenus();
	void supervisor.start();

	if (settings.value.checkUpdates) {
		setTimeout(() => void checkForUpdates(false), UPDATE_CHECK_DELAY_MS);
		setInterval(() => {
			if (settings.value.checkUpdates) void checkForUpdates(false);
		}, UPDATE_CHECK_EVERY_MS);
	}

	if (testMode) {
		const hook: TestHook = {
			diagnostics: () => ({
				companion: supervisor.status,
				appOrigin,
				tray: { state: view.state, tooltip: view.tooltip, waiting: view.waiting.length },
				notifications: shown,
				shortcut: {
					accelerator: settings.value.shortcut,
					registered: shortcutRegistered && globalShortcut.isRegistered(settings.value.shortcut),
				},
				window:
					win === null || win.isDestroyed()
						? null
						: { visible: win.isVisible(), focused: win.isFocused(), url: win.webContents.getURL() },
				update: updateStatus,
				paths: { dataDir, configDir, companionLog },
			}),
			toggleWindow,
			checkForUpdates: () => checkForUpdates(true),
			trayMenu: () => buildTrayMenu(menuModel(), actions).map(item => item.label ?? item.type ?? ""),
		};
		globalThis.__ompDesktop = hook;
	}
}
