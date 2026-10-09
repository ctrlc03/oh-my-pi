/**
 * omp collab companion: keeps one encrypted relay room open on this computer
 * so the collab web app can list every omp session on it, read its git state,
 * start new sessions, and join any hosted session without fetching a new link.
 *
 *   bun scripts/companion.ts             # print the pairing link + QR, then serve
 *   bun scripts/companion.ts --rotate    # new room key: unpairs every device
 *   bun scripts/companion.ts --pair      # print the pairing link + QR and exit
 *   bun scripts/companion.ts --install   # macOS: run at login as a LaunchAgent
 *   bun scripts/companion.ts --install --dry-run   # print the LaunchAgent plist only
 *   bun scripts/companion.ts --uninstall # remove the LaunchAgent
 *
 * Pair once by scanning the QR code (or pasting the link) in the web app. The
 * room id and key persist in `<config>/agent/collab-companion.json` (mode 0600),
 * so restarts keep devices paired. Anyone holding the pairing link can join
 * every session on this computer with full control, exactly as if they held
 * each session's control link, and can read files under each session's
 * repository and start omp in any folder.
 *
 * `--install` writes `~/Library/LaunchAgents/sh.omp.collab-companion.plist`
 * (RunAtLoad + KeepAlive, absolute bun/script/omp paths, log in
 * `~/Library/Logs/omp-collab-companion.log`) and loads it. Only one companion
 * may hold the room: stop a manually running one first, or the two fight over
 * it (relay close 4009). `--pair` shows the link while the agent runs.
 *
 * Session data comes from the installed omp CLI (`omp collab list --json`,
 * `omp collab link <id> --json`, `omp collab start <id> --json`), so the
 * companion works with whichever omp version runs the sessions; features the
 * CLI lacks (listing and sharing idle sessions) simply stay empty. Set OMP_BIN
 * when `omp` is not on PATH (launchd).
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
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { QrCode, renderQrHalfBlocks } from "@oh-my-pi/pi-tui/chrome/qrcode";
import { generateRoomKey, importRoomKey } from "../src/lib/codec";
import {
	type CompanionHost,
	type CompanionIdleSession,
	type CompanionReply,
	type CompanionRequest,
	PAIR_PREFIX,
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
import { gitDiff, gitSnapshot, readRepoFile } from "./companion-git";
import { installLaunchAgent, launchLogPath, uninstallLaunchAgent } from "./companion-launchd";
import {
	lastAssistantSummary,
	pendingQuestion,
	readSessionTail,
	recentFolders,
	SAFE_ID_RE,
} from "./companion-sessions";
import { sandboxedPids } from "./companion-sandbox";
import { canSandbox, findTmux, killTmuxSession, launchInTmux } from "./companion-start";
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
	subscriptions: PushSubscriptionJson[];
}

/** The subset of `omp collab list --json` host rows the companion reads. */
interface ListedHost {
	instanceId: string;
	pid: number;
	sessionId: string;
	sessionName: string | null;
	cwd: string;
	model: { provider: string; id: string } | null;
	startedAt: number;
	participants: number;
	relayConnected: boolean;
	inputRequired: boolean;
	busy?: boolean | null;
	access: "view" | "control";
}

/** An `idle` row of `omp collab list --json`; absent from omp CLIs that predate sharing idle sessions. */
interface ListedIdle {
	instanceId: string;
	pid: number;
	sessionId: string;
	sessionName: string | null;
	cwd: string;
	model: { provider: string; id: string } | null;
	startedAt: number;
	busy: boolean | null;
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
			const raw = JSON.parse(await Bun.file(statePath).text()) as Partial<CompanionState>;
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
					subscriptions:
						hasVapid && Array.isArray(raw.subscriptions) ? raw.subscriptions.filter(isPushSubscription) : [],
				};
				if (!hasVapid) await saveState(state);
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
		subscriptions: [],
	};
	await saveState(state);
	return state;
}

