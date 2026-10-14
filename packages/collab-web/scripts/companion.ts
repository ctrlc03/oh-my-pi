/**
 * omp collab companion: keeps one encrypted relay room open on this computer
 * so the collab web app can list every omp session on it, read its git state,
 * start new sessions, and join any hosted session without fetching a new link.
 *
 *   bun scripts/companion.ts             # print the pairing link + QR, then serve
 *   bun scripts/companion.ts --rotate    # new room key: unpairs every device
 *   bun scripts/companion.ts --pair      # print a fresh one-time pairing link + QR and exit
 *   bun scripts/companion.ts --open      # open this computer's own copy of the app, paired (see below)
 *   bun scripts/companion.ts --print-local-link   # print that link instead of opening it
 *   bun scripts/companion.ts --no-local-app       # do not serve the app on the loopback relay's port
 *   bun scripts/companion.ts --install   # run at login as a service: LaunchAgent (macOS) or systemd user unit (Linux)
 *   bun scripts/companion.ts --install --dry-run   # print the service file only
 *   bun scripts/companion.ts --uninstall # remove the service
 *
 * Pair each device once by scanning the QR code (or pasting the link) in the web
 * app. The link carries the room key and a one-time invite (single use, valid
 * 10 minutes, kept hashed in `<config>/agent/collab-companion-invites/`); the
 * device presents it in an `auth` frame and is issued its own credentials.
 * The room id and key, and each device's name, token hash, last seen time and
 * push subscription, persist in `<config>/agent/collab-companion.json` (mode
 * 0600), so restarts keep devices paired. The companion serves only devices that
 * authenticated: holding the room key alone gets nothing. A paired device can join
 * every session on this computer with full control, exactly as if it held each
 * session's control link, can read and edit files under each session's
 * repository (but not those of a sandboxed session, nor anything inside `.git`),
 * and can start omp in any folder. The app's Devices screen lists, renames and
 * removes devices and makes new invites; removing a device cuts it off at once.
 *
 * The app on this computer: the loopback relay also serves the web app itself at `http://127.0.0.1:<port>`
 * (`./local-app`), so this computer's browser needs neither GitHub Pages nor the public relay and the app works
 * offline. From a checkout the companion builds it into `<config>/cache/collab-web/<source hash>/` in the
 * background (`./local-app-source`); the release binary carries it. It joins this room, and the sessions the companion
 * starts, over the loopback relay first and the public one when that fails. It has its own storage, so it pairs on its
 * own: `--open` (or `--print-local-link`) asks the running companion for a one-time invite and opens
 * `http://127.0.0.1:<port>/#pair:…` in the default browser. Phones keep the Pages link.
 *
 * `--install` on macOS writes `~/Library/LaunchAgents/sh.omp.collab-companion.plist`
 * (RunAtLoad + KeepAlive, absolute bun/script/omp paths, log in
 * `~/Library/Logs/omp-collab-companion.log`) and loads it. On Linux it writes
 * `~/.config/systemd/user/omp-collab-companion.service` (Restart=always, log in
 * the user journal: `journalctl --user -u omp-collab-companion.service -f`),
 * enables and starts it; that needs `systemctl --user` with a running user
 * manager, and `loginctl enable-linger $USER` keeps it running without a login
 * session. Only one companion may hold the room: stop a manually running one
 * first, or the two fight over it (relay close 4009). `--pair` shows the link
 * while the service runs.
 *
 * Sessions are listed in-process from the collab discovery registry (falling
 * back to `omp collab list --json` when that module cannot load), and links
 * come from the installed omp CLI (`omp collab link <id> --json`,
 * `omp collab start <id> --json`), so the companion works with whichever omp
 * version runs the sessions; features the registry lacks (listing and sharing
 * idle sessions) simply stay empty. Set OMP_BIN when `omp` is not on PATH
 * (launchd, systemd).
 *
 * Starting a session (`start` request) needs tmux: omp runs in a detached
 * `omp-<id>` tmux session with a companion-owned config overlay
 * (`<config>/agent/collab-companion-overlay.yml`) that hosts it with control
 * access. Attach from a terminal with `tmux attach -t omp-<id>`.
 *
 * Web Push: devices that turn notifications on hand over a push subscription;
 * the companion then keeps polling while it runs and notifies them when a
 * session needs input (with the pending question) or finishes a turn (with the
 * start of the reply), sending straight to the browser's push service with its
 * own VAPID key (no server in between). A device that is showing the app is
 * skipped: it alerts in-app instead.
 *
 * Vendor agents (Claude Code, Codex, Cursor, Grok, OpenCode, custom ACP commands): `start` with `agent` runs
 * `./foreign/host-main.ts` in the same kind of tmux session, so the session outlives the companion and is listed like
 * any host (with `agent`). Ended ones come from the session index the hosts write (`./companion-foreign`), appear in the
 * sessions list and recent folders, and are resumed through `start`. The spend limits cap them (`--max-cost`).
 *
 * Staying reachable: the companion holds a sleep assertion while it runs
 * (macOS `caffeinate -i -s`, Linux `systemd-inhibit --what=sleep:idle`), so the
 * computer does not idle-sleep and sessions stay online; closing the lid still
 * sleeps it. The hosts frame carries the power state (`pmset`, or
 * `/sys/class/power_supply` on Linux; none on a computer without a battery),
 * and subscribed devices are pushed when the computer goes on battery, runs
 * low, and is plugged in again.
 */

import { foreignHostLauncher, isCompiled, selfCommand } from "./build-identity";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { QrCode, renderQrHalfBlocks } from "@oh-my-pi/pi-tui/chrome/qrcode";
import { SCHEDULE_IPC_FILE } from "@oh-my-pi/pi-wire/schedule";
import { generateRoomKey, importRoomKey } from "../src/lib/codec";
import {
	type FanoutCompare,
	type FanoutGroup,
	type FanoutKeepResult,
	hostFanout,
	parseForeignSelector,
} from "../src/lib/fanout";
import {
	type CompanionHost,
	type CompanionIdleSession,
	type CompanionPower,
	type CompanionReply,
	type CompanionRequest,
	FileChangedError,
	formatPairingUrl,
	LOW_BATTERY_PCT,
	type PushSubscriptionJson,
	type RecentFolder,
	SessionOpenElsewhereError,
	type CompanionAgent,
	type SessionOverview,
	type SpendLimits,
} from "../src/lib/companion";
import {
	DEFAULT_RELAY_URL,
	decodeBase64Url,
	encodeBase64Url,
	formatCollabLink,
	generateRoomId,
	type ParsedCollabLink,
	parseCollabLink,
} from "../src/lib/link";
import { parseOrg } from "../src/lib/session-org";
import { createBlueprints } from "./companion-blueprint";
import {
	checkFlow,
	checkFocus,
	checkSearch,
	codemapSearch,
	codemapView,
	loadCodemap,
	openThrowawayIndex,
} from "./companion-codemap";
import { collectDiag, recordRelayEvent, recordRequestError } from "./companion-diag";
import { readFileChunk } from "./companion-download";
import { findFileSessions, repoRelativeFocus } from "./companion-file-sessions";
import { fileVersions, listTree, writeRepoFile } from "./companion-files";
import { git, gitDiff, gitSnapshot, isInside, readRepoFile, repoRoot } from "./companion-git";
import {
	canCreatePr,
	createPullRequest,
	createWorktree,
	discardWorktree,
	gitCommit,
	gitPush,
	gitReview,
	removeWorktree,
	reviewDiff,
} from "./companion-gitflow";
import { generateGitText } from "./companion-gitmsg";
import {
	applySetupTrust,
	createWorktreeSweeper,
	effectiveWorktreesDir,
	loadGitFlowFile,
	parseGitFlowSettings,
	projectSettleStatuses,
	projectSetupStatuses,
	replaceSettings,
	runWorktreeSetup,
	saveGitFlowFile,
	worktreeLocations,
} from "./companion-worktrees";
import { checkNumber, checkRepo, ciFailures, repoFolders, repoSessions } from "./companion-cilog";
import { githubItem, githubList } from "./companion-github";
import { createPrReview } from "./companion-prreview";
import { buildInbox } from "./companion-inbox";
import { consumeInvite, type DeviceRecord, DeviceRegistry, issueInvite, parseDevices } from "./companion-devices";
import { installService, managedBy, openCommand, pairCommand, uninstallService } from "./companion-service";
import {
	findSessionFile,
	foreignTranscriptsDir,
	lastAssistantSummary,
	pendingQuestion,
	readSessionTail,
	recentFolders,
	SAFE_ID_RE,
} from "./companion-sessions";
import { COMPANION_RUN_DIR } from "./companion-sandbox";
import { createSettleCleanup, loadSettleState, saveSettleState } from "./companion-settle";
import { createSessionLister } from "./companion-list";
import { preferredRelayPort, startCompanionRelay } from "./companion-local-relay";
import {
	findRunningEndpoint,
	localEndpointFile,
	localAppUrl,
	openInBrowser,
	publishLocalEndpoint,
	removeLocalEndpoint,
} from "./companion-local-endpoint";
import { RoomHost } from "./companion-room";
import { embeddedApp } from "./local-app-embedded";
import { type AppState, createLocalAppHandler, loadEmbeddedBuild } from "./local-app";
import { startSourceApp } from "./local-app-source";
import { restartCompanion, updateOmp } from "./companion-maintain";
import { findSessionHolders } from "./companion-open";
import { capturePane, paneSessionName } from "./companion-pane";
import { awakeTool, holdAwake, powerNotice, readPower } from "./companion-power";
import { capturePreview, closePreviewBrowser, findChrome, isViewport, previewTargets } from "./companion-preview";
import { createPrWatch, ghReadPrs, loadPrWatchFile, parsePrAlertSettings, savePrWatchFile } from "./companion-prwatch";
import { createPrWake } from "./companion-prwake";
import { createSessionSearch, withLiveness } from "./companion-search";
import { checkRunnableRoot, createRunManager } from "./companion-run";
import {
	checkDirectory,
	createScheduler,
	loadSchedules,
	parseScheduleInput,
	saveSchedules,
} from "./companion-schedule";
import { startScheduleIpc } from "./companion-schedule-ipc";
import { createSessionOrg, ghSessionPrDone, loadOrgFile, saveOrgFile } from "./companion-sessionorg";
import {
	createSpendMonitor,
	dayStart,
	parseSpendLimits,
	parseSpendState,
	type SpendReading,
	type SpendState,
	withLimits,
} from "./companion-spend";
import { createScratchFolder } from "./companion-scratch";
import {
	canSandbox,
	createKeyedLock,
	findTmux,
	killTmuxSession,
	launchEnded,
	launchFailure,
	launchInTmux,
	launchScreen,
	parseStartPrompt,
	releaseLaunch,
	type RestrictLaunch,
} from "./companion-start";
import {
	compareGroup,
	createModelCatalog,
	keepRun,
	loadGroups,
	parseFanoutRequest,
	parseKeepRequest,
	saveGroups,
	startFanout,
	withGroup,
} from "./companion-fanout";
import {
	clampSessionLimit,
	fileSessionOverviews,
	isUsageRange,
	readSpend,
	sessionOverview,
	usageReport,
} from "./companion-stats";
import { storeUpload } from "./companion-upload";
import { createVoice } from "./companion-voice";
import { generateVapidKeys, isPushSubscription, sendPush, type VapidKeys } from "./web-push";
import {
	createAgentDirectory,
	createAgentHandlers,
	createForeignCatalog,
	fanoutArg,
	type ForeignStartDeps,
	foreignFanoutModels,
	mergeForeignUsage,
	mergeFileSessions,
	mergeOverviews,
	planForeignStart,
	usageRangeStart,
	withAgents,
	withForeignRows,
	withForeignSpend,
} from "./companion-foreign";
import { deleteCustomAgent, installAgent, listAgents, saveCustomAgent } from "./foreign/agents";
import { readForeignIndexStrict } from "./foreign/foreign-index";

