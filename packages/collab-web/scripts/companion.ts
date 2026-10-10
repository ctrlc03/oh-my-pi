/**
 * omp collab companion: keeps one encrypted relay room open on this computer
 * so the collab web app can list every omp session on it, read its git state,
 * start new sessions, and join any hosted session without fetching a new link.
 *
 *   bun scripts/companion.ts             # print the pairing link + QR, then serve
 *   bun scripts/companion.ts --rotate    # new room key: unpairs every device
 *   bun scripts/companion.ts --pair      # print a fresh one-time pairing link + QR and exit
 *   bun scripts/companion.ts --install   # macOS: run at login as a LaunchAgent
 *   bun scripts/companion.ts --install --dry-run   # print the LaunchAgent plist only
 *   bun scripts/companion.ts --uninstall # remove the LaunchAgent
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
 * session's control link, and can read files under each session's repository and
 * start omp in any folder. The app's Devices screen lists, renames and removes
 * devices and makes new invites; removing a device cuts it off at once.
 *
 * `--install` writes `~/Library/LaunchAgents/sh.omp.collab-companion.plist`
 * (RunAtLoad + KeepAlive, absolute bun/script/omp paths, log in
 * `~/Library/Logs/omp-collab-companion.log`) and loads it. Only one companion
 * may hold the room: stop a manually running one first, or the two fight over
 * it (relay close 4009). `--pair` shows the link while the agent runs.
 *
 * Sessions are listed in-process from the collab discovery registry (falling
 * back to `omp collab list --json` when that module cannot load), and links
 * come from the installed omp CLI (`omp collab link <id> --json`,
 * `omp collab start <id> --json`), so the companion works with whichever omp
 * version runs the sessions; features the registry lacks (listing and sharing
 * idle sessions) simply stay empty. Set OMP_BIN when `omp` is not on PATH
 * (launchd).
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
 * Staying reachable (macOS): the companion holds a sleep assertion while it
 * runs (`caffeinate -i -s`), so the Mac does not idle-sleep and sessions stay
 * online; closing the lid still sleeps it. The hosts frame carries the power
 * state, and subscribed devices are pushed when the Mac goes on battery, runs
 * low, and is plugged in again.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { QrCode, renderQrHalfBlocks } from "@oh-my-pi/pi-tui/chrome/qrcode";
import { generateRoomKey, importRoomKey } from "../src/lib/codec";
import {
	type CompanionHost,
	type CompanionIdleSession,
	type CompanionPower,
	type CompanionReply,
	type CompanionRequest,
	formatPairingUrl,
	LOW_BATTERY_PCT,
	type PushSubscriptionJson,
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
import { CollabSocket } from "../src/lib/socket";
import { checkFlow, checkFocus, checkSearch, codemapSearch, codemapView, loadCodemap } from "./companion-codemap";
import { collectDiag, recordRelayEvent, recordRequestError } from "./companion-diag";
import { findFileSessions, repoRelativeFocus } from "./companion-file-sessions";
import { gitDiff, gitSnapshot, isInside, readRepoFile } from "./companion-git";
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
import { buildInbox } from "./companion-inbox";
import { consumeInvite, type DeviceRecord, DeviceRegistry, issueInvite, parseDevices } from "./companion-devices";
import { installLaunchAgent, launchLogPath, uninstallLaunchAgent } from "./companion-launchd";
import {
	lastAssistantSummary,
	pendingQuestion,
	readSessionTail,
	recentFolders,
	SAFE_ID_RE,
} from "./companion-sessions";
import { createSessionLister } from "./companion-list";
import { restartCompanion, updateOmp } from "./companion-maintain";
import { capturePane } from "./companion-pane";
import { holdAwake, powerNotice, readPower } from "./companion-power";
import { capturePreview, closePreviewBrowser, findChrome, isViewport, previewTargets } from "./companion-preview";
import { createSpendMonitor, parseSpendLimits, parseSpendState, type SpendState, withLimits } from "./companion-spend";
import { canSandbox, findTmux, killTmuxSession, launchInTmux } from "./companion-start";
import { fileSessionOverviews, isUsageRange, readSpend, sessionOverview, usageReport } from "./companion-stats";
import { generateVapidKeys, isPushSubscription, sendPush, type VapidKeys } from "./web-push";

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
const overlayPath = path.join(configDir, "agent", "collab-companion-overlay.yml");
const sandboxOverlayPath = path.join(configDir, "agent", "collab-companion-sandbox.yml");
const ompBin = process.env.OMP_BIN || Bun.which("omp") || path.join(os.homedir(), ".bun", "bin", "omp");
/** How long `start` waits for the new omp to appear in `omp collab list`. */
const START_WAIT_MS = 45_000;
const START_POLL_MS = 1_000;

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