/** Control-capable hosts (the app joins with full control or not at all) and idle sessions that could be shared. */
async function listSessions(): Promise<{ hosts: CompanionHost[]; idle: CompanionIdleSession[] }> {
	const parsed = JSON.parse(await omp(["collab", "list", "--json"])) as { hosts?: ListedHost[]; idle?: ListedIdle[] };
	const listedIdle = (Array.isArray(parsed.idle) ? parsed.idle : []).filter(
		row => typeof row?.instanceId === "string" && typeof row.cwd === "string",
	);
	const listedHosts = (parsed.hosts ?? []).filter(host => host.access === "control");
	const sandboxed = await sandboxedPids(
		[...listedHosts, ...listedIdle].map(row => row.pid).filter(pid => Number.isInteger(pid) && pid > 0),
		sandboxOverlayPath,
	);
	const hosts = listedHosts
		.map(host => ({
			instanceId: host.instanceId,
			sessionId: host.sessionId,
			sessionName: host.sessionName,
			cwd: host.cwd,
			model: host.model ? `${host.model.provider}/${host.model.id}` : null,
			startedAt: host.startedAt,
			participants: host.participants,
			busy: host.busy ?? null,
			inputRequired: host.inputRequired,
			relayConnected: host.relayConnected,
			sandboxed: sandboxed.has(host.pid),
		}))
		.sort((a, b) => b.startedAt - a.startedAt);
	const idle = listedIdle
		.map(row => ({
			instanceId: row.instanceId,
			sessionId: row.sessionId,
			sessionName: row.sessionName ?? null,
			cwd: row.cwd,
			model: row.model ? `${row.model.provider}/${row.model.id}` : null,
			startedAt: row.startedAt,
			busy: row.busy ?? null,
			sandboxed: sandboxed.has(row.pid),
		}))
		.sort((a, b) => b.startedAt - a.startedAt);
	return { hosts, idle };
}

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
const rawKey = decodeBase64Url(state.key) as Uint8Array;
const roomLink = formatCollabLink(state.relayUrl, state.roomId, rawKey);
const pairUrl = `${webUrl.replace(/#.*$/, "")}#${PAIR_PREFIX}${roomLink}`;
const machine = os.hostname().replace(/\.local$/, "");
const sandboxAvailable = await canSandbox();
/** VAPID `sub` claim: push services want a contact URL; Apple rejects non-https ones. */
const pushSubject = webUrl.startsWith("https://") ? new URL(webUrl).origin : "https://my.omp.sh";

console.log("omp collab companion");
console.log(`pair a device: scan the code or open ${pairUrl}`);
for (const row of renderQrHalfBlocks(QrCode.encodeText(pairUrl, "M"))) console.log(` ${row}`);
console.log(`pairing stored in ${statePath}; --rotate unpairs every device`);

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

const peers = new Set<number>();
/** What each connected device last said about itself; see `presence` requests. */
const presence = new Map<number, { endpoint: string | null; visible: boolean }>();
let lastHostsJson = "";
let pollTimer: Timer | undefined;
/** Per-host state at the previous poll; null until a poll after (re)starting to watch. */
let seen: Map<string, { busy: boolean | null; inputRequired: boolean }> | null = null;
/** Sessions from the latest `omp collab list`; requests naming an instance resolve against these. */
let knownHosts: CompanionHost[] = [];
let knownIdle: CompanionIdleSession[] = [];

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function hostTitle(host: CompanionHost): string {
	return host.sessionName || path.basename(host.cwd) || "session";
}

function dropSubscription(endpoint: string): void {
	const kept = state.subscriptions.filter(s => s.endpoint !== endpoint);
	if (kept.length === state.subscriptions.length) return;
	state.subscriptions = kept;
	saveState(state).catch(err => console.error(`companion: saving state failed: ${errorText(err)}`));
}

function push(subscription: PushSubscriptionJson, payload: { title: string; body: string; instanceId?: string }): void {
	sendPush(subscription, payload, state.vapid, pushSubject, payload.instanceId).then(
		status => {
			// 404/410: the browser dropped the subscription (unsubscribed, app removed).
			if (status === 404 || status === 410) dropSubscription(subscription.endpoint);
			else if (status >= 400)
				console.error(`companion: push rejected (${status}) by ${new URL(subscription.endpoint).host}`);
		},
		err => console.error(`companion: push failed: ${errorText(err)}`),
	);
}

/** Notify every subscribed device not showing the app right now. */
function notify(host: CompanionHost, body: string): void {
	const showing = new Set<string>();
	for (const p of presence.values()) if (p.visible && p.endpoint) showing.add(p.endpoint);
	for (const subscription of state.subscriptions) {
		if (showing.has(subscription.endpoint)) continue;
		push(subscription, { title: hostTitle(host), body, instanceId: host.instanceId });
	}
}

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
	if (prev === null || state.subscriptions.length === 0) return;
	for (const host of hosts) {
		const before = prev.get(host.instanceId);
		if (!before) continue;
		if (host.inputRequired && !before.inputRequired) void announce(host, "input");
		else if (before.busy === true && host.busy === false && !host.inputRequired) void announce(host, "done");
	}
}

async function loadSessions(): Promise<{ hosts: CompanionHost[]; idle: CompanionIdleSession[] }> {
	const listed = await listSessions();
	knownHosts = listed.hosts;
	knownIdle = listed.idle;
	return listed;
}