/** Host list refresh while at least one device is connected. */
const POLL_MS = 3_000;
/** Refresh while no device is connected but some want push notifications. */
const PUSH_POLL_MS = 6_000;
/** Back-off after a terminal relay close (e.g. our previous connection still registered as host). */
const RECONNECT_MS = 5_000;
const DEFAULT_WEB_URL = "https://my.omp.sh/";

const configDir = path.join(os.homedir(), process.env.PI_CONFIG_DIR || ".omp");
const statePath = path.join(configDir, "agent", "collab-companion.json");
/** One file per outstanding pairing invite (hashed); `--pair` runs in another process than the companion. */
const invitesDir = path.join(configDir, "agent", "collab-companion-invites");
const sessionsDir = path.join(configDir, "agent", "sessions");
/** Message search over the session files; keeps the searchable text of recent files in memory. */
const sessionSearch = createSessionSearch({ sessionsDir });

/**
 * Vendor agents (Claude Code, Codex, ...): each session runs in its own detached host process (`./foreign/host-main.ts`, started in
 * tmux like omp) that outlives the companion. The hosts write the session index and the transcripts the catalog reads.
 */
const agentDirectory = createAgentDirectory();
const foreignCatalog = createForeignCatalog({
	transcriptsDir: foreignTranscriptsDir(sessionsDir),
	readRows: async () => (await readForeignIndexStrict(configDir)).sessions,
	agentRef: agentDirectory.ref,
});

/** The computer can run vendor agents: tmux is there to run the host in. */
async function foreignReady(): Promise<boolean> {
	return (await findTmux()) !== null;
}

/** Remembers the agents' names for sessions that only know an id. */
function rememberAgents(agents: CompanionAgent[]): CompanionAgent[] {
	agentDirectory.remember(agents);
	return agents;
}

const agentHandlers = createAgentHandlers({
	ready: foreignReady,
	list: async refresh => rememberAgents(await listAgents({ configDir, refresh })),
	install: async id => rememberAgents(await installAgent(id, { configDir })),
	saveCustom: async agent => rememberAgents(await saveCustomAgent(agent, { configDir })),
	deleteCustom: async id => rememberAgents(await deleteCustomAgent(id, { configDir })),
});

const foreignStartDeps: ForeignStartDeps = {
	agents: async () => rememberAgents(await listAgents({ configDir })),
	rows: () => foreignCatalog.rows(),
	limits: () => state.spend?.limits ?? null,
	spentToday: () => foreignCatalog.spentSince(dayStart(Date.now())),
	sessionSpend: sessionId => foreignCatalog.sessionSpend(sessionId),
};

/** What the agent sessions say, or `fallback` (logged) when the index or a transcript cannot be read: omp's own rows still go out. */
async function foreignOr<T>(what: string, work: () => Promise<T>, fallback: T): Promise<T> {
	try {
		return await work();
	} catch (err) {
		console.error(`companion: reading agent sessions for ${what} failed: ${errorText(err)}`);
		return fallback;
	}
}

/** Spend omp's stats database holds plus what the vendor agents' sessions reported. */
async function readSpendAll(limits: SpendLimits, now: number): Promise<SpendReading> {
	const reading = await readSpend(limits, now, knownHosts);
	return await foreignOr(
		"spend",
		() => withForeignSpend(reading, { catalog: foreignCatalog, hosts: knownHosts, limits, now }),
		reading,
	);
}

/** Past and live sessions of omp and of the vendor agents, newest activity first. */
async function allOverviews(request: { limit?: unknown; q?: unknown }): Promise<SessionOverview[]> {
	const live = { hosts: knownHosts, idle: knownIdle };
	const [omp, foreign] = await Promise.all([
		sessionOverview(request, live),
		foreignOr("the session list", () => foreignCatalog.overviews(request, live), []),
	]);
	return mergeOverviews(omp, foreign, clampSessionLimit(request.limit));
}

/** The folders sessions ran in, vendor agents' included. */
async function recentFoldersAll(): Promise<RecentFolder[]> {
	const base = await recentFolders(sessionsDir);
	return await foreignOr("recent folders", () => foreignCatalog.folders(base), base);
}

const overlayPath = path.join(configDir, "agent", "collab-companion-overlay.yml");
const sandboxOverlayPath = path.join(configDir, "agent", "collab-companion-sandbox.yml");
/** The omp that runs sessions: compiled, this very binary; from a checkout, the one on PATH or bun's global bin. */
const ompBin =
	process.env.OMP_BIN ||
	(isCompiled ? process.execPath : Bun.which("omp") || path.join(os.homedir(), ".bun", "bin", "omp"));
/** How long `start` waits for the new omp to appear in `omp collab list`. */
const START_WAIT_MS = 45_000;
const START_POLL_MS = 1_000;
/** Starts in one folder run one at a time: each waits for "the new host in this folder" to appear. */
const startLock = createKeyedLock();
/** How often schedules are checked for being due, independent of the host poll. */
const SCHEDULE_TICK_MS = 15_000;

interface CompanionState {
	relayUrl: string;
	roomId: string;
	/** base64url room key. */
	key: string;
	vapid: VapidKeys;
	/** Paired devices; each holds its own push subscription. */
	devices: DeviceRecord[];
	spend?: SpendState;
}

