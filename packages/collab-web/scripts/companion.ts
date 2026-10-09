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
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { QrCode, renderQrHalfBlocks } from "@oh-my-pi/pi-tui/chrome/qrcode";
import { generateRoomKey, importRoomKey } from "../src/lib/codec";
import { type CompanionHost, type CompanionReply, type CompanionRequest, PAIR_PREFIX } from "../src/lib/companion";
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

/** Host list refresh while at least one device is connected. */
const POLL_MS = 3_000;
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
}

/** The subset of `omp collab list --json` host rows the companion reads. */
interface ListedHost {
	instanceId: string;
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
				return { relayUrl, roomId: raw.roomId, key: raw.key };
			}
		} catch {
			// missing or unreadable: pair afresh below
		}
	}
	const state: CompanionState = { relayUrl, roomId: generateRoomId(), key: encodeBase64Url(generateRoomKey()) };
	await fs.mkdir(path.dirname(statePath), { recursive: true });
	await fs.writeFile(statePath, `${JSON.stringify(state, null, "\t")}\n`, { mode: 0o600 });
	await fs.chmod(statePath, 0o600);
	return state;
}

/** Control-capable hosts only: the app joins with full control or not at all. */
async function listHosts(): Promise<CompanionHost[]> {
	const parsed = JSON.parse(await omp(["collab", "list", "--json"])) as { hosts?: ListedHost[] };
	return (parsed.hosts ?? [])
		.filter(host => host.access === "control")
		.map(host => ({
			instanceId: host.instanceId,
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
let lastHostsJson = "";
let pollTimer: Timer | undefined;

/** Broadcast the host list when it changed; otherwise answer only `targetPeer`, if any. */
async function refresh(targetPeer?: number): Promise<void> {
	let hosts: CompanionHost[];
	try {
		hosts = await listHosts();
	} catch (err) {
		console.error(`companion: omp collab list failed: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}
	const json = JSON.stringify(hosts);
	if (json !== lastHostsJson) socket.send({ t: "hosts", machine, hosts });
	else if (targetPeer !== undefined) socket.send({ t: "hosts", machine, hosts }, targetPeer);
	lastHostsJson = json;
}

function schedulePoll(): void {
	if (pollTimer !== undefined || peers.size === 0) return;
	pollTimer = setTimeout(async () => {
		await refresh();
		pollTimer = undefined;
		schedulePoll();
	}, POLL_MS);
}

socket.onOpen = () => console.log("companion: room open, waiting for devices");

socket.onControl = msg => {
	if (msg.t === "peer-joined") {
		peers.add(msg.peer);
		schedulePoll();
	} else if (msg.t === "peer-left") {
		peers.delete(msg.peer);
	}
};

socket.onFrame = (frame, fromPeer) => {
	// A frame that decrypted came from a paired device: track it even if its
	// peer-joined control message predates this connection.
	peers.add(fromPeer);
	schedulePoll();
	switch (frame.t) {
		case "list":
			void refresh(fromPeer);
			return;
		case "link":
			resolveLink(frame.instanceId).then(
				url => socket.send({ t: "link", reqId: frame.reqId, url }, fromPeer),
				(err: unknown) =>
					socket.send(
						{ t: "link-error", reqId: frame.reqId, message: err instanceof Error ? err.message : String(err) },
						fromPeer,
					),
			);
			return;
	}
};

socket.onClose = (reason, willReconnect) => {
	peers.clear();
	console.error(`companion: relay closed (${reason})${willReconnect ? ", reconnecting" : ""}`);
	if (!willReconnect) setTimeout(() => socket.connect(), RECONNECT_MS);
};

socket.connect();

function shutdown(): void {
	clearTimeout(pollTimer);
	socket.close();
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