/** Broadcast the host list when it changed; otherwise answer only `targetPeer`, if any. */
async function refresh(targetPeer?: number): Promise<void> {
	let listed: { hosts: CompanionHost[]; idle: CompanionIdleSession[] };
	try {
		listed = await loadSessions();
	} catch (err) {
		console.error(`companion: omp collab list failed: ${errorText(err)}`);
		return;
	}
	detectEdges(listed.hosts);
	// Push-only polling: nobody to tell; a device's `list` on joining gets a fresh answer.
	if (peers.size === 0) return;
	const canStart = (await findTmux()) !== null;
	const frame: CompanionReply = {
		t: "hosts",
		machine,
		hosts: listed.hosts,
		vapidKey: state.vapid.publicKey,
		idle: listed.idle,
		canStart,
		canSandbox: canStart && sandboxAvailable,
	};
	const json = JSON.stringify(frame);
	if (json !== lastHostsJson) socket.send(frame);
	else if (targetPeer !== undefined) socket.send(frame, targetPeer);
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

/**
 * Start omp in a detached tmux session — sandboxed to `cwd` with file tools
 * only when `sandboxed` — and wait until it hosts collab; resolves with its instance id.
 */
async function startSession(cwd: unknown, resume: unknown, sandboxed: unknown): Promise<string> {
	if (
		typeof cwd !== "string" ||
		(resume !== undefined && typeof resume !== "string") ||
		(sandboxed !== undefined && typeof sandboxed !== "boolean")
	) {
		throw new Error("invalid request");
	}
	const tmux = await findTmux();
	if (!tmux) throw new Error("tmux is not installed on this computer");
	if (sandboxed && !sandboxAvailable) throw new Error("sandboxed sessions need macOS sandbox-exec");
	const before = new Set((await loadSessions()).hosts.map(h => h.instanceId));
	const spawnedAt = Date.now();
	const sandbox = sandboxed
		? {
				home: os.homedir(),
				configDir,
				tmpDir: os.tmpdir(),
				companionState: statePath,
				overlayPath: sandboxOverlayPath,
			}
		: undefined;
	const launched = await launchInTmux({ tmux, ompBin, overlayPath, cwd, resume, sandbox });
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
}

/** Poll while a device is connected (fast) or one wants push notifications (slower). */
function schedulePoll(): void {
	if (pollTimer !== undefined) return;
	if (peers.size === 0 && state.subscriptions.length === 0) {
		// Unwatched gaps must not read as edges once watching resumes.
		seen = null;
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
async function setSubscription(subscription: unknown, on: boolean): Promise<void> {
	if (!isPushSubscription(subscription)) throw new Error("invalid push subscription");
	const others = state.subscriptions.filter(s => s.endpoint !== subscription.endpoint);
	const added = on && others.length === state.subscriptions.length;
	state.subscriptions = on ? [...others, subscription] : others;
	await saveState(state);
	if (added) push(subscription, { title: machine, body: "Notifications are on for this computer." });
	schedulePoll();
}

socket.onOpen = () => console.log("companion: room open, waiting for devices");

socket.onControl = msg => {
	if (msg.t === "peer-joined") {
		peers.add(msg.peer);
		schedulePoll();
	} else if (msg.t === "peer-left") {
		peers.delete(msg.peer);
		presence.delete(msg.peer);
	}
};

socket.onFrame = (frame, fromPeer) => {
	// A frame that decrypted came from a paired device: track it even if its
	// peer-joined control message predates this connection.
	peers.add(fromPeer);
	schedulePoll();
	if ("reqId" in frame && typeof frame.reqId !== "number") return;
	/** Answer a request with whatever `work` resolves to, or with its error. */
	const respond = (reqId: number, work: () => Promise<CompanionReply>): void => {
		work().then(
			reply => socket.send(reply, fromPeer),
			err => socket.send({ t: "error", reqId, message: errorText(err) }, fromPeer),
		);
	};
	switch (frame.t) {
		case "list":
			void refresh(fromPeer);
			return;
		case "link":
			respond(frame.reqId, async () => {
				return { t: "link", reqId: frame.reqId, url: await resolveLink(checkInstanceId(frame.instanceId)) };
			});
			return;
		case "push":
			respond(frame.reqId, async () => {
				await setSubscription(frame.subscription, frame.on === true);
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
				instanceId: await startSession(frame.cwd, frame.resume, frame.sandboxed),
			}));
			return;
		case "share":
			respond(frame.reqId, async () => {
				return { t: "link", reqId: frame.reqId, url: await shareSession(checkInstanceId(frame.instanceId)) };
			});
			return;
	}
};

socket.onClose = (reason, willReconnect) => {
	peers.clear();
	presence.clear();
	console.error(`companion: relay closed (${reason})${willReconnect ? ", reconnecting" : ""}`);
	if (!willReconnect) setTimeout(() => socket.connect(), RECONNECT_MS);
};

socket.connect();
schedulePoll();

function shutdown(): void {
	clearTimeout(pollTimer);
	socket.close();
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