async function omp(args: string[]): Promise<string> {
	const proc = Bun.spawn([ompBin, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(err.trim() || `omp ${args.join(" ")} exited with ${code}`);
	return out;
}

async function configValue(key: string): Promise<string> {
	const parsed = JSON.parse(await omp(["config", "get", key, "--json"])) as { value?: unknown };
	return typeof parsed.value === "string" ? parsed.value.trim() : "";
}

async function saveState(state: CompanionState): Promise<void> {
	await fs.mkdir(path.dirname(statePath), { recursive: true });
	await fs.writeFile(statePath, `${JSON.stringify(state, null, "\t")}\n`, { mode: 0o600 });
	await fs.chmod(statePath, 0o600);
}

async function loadState(relayUrl: string, rotate: boolean): Promise<CompanionState> {
	if (!rotate) {
		try {
			const raw = JSON.parse(await Bun.file(statePath).text()) as Partial<CompanionState> & {
				subscriptions?: unknown;
			};
			if (
				raw.relayUrl === relayUrl &&
				typeof raw.roomId === "string" &&
				typeof raw.key === "string" &&
				decodeBase64Url(raw.key)?.byteLength === 32
			) {
				const hasVapid = typeof raw.vapid?.publicKey === "string" && typeof raw.vapid.privateJwk === "object";
				const state: CompanionState = {
					relayUrl,
					roomId: raw.roomId,
					key: raw.key,
					vapid: hasVapid ? (raw.vapid as VapidKeys) : await generateVapidKeys(),
					// Subscriptions are bound to the VAPID key they were made with.
					devices: parseDevices(raw.devices).map(({ subscription, ...device }) =>
						hasVapid ? { ...device, subscription } : device,
					),
					spend: parseSpendState(raw.spend),
				};
				// Before devices authenticated, subscriptions were kept top-level and cannot be attributed to a
				// device: they are dropped (devices register again on launch), and so is the field.
				if (!hasVapid || raw.subscriptions !== undefined) await saveState(state);
				return state;
			}
		} catch {
			// missing or unreadable: pair afresh below
		}
	}
	const state: CompanionState = {
		relayUrl,
		roomId: generateRoomId(),
		key: encodeBase64Url(generateRoomKey()),
		vapid: await generateVapidKeys(),
		devices: [],
	};
	await saveState(state);
	return state;
}

const lister = createSessionLister({ runOmp: omp, sandboxOverlayPath });
const voice = createVoice(path.join(configDir, "agent", "config.yml"));
/** Scripts and build targets started from the app; their output stays until the companion restarts. */
const runs = createRunManager();
const prReview = createPrReview();

// ── startup ──────────────────────────────────────────────────────────────────

const flags = Bun.argv.slice(2);
if (flags.includes("--uninstall")) {
	try {
		console.log(await uninstallService());
	} catch (err) {
		console.error(errorText(err));
		process.exit(1);
	}
	process.exit(0);
}
const rotate = flags.includes("--rotate");
const relayUrl = (await configValue("collab.relayUrl")) || DEFAULT_RELAY_URL;
const webUrl = (await configValue("collab.webUrl")) || DEFAULT_WEB_URL;
const state = await loadState(relayUrl, rotate);
// A rotated room is a new room: invites issued for the old one must not pair anyone into it.
if (rotate) await fs.rm(invitesDir, { recursive: true, force: true });
const registry = new DeviceRegistry(state.devices, { now: Date.now, save: () => saveState(state) });
const rawKey = decodeBase64Url(state.key) as Uint8Array;
const roomLink = formatCollabLink(state.relayUrl, state.roomId, rawKey);
const machine = os.hostname().replace(/\.local$/, "");
const sandboxAvailable = await canSandbox();
const worktreesDir = path.join(configDir, "worktrees");
/** VAPID `sub` claim: push services want a contact URL; Apple rejects non-https ones. */
const pushSubject = webUrl.startsWith("https://") ? new URL(webUrl).origin : "https://my.omp.sh";

/** A pairing link for the app this computer serves on `port`, with a fresh one-time invite; `expiresAt` in ms since epoch. */
async function localPairing(port: number): Promise<{ url: string; expiresAt: number }> {
	const invite = await issueInvite(invitesDir, Date.now());
	return { url: formatPairingUrl(localAppUrl(port), roomLink, invite.invite), expiresAt: invite.expiresAt };
}

/** Print (and, for `--open`, open) the local pairing link. The link works once; it is printed because the user asked for it. */
async function showLocalPairing(port: number, open: boolean): Promise<void> {
	const { url, expiresAt } = await localPairing(port);
	if (!open) {
		console.log(url);
		return;
	}
	const minutes = Math.round((expiresAt - Date.now()) / 60_000);
	if (await openInBrowser(url)) {
		console.log(`opened ${url} in your browser; the link works once and expires in ${minutes} minutes`);
	} else {
		console.log(
			`could not open a browser; open this link on this computer (it works once and expires in ${minutes} minutes):\n${url}`,
		);
	}
}

// `--open` / `--print-local-link` talk to the companion that is already running; they start nothing and print no Pages link.
const printLocalLink = flags.includes("--print-local-link");
const openLocalApp = flags.includes("--open");
if (printLocalLink || openLocalApp) {
	const running = await findRunningEndpoint(localEndpointFile(configDir));
	if (running?.app) {
		await showLocalPairing(running.port, !printLocalLink);
		process.exit(0);
	}
	if (running !== null) {
		console.error(
			"companion: the running companion does not serve the app (started with --no-local-app, or this build has none)",
		);
		process.exit(1);
	}
	if (printLocalLink) {
		console.error(
			"companion: no companion is running on this computer; start it (`omp companion`) or install the service",
		);
		process.exit(1);
	}
	// `--open` with no companion running: this process becomes one, and opens the app once it serves it.
}

console.log("omp collab companion");
// A service's output goes to a log the machine's other administrators can read (the systemd journal), and a
// live invite there would pair a device into this computer. The service prints none; `--pair` issues one on demand.
if (managedBy() === null) {
	const invite = await issueInvite(invitesDir, Date.now());
	const pairUrl = formatPairingUrl(webUrl, roomLink, invite.invite);
	console.log(`pair a device: scan the code or open ${pairUrl}`);
	console.log(
		`the code works once and expires in ${Math.round((invite.expiresAt - Date.now()) / 60_000)} minutes; the app's Devices screen makes new ones`,
	);
	for (const row of renderQrHalfBlocks(QrCode.encodeText(pairUrl, "M"))) console.log(` ${row}`);
} else {
	console.log(`pair a device: run \`${pairCommand()}\` in a terminal on this computer`);
}
console.log(
	`paired devices stored in ${statePath}; remove one in the app's Devices screen, or --rotate to unpair every device`,
);

if (flags.includes("--install")) {
	const dryRun = flags.includes("--dry-run");
	try {
		const service = await installService({ ompBin, argv: selfCommand(), dryRun });
		if (dryRun) {
			console.log(`dry run: would write ${service.file}:\n${service.text}`);
		} else {
			for (const line of service.lines) console.log(line);
			console.log("stop any manually running companion: two of them fight over the room (relay close 4009)");
		}
	} catch (err) {
		console.error(errorText(err));
		process.exit(1);
	}
	process.exit(0);
}
if (flags.includes("--pair")) process.exit(0);

// ── local relay ──────────────────────────────────────────────────────────────

/**
 * Start serving the web app. Compiled, the binary carries it; from a checkout the companion builds it into its cache
 * (`./local-app-source`). Neither blocks the companion: the app answers "building" until its files are ready.
 */
function startLocalApp(): () => AppState {
	if (isCompiled) {
		let state: AppState = { kind: "building" };
		loadEmbeddedBuild(embeddedApp!).then(
			build => {
				state = { kind: "ready", build };
			},
			err => {
				state = { kind: "failed" };
				console.error(`companion: the embedded web app is unusable: ${errorText(err)}`);
			},
		);
		return () => state;
	}
	return startSourceApp({
		cacheDir: path.join(configDir, "cache", "collab-web"),
		repoDir: path.join(import.meta.dir, "..", "..", ".."),
		build: async outdir => (await import("./build-app")).buildApp(outdir, { local: true, quiet: true }),
		log: line => console.log(`companion: ${line}`),
	}).state;
}

/**
 * Loopback relay for the sessions this companion starts: the app on this computer joins them
 * there instead of through the public relay (omp serves each room on both). Phones still use
 * the public one. `--no-local-relay` turns it off.
 */
let localRelayUrl: string | undefined;
/** The relay also serves the web app (`--no-local-app` turns that off; it needs the relay). */
const serveApp =
	!flags.includes("--no-local-app") && !flags.includes("--no-local-relay") && (!isCompiled || embeddedApp !== null);
if (isCompiled && embeddedApp === null && !flags.includes("--no-local-app")) {
	console.log("companion: this build embeds no web app, so none is served on this computer");
}
/** What the app handler serves now; set once the relay is up. */
let appState: () => AppState = () => ({ kind: "building" });
if (!flags.includes("--no-local-relay")) {
	try {
		const configured = await configValue("collab.localRelayUrl").catch(() => "");
		const started = startCompanionRelay({
			preferredPort: preferredRelayPort(configured),
			allowedOrigins: [new URL(webUrl).origin],
			app: serveApp ? createLocalAppHandler(() => appState()) : undefined,
		});
		localRelayUrl = started.url;
		console.log(`local relay on ${localRelayUrl}: sessions started from the app are also served there`);
		console.log(`for sessions started by hand, set collab.localRelayUrl to ${localRelayUrl}`);
		const port = Number(new URL(started.url).port);
		await publishLocalEndpoint(localEndpointFile(configDir), { pid: process.pid, port, app: serveApp }).catch(err =>
			console.error(
				`companion: could not publish the local address (companion --open will not find this companion): ${errorText(err)}`,
			),
		);
		if (serveApp) {
			appState = startLocalApp();
			console.log(
				`open ${localAppUrl(port).replace(/\/$/, "")} on this computer (${openCommand()} pairs this browser)`,
			);
			if (openLocalApp) await showLocalPairing(port, true);
		}
	} catch (err) {
		console.error(`companion: local relay unavailable, sessions use the public relay only: ${errorText(err)}`);
	}
}

// ── room ─────────────────────────────────────────────────────────────────────

const room = new RoomHost<CompanionReply, CompanionRequest>({
	publicUrl: (parseCollabLink(roomLink) as ParsedCollabLink).wsUrl,
	localUrl: localRelayUrl === undefined ? undefined : `${localRelayUrl}/r/${state.roomId}`,
	key: importRoomKey(rawKey),
});

/** Peers that authenticated as a paired device: only these are served. */
const peers = new Set<number>();
/** Authenticated peer → its device id. */
const peerDevice = new Map<number, string>();
/** Devices that said (`list.zip`) they open compressed frames; large replies to them are compressed. */
const zipPeers = new Set<number>();
/** What each connected device last said about itself; see `presence` requests. */
const presence = new Map<number, { endpoint: string | null; visible: boolean }>();
let lastHostsJson = "";
/** The codemap module loaded; the hosts frame advertises code maps from then on. */
let codemapReady = false;
/** Chromium-based browser that screenshots previews; null until found, and when the computer has none. */
let previewChrome: string | null = null;
let pollTimer: Timer | undefined;
/** Per-host state at the previous poll; null until a poll after (re)starting to watch. */
let seen: Map<string, { busy: boolean | null; inputRequired: boolean }> | null = null;
/** Sessions from the latest listing; requests naming an instance resolve against these. */
let knownHosts: CompanionHost[] = [];
let knownIdle: CompanionIdleSession[] = [];
/** instanceId → pid of every listed session, from the same listing as `knownHosts`. */
let knownPids = new Map<string, number>();
/** Power at the previous poll; null until a poll after (re)starting to watch. */
let lastPower: CompanionPower | null = null;
/** The low-battery push went out during this discharge. */
let lowWarned = false;
const awake = holdAwake(reason => {
	console.error(
		`companion: could not hold the ${process.platform === "darwin" ? "Mac" : "computer"} awake (${awakeTool()}): ${reason}`,
	);
});

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function hostTitle(host: CompanionHost): string {
	return host.sessionName || path.basename(host.cwd) || "session";
}

/**
 * `topic` defaults to the session: a newer notice for it replaces one still undelivered. `tag` and `url` reach the service worker
 * (notification replacement, tap target). Every payload carries this companion's room id as `computer`, so a device paired with
 * several computers opens the session on the right one: instance ids are only unique per computer.
 */
function push(
	subscription: PushSubscriptionJson,
	payload: {
		title: string;
		body: string;
		instanceId?: string;
		url?: string;
		tag?: string;
		open?: string;
		badge?: number;
		reply?: true;
	},
	topic = payload.instanceId,
): void {
	sendPush(subscription, { ...payload, computer: state.roomId }, state.vapid, pushSubject, topic).then(
		status => {
			// 404/410: the browser dropped the subscription (unsubscribed, app removed).
			if (status === 404 || status === 410)
				registry
					.dropEndpoint(subscription.endpoint)
					.catch(err => console.error(`companion: saving state failed: ${errorText(err)}`));
			else if (status >= 400)
				console.error(`companion: push rejected (${status}) by ${new URL(subscription.endpoint).host}`);
		},
		err => console.error(`companion: push failed: ${errorText(err)}`),
	);
}

/** Push to every subscribed device except those showing the app right now; carries the badge count (sessions waiting on an answer) and offers an inline reply. */
function notify(host: CompanionHost, body: string): void {
	const showing = new Set<string>();
	for (const p of presence.values()) if (p.visible && p.endpoint) showing.add(p.endpoint);
	const badge = knownHosts.filter(h => h.inputRequired).length;
	for (const subscription of registry.subscriptions()) {
		if (showing.has(subscription.endpoint)) continue;
		push(subscription, { title: hostTitle(host), body, instanceId: host.instanceId, badge, reply: true });
	}
}

/** Push power changes (unplugged, low, plugged in again) to every subscribed device: the app has no in-app alert for them. */
function detectPowerEdges(next: CompanionPower | null): void {
	const prev = lastPower;
	lastPower = next;
	if (next?.source !== "battery") lowWarned = false;
	if (prev === null || next === null || registry.subscriptions().length === 0) return;
	const notice = powerNotice(machine, prev, next, lowWarned);
	if (notice === null) return;
	if (next.source === "battery" && next.battery !== null && next.battery <= LOW_BATTERY_PCT) lowWarned = true;
	for (const subscription of registry.subscriptions()) push(subscription, notice);
}

/** Pushes once when spend crosses a limit set in the app; checks only while some device could receive it. */
const spendMonitor = createSpendMonitor({
	now: Date.now,
	state: () => state.spend,
	save: async next => {
		state.spend = next;
		await saveState(state);
	},
	wanted: () => registry.subscriptions().length > 0,
	read: readSpendAll,
	alert: alert => {
		for (const subscription of registry.subscriptions()) push(subscription, alert);
	},
	onError: err => console.error(`companion: spend check failed: ${errorText(err)}`),
});

const prWatchPath = path.join(path.dirname(statePath), "collab-companion-prwatch.json");
let prAlertState = await loadPrWatchFile(prWatchPath);

/** Pushes when checks finish or someone reviews or comments on the user's open pull requests in the repositories of known sessions. */
const prWatch = createPrWatch({
	now: Date.now,
	state: () => prAlertState.prs,
	settings: () => prAlertState.settings,
	save: async prs => {
		prAlertState = { settings: prAlertState.settings, prs };
		await savePrWatchFile(prWatchPath, prAlertState);
	},
	wanted: async () => registry.subscriptions().length > 0 && (await canCreatePr()),
	listRepos: async () => {
		const roots = await Promise.all(
			[...knownHosts, ...knownIdle].map(session => repoRoot(session.cwd).catch(() => null)),
		);
		return [...new Set(roots.filter((root): root is string => root !== null))];
	},
	readPrs: ghReadPrs,
	alert: alert => {
		const { topic, ...payload } = alert;
		for (const subscription of registry.subscriptions()) push(subscription, payload, topic);
	},
	onError: err => console.error(`companion: pull request check failed: ${errorText(err)}`),
});

/** Polls the pull requests sessions on this computer asked to have watched (`watch_pr`) and leaves each reading in the session's inbox. */
const prWake = createPrWake({
	dir: path.join(configDir, "run", "pr-watch"),
	now: Date.now,
	canRead: canCreatePr,
	alert: alert => {
		const { topic, ...payload } = alert;
		for (const subscription of registry.subscriptions()) push(subscription, payload, topic);
	},
	onError: err => console.error(`companion: watched pull request check failed: ${errorText(err)}`),
});

const gitFlowPath = path.join(path.dirname(statePath), "collab-companion-git.json");
let gitFlow = await loadGitFlowFile(gitFlowPath);

/** Removes worktrees whose pull request merged or that went unused, when the user turned that on; never a dirty or occupied one. */
const worktreeSweeper = createWorktreeSweeper({
	settings: () => gitFlow.settings.cleanup,
	dirs: () => worktreeLocations(gitFlow, worktreesDir),
	runningCwds: async () => {
		await loadSessions();
		return [...knownHosts, ...knownIdle].map(session => session.cwd);
	},
	onRemoved: removed => {
		for (const tree of removed) console.log(`companion: removed worktree ${tree.path} (${tree.reason})`);
	},
});

/** Repositories whose `.omp/worktree-setup` a start left unused because the user has not approved it; listed in the worktree settings for review. */
const unapprovedSetups = new Set<string>();

/**
 * Run the setup for a fresh worktree. A repository's own script runs only once the user approved its
 * exact content (worktree settings); a sandboxed session's agent can write that file, so it never does for one.
 */
async function setupWorktree(
	tree: { root: string; path: string; branch: string },
	sandboxed: boolean | undefined,
): Promise<void> {
	const { unapproved } = await runWorktreeSetup(tree, {
		command: gitFlow.settings.setupScript,
		allowProjectFile: sandboxed !== true,
		trusted: gitFlow.trustedSetups,
	});
	if (!unapproved) return;
	unapprovedSetups.add(unapproved.root);
	console.error(`companion: ${unapproved.root} has a .omp/worktree-setup that is not approved; it was not run`);
}

/** Repositories whose `.omp/worktree-settle` a settle left unused because the user has not approved it; listed in the worktree settings for review. */
const unapprovedSettles = new Set<string>();

const settleStatePath = path.join(path.dirname(statePath), "collab-companion-settle.json");

/** Runs the user's cleanup command in a worktree when its session settles; see ./companion-settle. */
const settleCleanup = createSettleCleanup({
	initial: await loadSettleState(settleStatePath),
	save: state => saveSettleState(settleStatePath, state),
	flow: () => gitFlow,
	dirs: () => worktreeLocations(gitFlow, worktreesDir),
	listing: async () =>
		(await loadSessions()).hosts.map(host => ({
			sessionId: host.sessionId,
			cwd: host.cwd,
			sandboxed: host.sandboxed === true,
		})),
	onUnapproved: root => {
		unapprovedSettles.add(root);
		console.error(`companion: ${root} has a .omp/worktree-settle that is not approved; it was not run`);
	},
	onError: err => console.error(`companion: worktree settle cleanup failed: ${errorText(err)}`),
});

const sessionOrgPath = path.join(path.dirname(statePath), "collab-companion-sessionorg.json");

/** Pin / snooze / settle state every device syncs through, and the auto-settle rules; see ./companion-sessionorg. */
const sessionOrg = createSessionOrg({
	now: Date.now,
	initial: await loadOrgFile(sessionOrgPath),
	save: file => saveOrgFile(sessionOrgPath, file),
	readPrDone: ghSessionPrDone,
	prAvailable: canCreatePr,
	onChange: () => void refresh(),
	// Never awaited: a cleanup command must not hold up the settle (or the sync that carried it).
	onSettled: sessions => void settleCleanup.run(sessions),
	endSession: async (session, stillWanted) => {
		const target = await companionTmuxSession(session.instanceId);
		// Hand-started sessions are never touched.
		if (target === null) return true;
		// The cleanup runs once this session is gone from the listing, and finds its worktree only through what was recorded.
		const sandboxed = [...knownHosts, ...knownIdle].some(
			s => s.instanceId === session.instanceId && s.sandboxed === true,
		);
		await settleCleanup
			.recordSession(session.sessionId, session.cwd)
			.catch(err => console.error(`companion: remembering session ${session.sessionId} failed: ${errorText(err)}`));
		if (sandboxed)
			await settleCleanup
				.recordSandboxed(session.cwd)
				.catch(err => console.error(`companion: remembering sandboxed ${session.cwd} failed: ${errorText(err)}`));
		// Everything above awaited: look again at a fresh listing, so an un-settle or a prompt sent meanwhile wins.
		await loadSessions();
		const now = [...knownHosts, ...knownIdle].find(s => s.instanceId === session.instanceId);
		if (now === undefined || now.busy !== false || ("inputRequired" in now && now.inputRequired)) return false;
		if (!stillWanted()) return false;
		await killTmuxSession(target.tmux, target.name);
		return true;
	},
	onError: err => console.error(`companion: session organisation failed: ${errorText(err)}`),
});

const fanoutPath = path.join(path.dirname(statePath), "collab-companion-fanout.json");
/** Best-of-N groups (see ./companion-fanout), newest first. */
let fanoutGroups = await loadGroups(fanoutPath);
const fanoutModels = createModelCatalog(ompBin);

const schedulesPath = path.join(path.dirname(statePath), "collab-companion-schedules.json");

/** Starts the prompts the user scheduled in the app, pushing when one starts or fails to; see ./companion-schedule. */
const scheduler = createScheduler({
	now: Date.now,
	initial: await loadSchedules(schedulesPath, Date.now()),
	save: schedules => saveSchedules(schedulesPath, schedules),
	start: schedule =>
		startSession(
			schedule.cwd,
			schedule.mode === "resume" ? schedule.sessionId : undefined,
			schedule.sandboxed,
			schedule.worktree ? {} : undefined,
			undefined,
			schedule.prompt,
			schedule.maxCostUsd,
		),
	spendLimitReached: async () => {
		const limit = state.spend?.limits.dailyUsd ?? null;
		if (limit === null) return false;
		return (await readSpendAll({ dailyUsd: limit, sessionUsd: null }, Date.now())).dailyUsd >= limit;
	},
	refreshSessions: async () => {
		await loadSessions();
	},
	isWorking: instanceId =>
		knownHosts.some(host => host.instanceId === instanceId && (host.busy === true || host.inputRequired)),
	notify: notice => {
		for (const subscription of registry.subscriptions()) push(subscription, notice);
	},
	onError: err => console.error(`companion: scheduled run failed: ${errorText(err)}`),
});
/** Schedules fire with no device connected and no push subscription too, so they have their own clock besides the poll. */
setInterval(() => void scheduler.tick(), SCHEDULE_TICK_MS).unref();

/** omp's `schedule` tool reaches the scheduler through this loopback channel (see ./companion-schedule-ipc). */
const scheduleIpc = await startScheduleIpc({
	file: path.join(path.dirname(statePath), SCHEDULE_IPC_FILE),
	scheduler,
	validate: { now: Date.now, sandboxAvailable, checkDirectory },
});

/**
 * Push the session's pending question or the start of its last reply, falling
 * back to a fixed text when its file cannot be read. The session file may lag
 * the edge by a moment, so a missing question is looked for once more.
 */
async function announce(host: CompanionHost, edge: "input" | "done"): Promise<void> {
	let body = edge === "input" ? "Needs your input" : "Finished, your turn";
	try {
		const read = async () => {
			const entries = await readSessionTail(sessionsDir, host.sessionId);
			return edge === "input" ? pendingQuestion(entries) : lastAssistantSummary(entries);
		};
		const text = (await read()) ?? (await Bun.sleep(750).then(read));
		if (text) body = text;
	} catch (err) {
		console.error(`companion: reading session text failed: ${errorText(err)}`);
	}
	notify(host, body);
}

/** Push on a session's needs-input and busy→idle edges since the previous poll. */
function detectEdges(hosts: CompanionHost[]): void {
	const prev = seen;
	seen = new Map(hosts.map(h => [h.instanceId, { busy: h.busy, inputRequired: h.inputRequired }]));
	if (prev === null || registry.subscriptions().length === 0) return;
	for (const host of hosts) {
		const before = prev.get(host.instanceId);
		if (!before) continue;
		if (host.inputRequired && !before.inputRequired) void announce(host, "input");
		else if (before.busy === true && host.busy === false && !host.inputRequired) void announce(host, "done");
	}
}

async function loadSessions(): Promise<{ hosts: CompanionHost[]; idle: CompanionIdleSession[] }> {
	const listed = await lister.list();
	// A vendor host has no omp overlay to tell it is sandboxed: its index row says. An index that cannot be read leaves
	// no rows, and a host without a row counts as sandboxed (see withForeignRows).
	const hosts = listed.hosts.some(host => host.agent)
		? withForeignRows(listed.hosts, await foreignOr("sandbox state", () => foreignCatalog.rows(), {}))
		: listed.hosts;
	knownHosts = hosts;
	knownIdle = listed.idle;
	knownPids = listed.pids;
	// A listing that came back empty is more likely a glitch than every session gone: keep the history then.
	if (hosts.length + listed.idle.length > 0)
		runs.retain(new Set([...hosts, ...listed.idle].map(session => session.instanceId)));
	return { hosts, idle: listed.idle };
}

/**
 * Repository root a session's runs happen in, from a fresh listing. Refused when any listed sandboxed
 * session works in it: that agent can write the files that define the targets.
 */
async function runRoot(instanceId: unknown): Promise<{ instanceId: string; root: string }> {
	const id = checkInstanceId(instanceId);
	await loadSessions();
	const sessions = [...knownHosts, ...knownIdle];
	const session = sessions.find(s => s.instanceId === id);
	if (!session) throw new Error("unknown session");
	const rootOf = async (cwd: string): Promise<string> => (await repoRoot(cwd)) ?? fs.realpath(cwd);
	const root = await rootOf(session.cwd);
	await checkRunnableRoot(root, sessions, rootOf);
	return { instanceId: id, root };
}

/** Broadcast the host list when it changed; otherwise answer only `targetPeer`, if any. */
async function refresh(targetPeer?: number): Promise<void> {
	// Nobody to tell while push-only polling: a device's `list` on joining gets a fresh answer.
	const framed = peers.size > 0;
	// Everything the frame needs is independent of the listing, so the reply waits only for the slowest of them.
	const [listed, power, extras] = await Promise.all([
		loadSessions().catch((err: unknown) => {
			console.error(`companion: listing sessions failed: ${errorText(err)}`);
			return null;
		}),
		readPower(awake.held),
		framed
			? Promise.all([findTmux(), canCreatePr(), voice.info()]).then(([tmux, canPr, transcribe]) => ({
					canStart: tmux !== null,
					canPr,
					transcribe,
				}))
			: null,
	]);
	if (!listed) return;
	detectEdges(listed.hosts);
	void spendMonitor.tick();
	void scheduler.tick();
	void sessionOrg
		.tick([...listed.hosts, ...listed.idle.map(session => ({ ...session, inputRequired: false }))])
		.catch(err => console.error(`companion: session organisation failed: ${errorText(err)}`));
	void prWatch.tick();
	void prWake.tick();
	void worktreeSweeper.tick().catch(err => console.error(`companion: worktree cleanup failed: ${errorText(err)}`));
	detectPowerEdges(power);
	if (!extras || peers.size === 0) return;
	const fanoutOf = hostFanout(fanoutGroups);
	const frame: CompanionReply = {
		t: "hosts",
		machine,
		hosts: listed.hosts.map(host =>
			Object.hasOwn(fanoutOf, host.instanceId) ? { ...host, fanout: fanoutOf[host.instanceId] } : host,
		),
		vapidKey: state.vapid.publicKey,
		idle: listed.idle,
		canStart: extras.canStart,
		canSandbox: extras.canStart && sandboxAvailable,
		canPr: extras.canPr,
		canCodemap: codemapReady,
		canBlueprint: codemapReady,
		canEdit: true,
		canPreview: previewChrome !== null,
		// Reading issues and pull requests needs the same signed-in gh as opening one.
		canGithub: extras.canPr,
		canPrReview: extras.canPr,
		canFixIt: extras.canPr,
		canUpload: true,
		canSchedule: extras.canStart,
		canScheduleCron: extras.canStart,
		canFanout: extras.canStart,
		canGitFlow: true,
		canRun: process.platform !== "win32",
		canDownload: true,
		canSearch: true,
		canScratch: extras.canStart,
		canBackgroundStart: extras.canStart,
		canForeign: extras.canStart,
		sessionOrgRev: sessionOrg.file().rev,
		canOrderSessions: true,
		canEndOnSettle: true,
		transcribe: extras.transcribe ?? undefined,
		power: power ?? undefined,
	};
	const json = JSON.stringify(frame);
	if (json !== lastHostsJson) for (const peer of peers) room.send(frame, peer, zipPeers.has(peer));
	else if (targetPeer !== undefined) room.send(frame, targetPeer, zipPeers.has(targetPeer));
	lastHostsJson = json;
}

function checkInstanceId(value: unknown): string {
	if (typeof value !== "string" || !SAFE_ID_RE.test(value)) throw new Error("invalid instance id");
	return value;
}

/** A listed session, refreshing the list once for an unknown instance. */
async function listedSession(instanceId: unknown): Promise<CompanionHost | CompanionIdleSession> {
	const id = checkInstanceId(instanceId);
	const find = () => [...knownHosts, ...knownIdle].find(s => s.instanceId === id);
	let session = find();
	if (!session) {
		await loadSessions();
		session = find();
	}
	if (!session) throw new Error("unknown session");
	return session;
}

/** Working directory of a listed session. */
async function sessionCwd(instanceId: unknown): Promise<string> {
	return (await listedSession(instanceId)).cwd;
}

/** Working directory of a session for a write to GitHub as the user: sandboxed sessions are limited to reading and editing files. */
async function reviewWriteCwd(instanceId: unknown): Promise<string> {
	const session = await listedSession(instanceId);
	if (session.sandboxed === true) throw new Error("Reviews and merges are not available from a sandboxed session.");
	return session.cwd;
}

/** Working directory of a listed session whose repository the app may change: refused while its agent works. */
async function idleSessionCwd(instanceId: unknown): Promise<string> {
	const id = checkInstanceId(instanceId);
	// A fresh list: the agent may have started a turn since the last poll.
	await loadSessions();
	const session = [...knownHosts, ...knownIdle].find(s => s.instanceId === id);
	if (!session) throw new Error("unknown session");
	// null: an omp that predates the field, so a turn may be running.
	if (session.busy === null) throw new Error("Agent state unknown; update omp on the computer");
	if (session.busy) throw new Error("Agent is working; wait until it is idle");
	return session.cwd;
}

/** What a `start` that runs a vendor agent adds to {@link startSession}; absent fields come from the resumed session or the defaults. */
interface ForeignStart {
	agent?: unknown;
	/** The vendor's model id. */
	model?: unknown;
	permission?: unknown;
	/** Fan-out membership: the group and the model selector the member was picked by. */
	fanout?: { group: string; selector: string };
}

/**
 * Start omp in a detached tmux session — sandboxed to `cwd` with file tools
 * only when `sandboxed` — and wait until it hosts collab; resolves with its instance id.
 * Resuming a session that already hosts answers with that host; one another omp has open is
 * refused (`SessionOpenElsewhereError`) unless `force`.
 * With `foreign.agent`, or when `resume` names a session of the foreign index, the session runs a vendor agent instead:
 * a detached host process (`./foreign/host-main.ts`) in the same kind of tmux session, listed like any other host.
 */
async function startSession(
	cwd: unknown,
	resume: unknown,
	sandboxed: unknown,
	worktree: { branch?: unknown } | undefined,
	force: unknown,
	/** Delivered to omp at launch (scheduled runs); a session that already hosts cannot take it, so that is refused. */
	prompt?: string,
	/** Scheduled runs with a per-run spend limit: `omp --max-cost` (USD). */
	maxCostUsd?: number,
	/** Fan-out sessions: `omp --model provider/id`. */
	model?: string,
	foreign?: ForeignStart,
	/** A session that only reads the code and writes one file (architecture maps); see {@link RestrictLaunch}. */
	restrict?: RestrictLaunch,
): Promise<string> {
	if (
		typeof cwd !== "string" ||
		(resume !== undefined && typeof resume !== "string") ||
		(sandboxed !== undefined && typeof sandboxed !== "boolean") ||
		(force !== undefined && typeof force !== "boolean") ||
		(worktree !== undefined && (typeof worktree !== "object" || worktree === null)) ||
		(worktree?.branch !== undefined && typeof worktree.branch !== "string")
	) {
		throw new Error("invalid request");
	}
	if (resume !== undefined && !SAFE_ID_RE.test(resume)) throw new Error("invalid session id");
	const plan = await planForeignStart(
		{
			agent: foreign?.agent,
			resume,
			cwd,
			model: foreign?.model,
			permission: foreign?.permission,
			sandboxed,
			maxCostUsd,
		},
		foreignStartDeps,
	);
	if (plan && !(await foreignReady())) throw new Error("This computer cannot run other agents (tmux is missing).");
	console.log(
		`companion: ${new Date().toISOString()} starting ${plan ? plan.agent.name : "omp"} in ${plan?.cwd ?? cwd}${resume === undefined ? "" : ` (resuming ${resume})`}`,
	);
	if (worktree !== undefined && resume !== undefined)
		throw new Error("a worktree needs a new session, not a resumed one");
	if (resume !== undefined) {
		const listed = await loadSessions();
		const live = listed.hosts.find(host => (plan ? host.sessionId === resume : host.sessionId.startsWith(resume)));
		if (live) {
			if (prompt !== undefined) throw new Error("that session is already open; the scheduled prompt was not sent");
			return live.instanceId;
		}
		// A vendor session has no omp process another terminal could hold.
		if (!plan && force !== true) {
			const listedPids = listed.idle
				.filter(session => session.sessionId.startsWith(resume))
				.flatMap(session => knownPids.get(session.instanceId) ?? []);
			const holders = await findSessionHolders(resume, await findSessionFile(sessionsDir, resume), listedPids);
			if (holders.length > 0) throw new SessionOpenElsewhereError(holders);
		}
	}
	const tmux = await findTmux();
	if (!tmux) throw new Error("tmux is not installed on this computer");
	// omp runs under sandbox-exec; a vendor agent never does (`planForeignStart` refuses a sandboxed one).
	if (sandboxed && !plan && !sandboxAvailable) throw new Error("sandboxed sessions need macOS sandbox-exec");
	const sandbox = sandboxed
		? {
				home: os.homedir(),
				configDir,
				tmpDir: os.tmpdir(),
				companionState: statePath,
				overlayPath: sandboxOverlayPath,
			}
		: undefined;
	const workCwd = plan?.cwd ?? cwd;
	// The worktree checkout can take a while: the boot wait starts after it.
	const created = worktree
		? await createWorktree(
				workCwd,
				effectiveWorktreesDir(gitFlow.settings, worktreesDir),
				worktree.branch,
				new Date(),
				{
					branchPrefix: gitFlow.settings.branchPrefix,
				},
			)
		: null;
	try {
		// A failing setup (an install that breaks) discards the tree below, like a session that cannot start.
		if (created) await setupWorktree(created, sandboxed);
		const launchCwd = created?.path ?? workCwd;
		// Sticky, and before omp starts: no cleanup command ever runs in a tree a sandboxed agent could write.
		if (sandboxed) await settleCleanup.recordSandboxed(launchCwd);
		const lockKey = await fs.realpath(launchCwd).catch(() => launchCwd);
		return await startLock(lockKey, async () => {
			const before = new Set((await loadSessions()).hosts.map(h => h.instanceId));
			const spawnedAt = Date.now();
			const launched = await launchInTmux({
				tmux,
				ompBin,
				overlayPath,
				promptDir: path.join(configDir, COMPANION_RUN_DIR),
				localRelayUrl,
				cwd: launchCwd,
				resume: plan ? plan.resume : resume,
				sandbox,
				prompt,
				maxCostUsd: plan ? plan.maxCostUsd : maxCostUsd,
				model: plan ? plan.model : model,
				restrict,
				keepEnded: true,
				foreign: plan
					? {
							host: foreignHostLauncher(),
							agent: plan.agent.id,
							permission: plan.permission,
							worktree: created !== null || plan.row?.worktree === true,
							relayUrl: state.relayUrl,
							webUrl,
							fanout: foreign?.fanout
								? fanoutArg(foreign.fanout.group, foreign.fanout.selector, agentDirectory.ref(plan.agent.id))
								: plan.row?.fanout && JSON.stringify(plan.row.fanout),
						}
					: undefined,
			});
			while (Date.now() < spawnedAt + START_WAIT_MS) {
				await Bun.sleep(START_POLL_MS);
				let hosts: CompanionHost[];
				try {
					hosts = (await loadSessions()).hosts;
				} catch {
					continue;
				}
				for (const host of hosts) {
					if (before.has(host.instanceId)) continue;
					// Another agent's host (or an omp) that came up in the same folder meanwhile is not this start's.
					if (plan ? host.agent?.id !== plan.agent.id : host.agent !== undefined) continue;
					const hostCwd = await fs.realpath(host.cwd).catch(() => host.cwd);
					const resumed =
						resume !== undefined && (plan ? host.sessionId === resume : host.sessionId.startsWith(resume));
					if (resumed || (hostCwd === launched.cwd && host.startedAt >= spawnedAt - 1_000)) {
						// Where this session works is how its settle finds its worktree later; never from a session file.
						await settleCleanup
							.recordSession(host.sessionId, launched.cwd)
							.catch(err =>
								console.error(`companion: remembering session ${host.sessionId} failed: ${errorText(err)}`),
							);
						await refresh();
						await releaseLaunch(tmux, launched.name);
						return host.instanceId;
					}
				}
				// The process ended (a missing adapter, a bad sign-in, a flag omp refused): no point waiting on, and its last output says why.
				const ended = await launchEnded(tmux, launched.name);
				if (ended !== null) {
					await killTmuxSession(tmux, launched.name);
					const name = plan ? plan.agent.name : "omp";
					throw new Error(
						launchFailure(
							plan
								? `${name} stopped before it was ready (check that it is installed and signed in on the computer)`
								: `${name} stopped before it was ready`,
							ended.tail,
						),
					);
				}
			}
			const screen = await launchScreen(tmux, launched.name);
			await killTmuxSession(tmux, launched.name);
			throw new Error(launchFailure(`${plan ? plan.agent.name : "omp"} did not start hosting in time`, screen));
		});
	} catch (err) {
		// The branch and worktree only exist for this session.
		if (created) await discardWorktree(created);
		throw err;
	}
}

/**
 * The `start` request: `scratch` starts a new session without a project in a fresh folder under the config dir
 * (see ./companion-scratch); a start that fails leaves no empty folder behind, and no start ever deletes one that holds files.
 */
async function startFromRequest(frame: Extract<CompanionRequest, { t: "start" }>): Promise<string> {
	const prompt = parseStartPrompt(frame.prompt);
	const foreign: ForeignStart = { agent: frame.agent, model: frame.model, permission: frame.permission };
	if (frame.scratch === undefined)
		return await startSession(
			frame.cwd,
			frame.resume,
			frame.sandboxed,
			frame.worktree,
			frame.force,
			prompt,
			undefined,
			undefined,
			foreign,
		);
	if (
		typeof frame.scratch !== "object" ||
		frame.scratch === null ||
		(frame.scratch.hint !== undefined && typeof frame.scratch.hint !== "string")
	) {
		throw new Error("invalid request");
	}
	if (frame.resume !== undefined || frame.worktree !== undefined)
		throw new Error("a session without a project is new and has no worktree");
	if (frame.sandboxed === true && frame.agent === undefined && !sandboxAvailable)
		throw new Error("sandboxed sessions need macOS sandbox-exec");
	const folder = await createScratchFolder({ configDir, hint: frame.scratch.hint });
	try {
		return await startSession(
			folder,
			undefined,
			frame.sandboxed,
			undefined,
			undefined,
			prompt,
			undefined,
			undefined,
			foreign,
		);
	} catch (err) {
		await fs.rmdir(folder).catch(() => undefined);
		throw err;
	}
}

/** Spend in USD of every session that worked in each folder, from the stats database. */
async function folderCosts(): Promise<Map<string, number>> {
	const costs = new Map<string, number>();
	for (const session of await allOverviews({ limit: 200 }))
		costs.set(session.folder, (costs.get(session.folder) ?? 0) + session.cost);
	return costs;
}

/** The tmux session (named `omp-<id>`) of an omp the companion started; null for any other omp, and without tmux. */
async function companionTmuxSession(instanceId: string): Promise<{ tmux: string; name: string } | null> {
	const pid = knownPids.get(instanceId);
	const tmux = await findTmux();
	const name = pid === undefined ? null : await paneSessionName(pid);
	return tmux === null || name === null || !/^omp-[0-9a-f]{8}$/.test(name) ? null : { tmux, name };
}

/** End a session the companion started: its tmux session is killed. */
async function stopSession(instanceId: string): Promise<void> {
	const target = await companionTmuxSession(instanceId);
	if (target === null) throw new Error("only sessions the companion started can be ended from here");
	await killTmuxSession(target.tmux, target.name);
}

/** Architecture maps: stored under the config folder, the agent part run as a read-only session the companion starts. */
const blueprints = createBlueprints({
	storeDir: path.join(configDir, "agent", "blueprints"),
	cacheDir: path.join(configDir, "cache", "blueprints"),
	now: Date.now,
	changed: id => {
		for (const peer of peers) room.send({ t: "blueprint-changed", id }, peer, zipPeers.has(peer));
	},
	openIndex: openThrowawayIndex,
	agent: {
		start: launch =>
			startSession(
				launch.cwd,
				undefined,
				sandboxAvailable,
				undefined,
				undefined,
				launch.prompt,
				launch.maxCostUsd,
				launch.model,
				undefined,
				{ overlayPath: launch.overlayPath, overlayYaml: launch.overlayYaml, tools: launch.tools },
			),
		hosts: async () =>
			(await loadSessions()).hosts.map(host => ({
				instanceId: host.instanceId,
				sessionId: host.sessionId,
				model: host.model,
				busy: host.busy,
			})),
		stop: async instanceId => {
			// A fresh list: the pid of a session started moments ago may not be known yet.
			await loadSessions();
			await stopSession(instanceId);
		},
		cost: async sessionId =>
			(await allOverviews({ limit: 100 })).find(session => session.sessionId === sessionId)?.cost,
	},
	log: message => console.log(`companion: ${message}`),
});

function fanoutGroup(id: unknown): FanoutGroup {
	const group = typeof id === "string" ? fanoutGroups.find(g => g.id === id) : undefined;
	if (!group) throw new Error("unknown group");
	return group;
}

async function fanoutStart(input: unknown): Promise<FanoutGroup> {
	const request = parseFanoutRequest(input);
	if (!(await findTmux())) throw new Error("tmux is not installed on this computer");
	// Other agents run unsandboxed for now: refuse before any member starts rather than run some of them unconfined.
	if (request.sandboxed && request.models.some(model => parseForeignSelector(model) !== null))
		throw new Error("Other agents cannot run sandboxed yet: untick Sandboxed or pick omp models only.");
	if (request.sandboxed && !sandboxAvailable) throw new Error("sandboxed sessions need macOS sandbox-exec");
	// Vendor agents' names go into the group as the run records its agent.
	if (request.models.some(model => parseForeignSelector(model) !== null))
		rememberAgents(await listAgents({ configDir }));
	const group = await startFanout(request, {
		worktreesDir: effectiveWorktreesDir(gitFlow.settings, worktreesDir),
		branchPrefix: gitFlow.settings.branchPrefix,
		// The setup runs per tree, as for a new worktree session.
		setup: tree => setupWorktree(tree, request.sandboxed),
		agentRef: model => {
			const parsed = parseForeignSelector(model);
			return parsed ? agentDirectory.ref(parsed.agent) : undefined;
		},
		launch: ({ cwd, prompt, model, maxCostUsd, sandboxed, group: groupId }) => {
			const parsed = parseForeignSelector(model);
			if (!parsed) return startSession(cwd, undefined, sandboxed, undefined, undefined, prompt, maxCostUsd, model);
			return startSession(cwd, undefined, sandboxed, undefined, undefined, prompt, maxCostUsd, undefined, {
				agent: parsed.agent,
				model: parsed.model === "" ? undefined : parsed.model,
				fanout: { group: groupId, selector: model },
			});
		},
	});
	fanoutGroups = withGroup(fanoutGroups, group);
	await saveGroups(fanoutPath, fanoutGroups);
	// The sessions were listed while they booted, before the group existed: tell the devices which belong to it.
	await refresh();
	return group;
}

async function fanoutCompare(id: unknown): Promise<FanoutCompare> {
	const group = fanoutGroup(id);
	await loadSessions();
	const [costs, canPr] = await Promise.all([folderCosts().catch(() => new Map<string, number>()), canCreatePr()]);
	return compareGroup(group, {
		hosts: () => knownHosts,
		cost: folder => costs.get(folder) ?? null,
		review: folder => gitReview(folder, canPr),
		runs: instanceId => runs.list(instanceId),
	});
}

async function fanoutKeep(input: unknown): Promise<FanoutKeepResult> {
	const request = parseKeepRequest(input);
	const group = fanoutGroup(request.group);
	const result = await keepRun(group, request, {
		worktreesDir: worktreeLocations(gitFlow, worktreesDir),
		hosts: async () => (await loadSessions()).hosts,
		runningCwds: async () => {
			const listed = await loadSessions();
			return [...listed.hosts, ...listed.idle].map(session => session.cwd);
		},
		dirty: async folder => {
			if (
				!(await fs.stat(folder).then(
					s => s.isDirectory(),
					() => false,
				))
			)
				return null;
			const status = await git(folder, ["status", "--porcelain=v1", "-uall"]);
			if (status.code !== 0) throw new Error("could not read the worktree's state");
			return status.out.byteLength > 0;
		},
		stop: stopSession,
	});
	await saveGroups(fanoutPath, fanoutGroups);
	await refresh();
	return result;
}

/** Poll while a device is connected (fast) or one wants push notifications (slower). */
function schedulePoll(): void {
	if (pollTimer !== undefined) return;
	if (peers.size === 0 && registry.subscriptions().length === 0) {
		// Unwatched gaps must not read as edges once watching resumes.
		seen = null;
		lastPower = null;
		return;
	}
	pollTimer = setTimeout(
		async () => {
			await refresh();
			pollTimer = undefined;
			schedulePoll();
		},
		peers.size > 0 ? POLL_MS : PUSH_POLL_MS,
	);
}

/** Devices re-register on every launch; only a new subscription gets the confirmation notice. */
async function setSubscription(deviceId: string, subscription: unknown, on: boolean): Promise<void> {
	if (!isPushSubscription(subscription)) throw new Error("invalid push subscription");
	const added = await registry.setSubscription(deviceId, subscription, on);
	if (added) push(subscription, { title: machine, body: "Notifications are on for this computer." });
	schedulePoll();
}

room.onOpen = route => {
	recordRelayEvent("open", `room open (${route} relay)`);
	console.log(`companion: room open on the ${route} relay, waiting for devices`);
};

/** Stop serving a peer: it must authenticate again. */
function dropPeer(peer: number): void {
	peers.delete(peer);
	peerDevice.delete(peer);
	zipPeers.delete(peer);
	presence.delete(peer);
}

room.onControl = msg => {
	if (msg.t !== "peer-left") return;
	const deviceId = peerDevice.get(msg.peer);
	dropPeer(msg.peer);
	// Last seen is kept in memory while a device is connected and written when it leaves.
	if (deviceId !== undefined) {
		saveState(state).catch(err => console.error(`companion: saving state failed: ${errorText(err)}`));
	}
};

type AuthFrame = Extract<CompanionRequest, { t: "auth" }>;

/** `<device id>:<route>` of every device already logged as connected since the companion started, so a reconnect is not logged again. */
const announced = new Set<string>();

/**
 * Serve the peer as a paired device when it presents its credentials, or pairs with a valid
 * invite (which issues it credentials); otherwise tell it it is refused. Holding the room
 * link only gets a device into the room.
 */
async function authenticate(frame: AuthFrame, fromPeer: number): Promise<void> {
	try {
		let device = registry.authenticate(frame.device);
		let token: string | undefined;
		let refusal = "This device is not paired. Scan a pairing code from the computer.";
		if (device === null && frame.device !== undefined && frame.invite === undefined) {
			refusal = "This device was removed.";
		} else if (device === null && frame.invite !== undefined) {
			if (await consumeInvite(invitesDir, frame.invite, Date.now())) {
				({ device, token } = await registry.enroll(frame.name));
				console.log(`companion: paired ${device.name}`);
			} else {
				refusal = "That pairing code expired or was already used. Show a new one from the Devices screen.";
			}
		}
		if (device === null) {
			room.send({ t: "auth-failed", message: refusal }, fromPeer);
			return;
		}
		peers.add(fromPeer);
		peerDevice.set(fromPeer, device.id);
		const route = RoomHost.routeOf(fromPeer);
		if (!announced.has(`${device.id}:${route}`)) {
			announced.add(`${device.id}:${route}`);
			console.log(`companion: ${device.name} connected through the ${route} relay`);
		}
		registry.touch(device.id);
		if (token === undefined) await saveState(state);
		room.send({ t: "authed", deviceId: device.id, token }, fromPeer);
		schedulePoll();
	} catch (err) {
		console.error(`companion: authenticating a device failed: ${errorText(err)}`);
		room.send({ t: "auth-failed", message: "The computer could not check this device. Try again." }, fromPeer);
	}
}

/** Unpair a device: gone with its push subscription, and every connection it holds is cut off. */
async function revokeDevice(deviceId: unknown): Promise<void> {
	if (typeof deviceId !== "string") throw new Error("invalid device");
	const removed = await registry.revoke(deviceId);
	if (!removed) throw new Error("no such device");
	console.log(`companion: removed ${removed.name}`);
	for (const [peer, id] of peerDevice) {
		if (id !== removed.id) continue;
		dropPeer(peer);
		room.send({ t: "auth-failed", message: "This device was removed." }, peer);
	}
}

room.onFrame = (frame, fromPeer) => {
	if (frame.t === "auth") {
		void authenticate(frame, fromPeer);
		return;
	}
	// Whoever holds the room link can send frames; only authenticated devices are served.
	const deviceId = peerDevice.get(fromPeer);
	if (deviceId === undefined) return;
	registry.touch(deviceId);
	schedulePoll();
	if ("reqId" in frame && typeof frame.reqId !== "number") return;
	/** Answer a request with whatever `work` resolves to, or with its error. */
	const respond = (reqId: number, work: () => Promise<CompanionReply>): void => {
		work().then(
			reply => room.send(reply, fromPeer, zipPeers.has(fromPeer)),
			err => {
				recordRequestError(frame.t, errorText(err));
				console.error(`companion: ${new Date().toISOString()} ${frame.t} failed: ${errorText(err)}`);
				const openElsewhere = err instanceof SessionOpenElsewhereError ? err.holders : undefined;
				const changed = err instanceof FileChangedError ? err.version : undefined;
				room.send({ t: "error", reqId, message: errorText(err), openElsewhere, changed }, fromPeer);
			},
		);
	};
	switch (frame.t) {
		case "list":
			if (frame.zip === true) zipPeers.add(fromPeer);
			else zipPeers.delete(fromPeer);
			void refresh(fromPeer);
			return;
		case "link":
			respond(frame.reqId, async () => {
				return { t: "link", reqId: frame.reqId, url: await lister.link(checkInstanceId(frame.instanceId)) };
			});
			return;
		case "push":
			respond(frame.reqId, async () => {
				await setSubscription(deviceId, frame.subscription, frame.on === true);
				return { t: "ok", reqId: frame.reqId };
			});
			return;
		case "presence":
			presence.set(fromPeer, { endpoint: frame.endpoint, visible: frame.visible });
			return;
		case "git":
			respond(frame.reqId, async () => ({
				t: "git",
				reqId: frame.reqId,
				git: await gitSnapshot(await sessionCwd(frame.instanceId)),
			}));
			return;
		case "git-diff":
			respond(frame.reqId, async () => {
				if (typeof frame.path !== "string") throw new Error("invalid path");
				const { diff, truncated } = await gitDiff(await sessionCwd(frame.instanceId), frame.path);
				return { t: "diff", reqId: frame.reqId, diff, truncated };
			});
			return;
		case "file":
			respond(frame.reqId, async () => {
				if (typeof frame.path !== "string") throw new Error("invalid path");
				const session = await listedSession(frame.instanceId);
				return {
					t: "file",
					reqId: frame.reqId,
					file: await readRepoFile(session.cwd, frame.path, session.sandboxed === true),
				};
			});
			return;
		case "tree":
			respond(frame.reqId, async () => ({
				t: "tree",
				reqId: frame.reqId,
				tree: await listTree(await sessionCwd(frame.instanceId)),
			}));
			return;
		case "file-write":
			respond(frame.reqId, async () => {
				if (typeof frame.path !== "string" || typeof frame.text !== "string" || typeof frame.base !== "string")
					throw new Error("invalid file-write");
				const session = await listedSession(frame.instanceId);
				const version = await writeRepoFile(
					session.cwd,
					frame.path,
					frame.text,
					frame.base,
					session.sandboxed === true,
				);
				return { t: "file-saved", reqId: frame.reqId, version };
			});
			return;
		case "file-download":
			respond(frame.reqId, async () => {
				if (typeof frame.path !== "string") throw new Error("invalid path");
				const session = await listedSession(frame.instanceId);
				return {
					t: "file-chunk",
					reqId: frame.reqId,
					...(await readFileChunk(session.cwd, frame.path, frame.offset)),
				};
			});
			return;
		case "file-versions":
			respond(frame.reqId, async () => ({
				t: "file-versions",
				reqId: frame.reqId,
				versions: await fileVersions(await sessionCwd(frame.instanceId), frame.paths),
			}));
			return;
		case "folders":
			respond(frame.reqId, async () => ({
				t: "folders",
				reqId: frame.reqId,
				folders: await recentFoldersAll(),
			}));
			return;
		case "schedules":
			respond(frame.reqId, async () => ({ t: "schedules", reqId: frame.reqId, schedules: scheduler.list() }));
			return;
		case "schedule-save":
			respond(frame.reqId, async () => {
				const input = await parseScheduleInput(frame.schedule, {
					now: Date.now,
					sandboxAvailable,
					checkDirectory,
				});
				return { t: "schedule", reqId: frame.reqId, schedule: await scheduler.save(input) };
			});
			return;
		case "schedule-delete":
			respond(frame.reqId, async () => {
				if (typeof frame.id !== "string") throw new Error("invalid schedule id");
				await scheduler.remove(frame.id);
				return { t: "ok", reqId: frame.reqId };
			});
			return;
		case "schedule-run-now":
			respond(frame.reqId, async () => {
				if (typeof frame.id !== "string") throw new Error("invalid schedule id");
				return { t: "schedule", reqId: frame.reqId, schedule: await scheduler.runNow(frame.id) };
			});
			return;
		case "start":
			respond(frame.reqId, async () => ({
				t: "started",
				reqId: frame.reqId,
				instanceId: await startFromRequest(frame),
			}));
			return;
		case "agents":
			respond(frame.reqId, async () => ({
				t: "agents",
				reqId: frame.reqId,
				agents: await agentHandlers.list(frame.refresh),
			}));
			return;
		case "agent-install":
			respond(frame.reqId, async () => ({
				t: "agents",
				reqId: frame.reqId,
				agents: await agentHandlers.install(frame.id),
			}));
			return;
		case "agent-custom-save":
			respond(frame.reqId, async () => ({
				t: "agents",
				reqId: frame.reqId,
				agents: await agentHandlers.saveCustom(frame.agent),
			}));
			return;
		case "agent-custom-delete":
			respond(frame.reqId, async () => ({
				t: "agents",
				reqId: frame.reqId,
				agents: await agentHandlers.deleteCustom(frame.id),
			}));
			return;
		case "share":
			respond(frame.reqId, async () => {
				return { t: "link", reqId: frame.reqId, url: await lister.share(checkInstanceId(frame.instanceId)) };
			});
			return;
		case "inbox":
			respond(frame.reqId, async () => {
				// A fresh list: a session may have asked or finished since the last poll.
				const { hosts } = await loadSessions();
				const items = await buildInbox(hosts, id => readSessionTail(sessionsDir, id), Date.now());
				return { t: "inbox", reqId: frame.reqId, items };
			});
			return;
		case "spend-limits":
			respond(frame.reqId, async () => {
				if (frame.limits !== undefined) {
					state.spend = withLimits(state.spend, parseSpendLimits(frame.limits), Date.now());
					await saveState(state);
					void spendMonitor.tick(true);
				}
				return {
					t: "spend-limits",
					reqId: frame.reqId,
					limits: state.spend?.limits ?? { dailyUsd: null, sessionUsd: null },
				};
			});
			return;
		case "pr-alerts":
			respond(frame.reqId, async () => {
				if (frame.settings !== undefined) {
					const settings = parsePrAlertSettings(frame.settings);
					// Turned off entirely: what was seen goes stale, so a later enable starts from a fresh sighting.
					prAlertState = { settings, prs: settings.checks || settings.reviews ? prAlertState.prs : {} };
					await savePrWatchFile(prWatchPath, prAlertState);
					void prWatch.tick(true);
				}
				return { t: "pr-alerts", reqId: frame.reqId, settings: prAlertState.settings };
			});
			return;
		case "git-message":
			respond(frame.reqId, async () => {
				if (typeof frame.commit !== "boolean" || typeof frame.pr !== "boolean") throw new Error("invalid request");
				const session = await listedSession(frame.instanceId);
				const text = await generateGitText({
					cwd: session.cwd,
					want: { commit: frame.commit, pr: frame.pr },
					session: {
						title: session.sessionName,
						summary: lastAssistantSummary(await readSessionTail(sessionsDir, session.sessionId)),
					},
					ompBin,
					model: gitFlow.settings.messageModel,
				});
				return { t: "git-message", reqId: frame.reqId, text };
			});
			return;
		case "git-settings":
			respond(frame.reqId, async () => {
				if (frame.settings !== undefined) {
					// An app that predates the settle command sends no `settleScript`: it keeps what is set.
					const next = {
						...frame.settings,
						settleScript: frame.settings.settleScript ?? gitFlow.settings.settleScript,
					};
					gitFlow = replaceSettings(gitFlow, parseGitFlowSettings(next, true), worktreesDir);
					await saveGitFlowFile(gitFlowPath, gitFlow);
				}
				if (frame.trust !== undefined) {
					gitFlow = await applySetupTrust(
						gitFlow,
						frame.trust.kind === "settle" ? unapprovedSettles : unapprovedSetups,
						frame.trust,
					);
					await saveGitFlowFile(gitFlowPath, gitFlow);
				}
				const swept = frame.sweep === true ? await worktreeSweeper.tick(true) : null;
				return {
					t: "git-settings",
					reqId: frame.reqId,
					settings: gitFlow.settings,
					worktreesDir: effectiveWorktreesDir(gitFlow.settings, worktreesDir),
					swept: swept?.removed.map(removed => removed.path),
					projects: await projectSetupStatuses(gitFlow, unapprovedSetups),
					settleCleanup: {
						projects: await projectSettleStatuses(gitFlow, unapprovedSettles),
						results: await settleCleanup.results(),
					},
				};
			});
			return;
		case "usage":
			respond(frame.reqId, async () => {
				if (!isUsageRange(frame.range)) throw new Error("unknown usage range");
				const range = frame.range;
				const now = Date.now();
				const report = await usageReport(range);
				const events = await foreignOr("usage", () => foreignCatalog.usageSince(usageRangeStart(range, now)), []);
				return { t: "usage", reqId: frame.reqId, usage: mergeForeignUsage(report, events, agentDirectory.ref) };
			});
			return;
		case "session-org":
			respond(frame.reqId, async () => {
				const { doc, rev } = await sessionOrg.sync(parseOrg(frame.doc));
				return { t: "session-org", reqId: frame.reqId, doc, rev };
			});
			return;
		case "session-search":
			respond(frame.reqId, async () => {
				const { results, truncated } = await sessionSearch.search(frame.query, frame.limit);
				return {
					t: "session-search",
					reqId: frame.reqId,
					results: withLiveness(await withAgents(results, foreignCatalog), { hosts: knownHosts, idle: knownIdle }),
					truncated,
				};
			});
			return;
		case "sessions":
			respond(frame.reqId, async () => {
				const sessions = await allOverviews(frame);
				// Only worktrees that still exist can be removed.
				return {
					t: "sessions",
					reqId: frame.reqId,
					sessions: await Promise.all(
						sessions.map(async session => {
							const inside = worktreeLocations(gitFlow, worktreesDir).some(
								dir => session.folder !== dir && isInside(dir, session.folder),
							);
							const exists =
								inside &&
								(await fs.stat(session.folder).then(
									s => s.isDirectory(),
									() => false,
								));
							return exists ? { ...session, worktree: true } : session;
						}),
					),
				};
			});
			return;
		case "pane":
			respond(frame.reqId, async () => {
				const id = checkInstanceId(frame.instanceId);
				// Resolves the session against a fresh list when it is not known yet, which also refreshes its pid.
				await sessionCwd(id);
				const pid = knownPids.get(id);
				if (pid === undefined) throw new Error("unknown session");
				return { t: "pane", reqId: frame.reqId, pane: await capturePane(pid) };
			});
			return;
		case "file-sessions":
			respond(frame.reqId, async () => {
				const found = await findFileSessions({
					sessionsDir,
					cwd: await sessionCwd(frame.instanceId),
					path: frame.path,
				});
				return {
					t: "sessions",
					reqId: frame.reqId,
					sessions: await mergeFileSessions(
						found,
						foreignCatalog,
						{ hosts: knownHosts },
						async omp => await fileSessionOverviews(omp, { hosts: knownHosts, idle: knownIdle }),
					),
				};
			});
			return;
		case "git-review":
			respond(frame.reqId, async () => ({
				t: "review",
				reqId: frame.reqId,
				review: await gitReview(await sessionCwd(frame.instanceId), await canCreatePr()),
			}));
			return;
		case "git-review-diff":
			respond(frame.reqId, async () => {
				if (typeof frame.path !== "string") throw new Error("invalid path");
				const { diff, truncated } = await reviewDiff(await sessionCwd(frame.instanceId), frame.path);
				return { t: "diff", reqId: frame.reqId, diff, truncated };
			});
			return;
		case "git-commit":
			respond(frame.reqId, async () => {
				if (typeof frame.message !== "string") throw new Error("invalid commit message");
				await gitCommit(await idleSessionCwd(frame.instanceId), frame.message);
				return { t: "ok", reqId: frame.reqId };
			});
			return;
		case "git-push":
			respond(frame.reqId, async () => {
				await gitPush(await idleSessionCwd(frame.instanceId));
				return { t: "ok", reqId: frame.reqId };
			});
			return;
		case "pr-create":
			respond(frame.reqId, async () => {
				if (typeof frame.title !== "string" || typeof frame.body !== "string")
					throw new Error("invalid pull request");
				if (frame.draft !== undefined && typeof frame.draft !== "boolean") throw new Error("invalid pull request");
				if (!(await canCreatePr())) throw new Error("gh is not installed or not signed in on this computer");
				const url = await createPullRequest(await idleSessionCwd(frame.instanceId), {
					title: frame.title,
					body: frame.body,
					draft: frame.draft === true,
				});
				return { t: "link", reqId: frame.reqId, url };
			});
			return;
		case "codemap":
			respond(frame.reqId, async () => {
				const cwd = await sessionCwd(frame.instanceId);
				return {
					t: "codemap",
					reqId: frame.reqId,
					view: await codemapView(
						cwd,
						checkFocus(await repoRelativeFocus(cwd, frame.focus)),
						checkFlow(frame.flow),
					),
				};
			});
			return;
		case "codemap-search":
			respond(frame.reqId, async () => ({
				t: "codemap-search",
				reqId: frame.reqId,
				hits: await codemapSearch(await sessionCwd(frame.instanceId), checkSearch(frame.q)),
			}));
			return;
		case "blueprint-list":
			respond(frame.reqId, async () => {
				if (frame.cwd !== undefined && typeof frame.cwd !== "string") throw new Error("invalid folder");
				return { t: "blueprint-list", reqId: frame.reqId, maps: await blueprints.list(frame.cwd) };
			});
			return;
		case "blueprint-create":
			respond(frame.reqId, async () => {
				const { t: _t, reqId: _reqId, ...request } = frame;
				return { t: "blueprint-create", reqId: frame.reqId, ...(await blueprints.create(request)) };
			});
			return;
		case "blueprint-get":
			respond(frame.reqId, async () => ({
				t: "blueprint-get",
				reqId: frame.reqId,
				map: await blueprints.get(frame.id),
			}));
			return;
		case "blueprint-excerpt":
			respond(frame.reqId, async () => {
				if (!Array.isArray(frame.refs)) throw new Error("invalid references");
				return {
					t: "blueprint-excerpt",
					reqId: frame.reqId,
					excerpts: await blueprints.excerpt(frame.id, frame.refs),
				};
			});
			return;
		case "blueprint-delete":
			respond(frame.reqId, async () => {
				await blueprints.remove(frame.id);
				return { t: "blueprint-delete", reqId: frame.reqId };
			});
			return;
		case "blueprint-refs":
			respond(frame.reqId, async () => {
				if (typeof frame.cwd !== "string" || (frame.q !== undefined && typeof frame.q !== "string"))
					throw new Error("invalid request");
				return { t: "blueprint-refs", reqId: frame.reqId, ...(await blueprints.refs(frame.cwd, frame.q)) };
			});
			return;
		case "preview":
			respond(frame.reqId, async () => {
				if (previewChrome === null) throw new Error("No Chrome or other Chromium browser found on this computer");
				if (!isViewport(frame.viewport)) throw new Error("invalid viewport");
				if (frame.fullPage !== undefined && typeof frame.fullPage !== "boolean") throw new Error("invalid request");
				await sessionCwd(frame.instanceId);
				return {
					t: "preview",
					reqId: frame.reqId,
					shot: await capturePreview(previewChrome, frame.url, frame.viewport, frame.fullPage === true),
				};
			});
			return;
		case "run-targets":
			respond(frame.reqId, async () => {
				const { root } = await runRoot(frame.instanceId);
				return { t: "run-targets", reqId: frame.reqId, targets: await runs.targets(root) };
			});
			return;
		case "run-start":
			respond(frame.reqId, async () => {
				const { instanceId, root } = await runRoot(frame.instanceId);
				const run = await runs.start(instanceId, root, frame.target, frame.detail);
				console.log(`companion: ${new Date().toISOString()} running ${run.command} for ${instanceId}`);
				return { t: "run", reqId: frame.reqId, run };
			});
			return;
		case "run-output":
			respond(frame.reqId, async () => ({
				t: "run-output",
				reqId: frame.reqId,
				output: runs.output(frame.runId, frame.from),
			}));
			return;
		case "run-stop":
			respond(frame.reqId, async () => ({ t: "run", reqId: frame.reqId, run: runs.stop(frame.runId) }));
			return;
		case "runs":
			respond(frame.reqId, async () => ({
				t: "runs",
				reqId: frame.reqId,
				runs: runs.list(checkInstanceId(frame.instanceId)),
			}));
			return;
		case "upload":
			respond(frame.reqId, async () => {
				// Only a session this computer knows may receive files.
				await sessionCwd(frame.instanceId);
				return { t: "uploaded", reqId: frame.reqId, path: await storeUpload(frame.name, frame.data) };
			});
			return;
		case "transcribe":
			respond(frame.reqId, async () => ({
				t: "transcribe",
				reqId: frame.reqId,
				text: await voice.transcribe(frame.audio, frame.mimeType),
			}));
			return;
		case "transcribe-setup":
			respond(frame.reqId, async () => {
				await voice.setup();
				// Devices see `ready` once the model is downloaded.
				void refresh();
				return { t: "transcribe-setup", reqId: frame.reqId };
			});
			return;
		case "preview-targets":
			respond(frame.reqId, async () => ({
				t: "preview-targets",
				reqId: frame.reqId,
				targets: await previewTargets(
					await sessionCwd(frame.instanceId),
					// The companion and the omp processes are never dev servers.
					new Set([process.pid, ...knownPids.values()]),
				),
			}));
			return;
		case "github":
			respond(frame.reqId, async () => {
				const { repo, items } = await githubList(await sessionCwd(frame.instanceId), frame.kind, frame.filter);
				return { t: "github", reqId: frame.reqId, repo, items };
			});
			return;
		case "github-item":
			respond(frame.reqId, async () => ({
				t: "github-item",
				reqId: frame.reqId,
				item: await githubItem(await sessionCwd(frame.instanceId), frame.kind, frame.number),
			}));
			return;
		case "pr-files":
			respond(frame.reqId, async () => {
				const { head, files } = await prReview.files(await sessionCwd(frame.instanceId), frame.number);
				return { t: "pr-files", reqId: frame.reqId, head, files };
			});
			return;
		case "pr-diff":
			respond(frame.reqId, async () => {
				const { diff, truncated } = await prReview.diff(
					await sessionCwd(frame.instanceId),
					frame.number,
					frame.head,
					frame.path,
				);
				return { t: "diff", reqId: frame.reqId, diff, truncated };
			});
			return;
		case "pr-review":
			respond(frame.reqId, async () => ({
				t: "link",
				reqId: frame.reqId,
				url: await prReview.review(await reviewWriteCwd(frame.instanceId), frame.number, frame.review),
			}));
			return;
		case "pr-merge":
			respond(frame.reqId, async () => {
				await prReview.merge(await reviewWriteCwd(frame.instanceId), frame.number, {
					method: frame.method,
					deleteBranch: frame.deleteBranch,
					head: frame.head,
					allowDraft: frame.allowDraft,
					allowFailing: frame.allowFailing,
					allowPending: frame.allowPending,
				});
				return { t: "ok", reqId: frame.reqId };
			});
			return;
		case "ci-log":
			respond(frame.reqId, async () => {
				const repo = checkRepo(frame.repo);
				const number = checkNumber(frame.number);
				// A fresh list: the sessions offered must be running now.
				const [{ pr, failures, moreFailures }, { hosts, idle }] = await Promise.all([
					ciFailures(repo, number),
					loadSessions(),
				]);
				const [sessions, folders] = await Promise.all([
					repoSessions(repo, pr.branch, hosts, idle),
					repoFolders(
						repo,
						await recentFolders(sessionsDir),
						[...hosts, ...idle].map(session => session.cwd),
					),
				]);
				return { t: "ci-log", reqId: frame.reqId, pr, failures, moreFailures, sessions, folders };
			});
			return;
		case "worktree-remove":
			respond(frame.reqId, async () => {
				if (typeof frame.path !== "string") throw new Error("invalid worktree path");
				// A fresh list: never remove a checkout a running omp (hosting or not) works in.
				await loadSessions();
				await removeWorktree(
					frame.path,
					worktreeLocations(gitFlow, worktreesDir),
					[...knownHosts, ...knownIdle].map(session => session.cwd),
				);
				return { t: "ok", reqId: frame.reqId };
			});
			return;
		case "fanout-models":
			respond(frame.reqId, async () => {
				const omp = await fanoutModels();
				const agents = (await foreignReady())
					? await foreignOr("the model list", async () => rememberAgents(await listAgents({ configDir })), [])
					: [];
				return { t: "fanout-models", reqId: frame.reqId, models: [...omp, ...foreignFanoutModels(agents)] };
			});
			return;
		case "fanout-start":
			respond(frame.reqId, async () => ({
				t: "fanout-started",
				reqId: frame.reqId,
				group: await fanoutStart(frame.request),
			}));
			return;
		case "fanout-compare":
			respond(frame.reqId, async () => ({
				t: "fanout-compare",
				reqId: frame.reqId,
				compare: await fanoutCompare(frame.group),
			}));
			return;
		case "fanout-keep":
			respond(frame.reqId, async () => ({
				t: "fanout-kept",
				reqId: frame.reqId,
				result: await fanoutKeep(frame.request),
			}));
			return;
		case "diag":
			respond(frame.reqId, async () => ({
				t: "diag",
				reqId: frame.reqId,
				diag: await collectDiag({
					ompBin,
					devices: peers.size,
					keepAwake: awake.held,
					power: await readPower(awake.held),
					listing: { method: lister.method(), lastMs: lister.lastMs() },
				}),
			}));
			return;
		case "ping":
			respond(frame.reqId, async () => ({ t: "ok", reqId: frame.reqId }));
			return;
		case "devices":
			respond(frame.reqId, async () => {
				const online = new Set(peerDevice.values());
				return {
					t: "devices",
					reqId: frame.reqId,
					devices: registry.records.map(d => ({
						id: d.id,
						name: d.name,
						pairedAt: d.pairedAt,
						lastSeen: online.has(d.id) ? Date.now() : d.lastSeen,
						online: online.has(d.id),
					})),
					self: deviceId,
				};
			});
			return;
		case "device-rename":
			respond(frame.reqId, async () => {
				if (typeof frame.deviceId !== "string") throw new Error("invalid device");
				await registry.rename(frame.deviceId, frame.name);
				return { t: "ok", reqId: frame.reqId };
			});
			return;
		case "device-revoke":
			respond(frame.reqId, async () => {
				await revokeDevice(frame.deviceId);
				return { t: "ok", reqId: frame.reqId };
			});
			return;
		case "invite":
			respond(frame.reqId, async () => {
				const issued = await issueInvite(invitesDir, Date.now());
				return {
					t: "invite",
					reqId: frame.reqId,
					url: formatPairingUrl(webUrl, roomLink, issued.invite),
					expiresAt: issued.expiresAt,
				};
			});
			return;
		case "maintain":
			respond(frame.reqId, async () => {
				if (frame.action === "restart-companion") {
					return { t: "maintain", reqId: frame.reqId, output: restartCompanion() };
				}
				if (frame.action !== "update-omp") throw new Error("unknown maintenance action");
				// A fresh list: a turn may have started since the last poll.
				const listed = await loadSessions();
				return {
					t: "maintain",
					reqId: frame.reqId,
					output: await updateOmp(ompBin, [...listed.hosts, ...listed.idle]),
				};
			});
			return;
	}
};

room.onClose = (route, reason, willReconnect) => {
	recordRelayEvent("close", `${route} relay: ${willReconnect ? `${reason}, reconnecting` : reason}`);
	// Only the guests that came through the relay that closed are gone.
	for (const peer of [...peers, ...peerDevice.keys()]) if (RoomHost.routeOf(peer) === route) dropPeer(peer);
	console.error(`companion: ${route} relay closed (${reason})${willReconnect ? ", reconnecting" : ""}`);
	if (!willReconnect) setTimeout(() => room.connect(route), RECONNECT_MS);
};

room.connect();
schedulePoll();
// Loading the codemap module is slow and may fail on a checkout without the native extractor: never block startup on it.
void loadCodemap().then(ready => {
	codemapReady = ready;
	// The hosts frame only goes out when its JSON changes; this is such a change.
	if (ready) void refresh();
});
void findChrome().then(found => {
	previewChrome = found;
	if (found !== null) void refresh();
});
// Maps a previous run left half done are marked interrupted, their checkouts removed, and their agent sessions ended.
void blueprints.init().catch(err => console.error(`companion: starting architecture maps failed: ${errorText(err)}`));

function shutdown(): void {
	// Runs are detached process groups: they would outlive the companion.
	runs.stopAll();
	clearTimeout(pollTimer);
	awake.release();
	room.close();

	// The warm preview browser and the speech worker are separate process trees: close them before exiting.
	void Promise.allSettled([
		closePreviewBrowser(),
		voice.close(),
		scheduleIpc.stop(),
		blueprints.shutdown(),
		removeLocalEndpoint(localEndpointFile(configDir), process.pid),
	]).then(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