async function resolveLink(instanceId: string): Promise<string> {
	const parsed = JSON.parse(await omp(["collab", "link", instanceId, "--json"])) as { url?: unknown };
	if (typeof parsed.url !== "string" || !parsed.url) throw new Error("omp returned no link");
	return parsed.url;
}

/** Make an idle session host collab (`omp collab start`); resolves with its control link. */
async function shareSession(instanceId: string): Promise<string> {
	const parsed = JSON.parse(await omp(["collab", "start", instanceId, "--json"])) as { url?: unknown };
	if (typeof parsed.url !== "string" || !parsed.url) throw new Error("omp returned no link");
	return parsed.url;
}

// ── startup ──────────────────────────────────────────────────────────────────

const flags = Bun.argv.slice(2);
if (flags.includes("--uninstall")) {
	const existed = await uninstallLaunchAgent();
	console.log(existed ? "companion LaunchAgent removed" : "companion LaunchAgent was not installed");
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
const invite = await issueInvite(invitesDir, Date.now());
const pairUrl = formatPairingUrl(webUrl, roomLink, invite.invite);
const machine = os.hostname().replace(/\.local$/, "");
const sandboxAvailable = await canSandbox();
const worktreesDir = path.join(configDir, "worktrees");
/** VAPID `sub` claim: push services want a contact URL; Apple rejects non-https ones. */
const pushSubject = webUrl.startsWith("https://") ? new URL(webUrl).origin : "https://my.omp.sh";

console.log("omp collab companion");
console.log(`pair a device: scan the code or open ${pairUrl}`);
console.log(
	`the code works once and expires in ${Math.round((invite.expiresAt - Date.now()) / 60_000)} minutes; the app's Devices screen makes new ones`,
);
for (const row of renderQrHalfBlocks(QrCode.encodeText(pairUrl, "M"))) console.log(` ${row}`);
console.log(
	`paired devices stored in ${statePath}; remove one in the app's Devices screen, or --rotate to unpair every device`,
);

if (flags.includes("--install")) {
	const dryRun = flags.includes("--dry-run");
	const { plistPath, plist } = await installLaunchAgent({ ompBin, script: import.meta.path, dryRun });
	if (dryRun) {
		console.log(`dry run: would write ${plistPath}:\n${plist}`);
	} else {
		console.log(`LaunchAgent installed (${plistPath}); the companion now starts at login and restarts if it exits`);
		console.log(`log: ${launchLogPath()}`);
		console.log("stop any manually running companion: two of them fight over the room (relay close 4009)");
	}
	process.exit(0);
}
if (flags.includes("--pair")) process.exit(0);

// ── room ─────────────────────────────────────────────────────────────────────

const socket = new CollabSocket<CompanionReply, CompanionRequest>({
	wsUrl: (parseCollabLink(roomLink) as ParsedCollabLink).wsUrl,
	role: "host",
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
const awake = holdAwake();
if (process.platform === "darwin" && !awake.held) console.error("companion: could not hold the Mac awake (caffeinate)");

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function hostTitle(host: CompanionHost): string {
	return host.sessionName || path.basename(host.cwd) || "session";
}

function push(subscription: PushSubscriptionJson, payload: { title: string; body: string; instanceId?: string }): void {
	sendPush(subscription, payload, state.vapid, pushSubject, payload.instanceId).then(
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

/** Push to every subscribed device except those showing the app right now. */
function notify(host: CompanionHost, body: string): void {
	const showing = new Set<string>();
	for (const p of presence.values()) if (p.visible && p.endpoint) showing.add(p.endpoint);
	for (const subscription of registry.subscriptions()) {
		if (showing.has(subscription.endpoint)) continue;
		push(subscription, { title: hostTitle(host), body, instanceId: host.instanceId });
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
	read: (limits, now) => readSpend(limits, now, knownHosts),
	alert: alert => {
		for (const subscription of registry.subscriptions()) push(subscription, alert);
	},
	onError: err => console.error(`companion: spend check failed: ${errorText(err)}`),
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
	knownHosts = listed.hosts;
	knownIdle = listed.idle;
	knownPids = listed.pids;
	return listed;
}

/** Broadcast the host list when it changed; otherwise answer only `targetPeer`, if any. */
async function refresh(targetPeer?: number): Promise<void> {
	let listed: { hosts: CompanionHost[]; idle: CompanionIdleSession[] };
	try {
		listed = await loadSessions();
	} catch (err) {
		console.error(`companion: listing sessions failed: ${errorText(err)}`);
		return;
	}
	detectEdges(listed.hosts);
	void spendMonitor.tick();
	const power = await readPower(awake.held);
	detectPowerEdges(power);
	// Push-only polling: nobody to tell; a device's `list` on joining gets a fresh answer.
	if (peers.size === 0) return;
	const [canStart, canPr] = await Promise.all([findTmux().then(found => found !== null), canCreatePr()]);
	const frame: CompanionReply = {
		t: "hosts",
		machine,
		hosts: listed.hosts,
		vapidKey: state.vapid.publicKey,
		idle: listed.idle,
		canStart,
		canSandbox: canStart && sandboxAvailable,
		canPr,
		canCodemap: codemapReady,
		canPreview: previewChrome !== null,
		power: power ?? undefined,
	};
	const json = JSON.stringify(frame);
	if (json !== lastHostsJson) for (const peer of peers) socket.send(frame, peer, zipPeers.has(peer));
	else if (targetPeer !== undefined) socket.send(frame, targetPeer, zipPeers.has(targetPeer));
	lastHostsJson = json;
}

function checkInstanceId(value: unknown): string {
	if (typeof value !== "string" || !SAFE_ID_RE.test(value)) throw new Error("invalid instance id");
	return value;
}

/** Working directory of a listed session, refreshing the list once for an unknown instance. */
async function sessionCwd(instanceId: unknown): Promise<string> {
	const id = checkInstanceId(instanceId);
	const find = () => [...knownHosts, ...knownIdle].find(s => s.instanceId === id);
	let session = find();
	if (!session) {
		await loadSessions();
		session = find();
	}
	if (!session) throw new Error("unknown session");
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

/**
 * Start omp in a detached tmux session — sandboxed to `cwd` with file tools
 * only when `sandboxed` — and wait until it hosts collab; resolves with its instance id.
 */
async function startSession(
	cwd: unknown,
	resume: unknown,
	sandboxed: unknown,
	worktree: { branch?: unknown } | undefined,
): Promise<string> {
	if (
		typeof cwd !== "string" ||
		(resume !== undefined && typeof resume !== "string") ||
		(sandboxed !== undefined && typeof sandboxed !== "boolean") ||
		(worktree !== undefined && (typeof worktree !== "object" || worktree === null)) ||
		(worktree?.branch !== undefined && typeof worktree.branch !== "string")
	) {
		throw new Error("invalid request");
	}
	if (worktree !== undefined && resume !== undefined)
		throw new Error("a worktree needs a new session, not a resumed one");
	const tmux = await findTmux();
	if (!tmux) throw new Error("tmux is not installed on this computer");
	if (sandboxed && !sandboxAvailable) throw new Error("sandboxed sessions need macOS sandbox-exec");
	const sandbox = sandboxed
		? {
				home: os.homedir(),
				configDir,
				tmpDir: os.tmpdir(),
				companionState: statePath,
				overlayPath: sandboxOverlayPath,
			}
		: undefined;
	// The worktree checkout can take a while: the boot wait starts after it.
	const created = worktree ? await createWorktree(cwd, worktreesDir, worktree.branch) : null;
	try {
		const before = new Set((await loadSessions()).hosts.map(h => h.instanceId));
		const spawnedAt = Date.now();
		const launched = await launchInTmux({ tmux, ompBin, overlayPath, cwd: created?.path ?? cwd, resume, sandbox });
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
				const hostCwd = await fs.realpath(host.cwd).catch(() => host.cwd);
				const resumed = resume !== undefined && host.sessionId.startsWith(resume);
				if (resumed || (hostCwd === launched.cwd && host.startedAt >= spawnedAt - 1_000)) {
					await refresh();
					return host.instanceId;
				}
			}
		}
		await killTmuxSession(tmux, launched.name);
		throw new Error("omp did not start hosting in time");
	} catch (err) {
		// The branch and worktree only exist for this session.
		if (created) await discardWorktree(created);
		throw err;
	}
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

socket.onOpen = () => {
	recordRelayEvent("open", "room open");
	console.log("companion: room open, waiting for devices");
};

/** Stop serving a peer: it must authenticate again. */
function dropPeer(peer: number): void {
	peers.delete(peer);
	peerDevice.delete(peer);
	zipPeers.delete(peer);
	presence.delete(peer);
}

socket.onControl = msg => {
	if (msg.t !== "peer-left") return;
	const deviceId = peerDevice.get(msg.peer);
	dropPeer(msg.peer);
	// Last seen is kept in memory while a device is connected and written when it leaves.
	if (deviceId !== undefined) {
		saveState(state).catch(err => console.error(`companion: saving state failed: ${errorText(err)}`));
	}
};

type AuthFrame = Extract<CompanionRequest, { t: "auth" }>;

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
			socket.send({ t: "auth-failed", message: refusal }, fromPeer);
			return;
		}
		peers.add(fromPeer);
		peerDevice.set(fromPeer, device.id);
		registry.touch(device.id);
		if (token === undefined) await saveState(state);
		socket.send({ t: "authed", deviceId: device.id, token }, fromPeer);
		schedulePoll();
	} catch (err) {
		console.error(`companion: authenticating a device failed: ${errorText(err)}`);
		socket.send({ t: "auth-failed", message: "The computer could not check this device. Try again." }, fromPeer);
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
		socket.send({ t: "auth-failed", message: "This device was removed." }, peer);
	}
}

socket.onFrame = (frame, fromPeer) => {
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
			reply => socket.send(reply, fromPeer, zipPeers.has(fromPeer)),
			err => {
				recordRequestError(frame.t, errorText(err));
				socket.send({ t: "error", reqId, message: errorText(err) }, fromPeer);
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
				return { t: "link", reqId: frame.reqId, url: await resolveLink(checkInstanceId(frame.instanceId)) };
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
				return {
					t: "file",
					reqId: frame.reqId,
					file: await readRepoFile(await sessionCwd(frame.instanceId), frame.path),
				};
			});
			return;
		case "folders":
			respond(frame.reqId, async () => ({
				t: "folders",
				reqId: frame.reqId,
				folders: await recentFolders(sessionsDir),
			}));
			return;
		case "start":
			respond(frame.reqId, async () => ({
				t: "started",
				reqId: frame.reqId,
				instanceId: await startSession(frame.cwd, frame.resume, frame.sandboxed, frame.worktree),
			}));
			return;
		case "share":
			respond(frame.reqId, async () => {
				return { t: "link", reqId: frame.reqId, url: await shareSession(checkInstanceId(frame.instanceId)) };
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
		case "usage":
			respond(frame.reqId, async () => {
				if (!isUsageRange(frame.range)) throw new Error("unknown usage range");
				return { t: "usage", reqId: frame.reqId, usage: await usageReport(frame.range) };
			});
			return;
		case "sessions":
			respond(frame.reqId, async () => {
				const sessions = await sessionOverview(frame, { hosts: knownHosts, idle: knownIdle });
				// Only worktrees that still exist can be removed.
				return {
					t: "sessions",
					reqId: frame.reqId,
					sessions: await Promise.all(
						sessions.map(async session => {
							const inside = session.folder !== worktreesDir && isInside(worktreesDir, session.folder);
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
					sessions: await fileSessionOverviews(found, { hosts: knownHosts, idle: knownIdle }),
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
		case "worktree-remove":
			respond(frame.reqId, async () => {
				if (typeof frame.path !== "string") throw new Error("invalid worktree path");
				// A fresh list: never remove a checkout a running omp (hosting or not) works in.
				await loadSessions();
				await removeWorktree(
					frame.path,
					worktreesDir,
					[...knownHosts, ...knownIdle].map(session => session.cwd),
				);
				return { t: "ok", reqId: frame.reqId };
			});
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

socket.onClose = (reason, willReconnect) => {
	recordRelayEvent("close", willReconnect ? `${reason}, reconnecting` : reason);
	peers.clear();
	peerDevice.clear();
	zipPeers.clear();
	presence.clear();
	console.error(`companion: relay closed (${reason})${willReconnect ? ", reconnecting" : ""}`);
	if (!willReconnect) setTimeout(() => socket.connect(), RECONNECT_MS);
};

socket.connect();
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

function shutdown(): void {
	clearTimeout(pollTimer);
	awake.release();
	socket.close();
	// The warm preview browser is a separate process tree: close it before exiting.
	void closePreviewBrowser().finally(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
