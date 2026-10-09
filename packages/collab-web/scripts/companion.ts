/**
 * omp collab companion: keeps one encrypted relay room open on this computer
 * so the collab web app can list every omp session hosting `/collab` here and
 * join any of them without fetching a new link.
 *
 *   bun scripts/companion.ts            # print the pairing link + QR, then serve
 *   bun scripts/companion.ts --rotate   # new room key: unpairs every device
 *
 * Pair once by scanning the QR code (or pasting the link) in the web app. The
 * room id and key persist in `<config>/agent/collab-companion.json` (mode 0600),
 * so restarts keep devices paired. Anyone holding the pairing link can join
 * every session on this computer with full control, exactly as if they held
 * each session's control link.
 *
 * Session data comes from the installed omp CLI (`omp collab list --json`,
 * `omp collab link <id> --json`), so the companion works with whichever omp
 * version runs the sessions. Set OMP_BIN when `omp` is not on PATH (launchd).
 *
 * Web Push: devices that turn notifications on hand over a push subscription;
 * the companion then keeps polling while it runs and notifies them when a
 * session needs input or finishes a turn, sending straight to the browser's
 * push service with its own VAPID key (no server in between). A device that is
 * showing the app is skipped: it alerts in-app instead.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { QrCode, renderQrHalfBlocks } from "@oh-my-pi/pi-tui/chrome/qrcode";
import { generateRoomKey, importRoomKey } from "../src/lib/codec";
import {
	type CompanionHost,
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
import { generateVapidKeys, isPushSubscription, sendPush, type VapidKeys } from "./web-push";

/** Host list refresh while at least one device is connected. */
const POLL_MS = 3_000;
/** Refresh while no device is connected but some want push notifications. */
const PUSH_POLL_MS = 6_000;
/** Back-off after a terminal relay close (e.g. our previous connection still registered as host). */
const RECONNECT_MS = 5_000;
const DEFAULT_WEB_URL = "https://my.omp.sh/";

const statePath = path.join(os.homedir(), process.env.PI_CONFIG_DIR || ".omp", "agent", "collab-companion.json");
const ompBin = process.env.OMP_BIN || Bun.which("omp") || path.join(os.homedir(), ".bun", "bin", "omp");

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

/** Control-capable hosts only: the app joins with full control or not at all. */
async function listHosts(): Promise<CompanionHost[]> {
	const parsed = JSON.parse(await omp(["collab", "list", "--json"])) as { hosts?: ListedHost[] };
	return (parsed.hosts ?? [])
		.filter(host => host.access === "control")
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
		}))
		.sort((a, b) => b.startedAt - a.startedAt);
}

async function resolveLink(instanceId: string): Promise<string> {
	const parsed = JSON.parse(await omp(["collab", "link", instanceId, "--json"])) as { url?: unknown };
	if (typeof parsed.url !== "string" || !parsed.url) throw new Error("omp returned no link");
	return parsed.url;
}

// ── startup ──────────────────────────────────────────────────────────────────

const rotate = Bun.argv.includes("--rotate");
const relayUrl = (await configValue("collab.relayUrl")) || DEFAULT_RELAY_URL;
const webUrl = (await configValue("collab.webUrl")) || DEFAULT_WEB_URL;
const state = await loadState(relayUrl, rotate);
const rawKey = decodeBase64Url(state.key) as Uint8Array;
const roomLink = formatCollabLink(state.relayUrl, state.roomId, rawKey);
const pairUrl = `${webUrl.replace(/#.*$/, "")}#${PAIR_PREFIX}${roomLink}`;
const machine = os.hostname().replace(/\.local$/, "");
/** VAPID `sub` claim: push services want a contact URL; Apple rejects non-https ones. */
const pushSubject = webUrl.startsWith("https://") ? new URL(webUrl).origin : "https://my.omp.sh";

console.log("omp collab companion");
console.log(`pair a device: scan the code or open ${pairUrl}`);
for (const row of renderQrHalfBlocks(QrCode.encodeText(pairUrl, "M"))) console.log(` ${row}`);
console.log(`pairing stored in ${statePath}; --rotate unpairs every device`);

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

/** Push on a session's needs-input and busy→idle edges since the previous poll. */
function detectEdges(hosts: CompanionHost[]): void {
	const prev = seen;
	seen = new Map(hosts.map(h => [h.instanceId, { busy: h.busy, inputRequired: h.inputRequired }]));
	if (prev === null || state.subscriptions.length === 0) return;
	for (const host of hosts) {
		const before = prev.get(host.instanceId);
		if (!before) continue;
		if (host.inputRequired && !before.inputRequired) notify(host, "Needs your input");
		else if (before.busy === true && host.busy === false && !host.inputRequired) notify(host, "Finished, your turn");
	}
}

/** Broadcast the host list when it changed; otherwise answer only `targetPeer`, if any. */
async function refresh(targetPeer?: number): Promise<void> {
	let hosts: CompanionHost[];
	try {
		hosts = await listHosts();
	} catch (err) {
		console.error(`companion: omp collab list failed: ${errorText(err)}`);
		return;
	}
	detectEdges(hosts);
	// Push-only polling: nobody to tell; a device's `list` on joining gets a fresh answer.
	if (peers.size === 0) return;
	const json = JSON.stringify(hosts);
	const frame: CompanionReply = { t: "hosts", machine, hosts, vapidKey: state.vapid.publicKey };
	if (json !== lastHostsJson) socket.send(frame);
	else if (targetPeer !== undefined) socket.send(frame, targetPeer);
	lastHostsJson = json;
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
	const fail = (reqId: number) => (err: unknown) =>
		socket.send({ t: "error", reqId, message: errorText(err) }, fromPeer);
	switch (frame.t) {
		case "list":
			void refresh(fromPeer);
			return;
		case "link":
			resolveLink(frame.instanceId).then(
				url => socket.send({ t: "link", reqId: frame.reqId, url }, fromPeer),
				fail(frame.reqId),
			);
			return;
		case "push":
			setSubscription(frame.subscription, frame.on).then(
				() => socket.send({ t: "ok", reqId: frame.reqId }, fromPeer),
				fail(frame.reqId),
			);
			return;
		case "presence":
			presence.set(fromPeer, { endpoint: frame.endpoint, visible: frame.visible });
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
