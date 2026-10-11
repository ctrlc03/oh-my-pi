/**
 * Offline mock companion: starts the local relay, serves a paired-computer room with a
 * fixture list of sessions, and keeps the session organisation (pin / snooze / settle)
 * with the real organiser over a temp file, so the sessions sidebar can be tried in a
 * browser — two tabs pair with it and see each other's changes.
 *
 *   bun scripts/mock-companion.ts [--port 7468] [--web http://localhost:3000/] [--dir /tmp/mock-companion] [--session-link <room link>]
 *
 * Prints a pairing link (`#pair:…`); open it in as many browsers or tabs as you like (each
 * is a new device). It never touches ~/.omp, tmux, or GitHub: listing and pull request
 * state and the open pull request list are canned; starting sessions and comparing models (best-of-N, see ./mock-fanout) work over a
 * throw-away git repository, and `--session-link` makes opening any session join that room (start
 * `scripts/mock-host.ts`). Every other request is refused. Ctrl+C stops it.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { generateRoomKey, importRoomKey } from "../src/lib/codec";
import type {
	CompanionHost,
	CompanionIdleSession,
	CompanionReply,
	CompanionRequest,
	GithubItem,
} from "../src/lib/companion";
import { formatPairingUrl } from "../src/lib/companion";
import { encodeBase64Url, formatCollabLink, generateRoomId, parseCollabLink } from "../src/lib/link";
import { parseOrg } from "../src/lib/session-org";
import { CollabSocket } from "../src/lib/socket";
import { createSessionOrg, loadOrgFile, saveOrgFile } from "./companion-sessionorg";
import { startLocalRelay } from "./local-relay";
import { createMockFanout } from "./mock-fanout";
import { createMockSearch } from "./mock-search";

const POLL_MS = 3000;
const argv = Bun.argv.slice(2);
const flag = (name: string, fallback: string): string => {
	const at = argv.indexOf(name);
	return at >= 0 && argv[at + 1] ? (argv[at + 1] as string) : fallback;
};

const dir = flag("--dir", await fs.mkdtemp(path.join(os.tmpdir(), "mock-companion-")));
await fs.mkdir(dir, { recursive: true });
const webUrl = flag("--web", "http://localhost:3000/");
const relay = startLocalRelay(Number(flag("--port", "7468")));
const rawKey = generateRoomKey();
const roomLink = formatCollabLink(relay.url, generateRoomId(), rawKey);

const now = Date.now();
const HOUR = 60 * 60 * 1000;
const host = (n: number, name: string, over: Partial<CompanionHost> = {}): CompanionHost => ({
	instanceId: `inst-${n}`,
	sessionId: `session-${n}`,
	sessionName: name,
	cwd: `/work/${name}`,
	model: "anthropic/claude-sonnet-5-5",
	startedAt: now - n * HOUR,
	participants: 1,
	busy: false,
	inputRequired: false,
	relayConnected: true,
	...over,
});
const hosts: CompanionHost[] = [
	host(1, "refactor-auth", { busy: true }),
	host(2, "fix-flaky-tests"),
	host(3, "docs-pass", { inputRequired: true, busy: false }),
	host(4, "merged-feature"),
	host(5, "spike-wasm", { busy: true }),
];
const idle: CompanionIdleSession[] = [
	{
		instanceId: "inst-6",
		sessionId: "session-6",
		sessionName: "old-experiment",
		cwd: "/work/old-experiment",
		model: null,
		startedAt: now - 6 * HOUR,
		busy: false,
	},
];
/** cwd → when its pull request finished: the `merged-feature` session settles when the rule is on. */
const prDone = new Map<string, number>([["/work/merged-feature", now - HOUR / 2]]);

const orgPath = path.join(dir, "collab-companion-sessionorg.json");
let lastHostsJson = "";
const peers = new Set<number>();
const room = parseCollabLink(roomLink);
if ("error" in room) throw new Error(room.error);
const socket = new CollabSocket<CompanionReply, CompanionRequest>({
	wsUrl: room.wsUrl,
	role: "host",
	key: importRoomKey(rawKey),
});

const sessionOrg = createSessionOrg({
	now: Date.now,
	initial: await loadOrgFile(orgPath),
	save: file => saveOrgFile(orgPath, file),
	readPrDone: async cwd => prDone.get(cwd) ?? null,
	prAvailable: () => true,
	onChange: () => broadcast(),
	onError: err => console.error(`mock-companion: ${err instanceof Error ? err.message : String(err)}`),
});

/** The folders and model-comparison requests, over a throw-away git repository in the state directory. */
const fanout = await createMockFanout({
	dir,
	hosts,
	onChange: () => broadcast(),
	sessionLink: flag("--session-link", "") || undefined,
});
/** Open pull requests `#` in the composer can mention; only the list is answered, a pull request's detail is not. */
const MOCK_PRS: GithubItem[] = (
	[
		{
			number: 482,
			title: "Refresh tokens rotate on every use",
			labels: ["auth"],
			draft: false,
			review: "required",
			checks: "pass",
		},
		{
			number: 479,
			title: "Split the session store from the cache",
			labels: [],
			draft: true,
			review: null,
			checks: "pending",
		},
		{
			number: 471,
			title: "Fix flaky retry test",
			labels: ["tests"],
			draft: false,
			review: "approved",
			checks: "fail",
		},
	] satisfies Pick<GithubItem, "number" | "title" | "labels" | "draft" | "review" | "checks">[]
).map(pr => ({
	...pr,
	kind: "pr",
	state: "open",
	author: "mock-user",
	updatedAt: now - HOUR,
	url: `https://github.com/example/app/pull/${pr.number}`,
}));
/** The all-sessions list and message search, over canned sessions. */
const search = createMockSearch(hosts);

function hostsFrame(): CompanionReply {
	return {
		t: "hosts",
		machine: "mock-computer",
		hosts: fanout.annotate(hosts),
		...fanout.capabilities,
		...search.capabilities,
		canGithub: true,
		idle,
		vapidKey: "",
		sessionOrgRev: sessionOrg.file().rev,
	};
}

function broadcast(to?: number): void {
	const frame = hostsFrame();
	const json = JSON.stringify(frame);
	if (json !== lastHostsJson) for (const peer of peers) socket.send(frame, peer);
	else if (to !== undefined) socket.send(frame, to);
	lastHostsJson = json;
}

socket.onFrame = (frame, fromPeer) => {
	if (frame.t === "auth") {
		peers.add(fromPeer);
		socket.send(
			{ t: "authed", deviceId: `device-${fromPeer}`, token: frame.invite ? `token-${fromPeer}` : undefined },
			fromPeer,
		);
		broadcast(fromPeer);
		return;
	}
	if (!peers.has(fromPeer)) return;
	if (frame.t === "list") {
		broadcast(fromPeer);
		return;
	}
	if (!("reqId" in frame)) return;
	if (frame.t === "ping") socket.send({ t: "ok", reqId: frame.reqId }, fromPeer);
	else if (frame.t === "session-org")
		void sessionOrg.sync(parseOrg(frame.doc)).then(({ doc, rev }) => {
			socket.send({ t: "session-org", reqId: frame.reqId, doc, rev }, fromPeer);
			broadcast();
		});
	else if (fanout.handles(frame))
		void fanout.answer(frame).then(
			reply => socket.send(reply, fromPeer),
			(err: unknown) =>
				socket.send(
					{ t: "error", reqId: frame.reqId, message: err instanceof Error ? err.message : String(err) },
					fromPeer,
				),
		);
	else if (search.handles(frame)) socket.send(search.answer(frame), fromPeer);
	else if (frame.t === "github")
		socket.send({ t: "github", reqId: frame.reqId, repo: "example/app", items: MOCK_PRS }, fromPeer);
	else
		socket.send(
			{ t: "error", reqId: frame.reqId, message: `the mock companion does not answer ${frame.t}` },
			fromPeer,
		);
};
socket.onControl = msg => {
	if (msg.t === "peer-left") peers.delete(msg.peer);
};
socket.onOpen = () => {
	console.log("mock companion ready");
	console.log(
		`pair a device: ${formatPairingUrl(webUrl, roomLink, encodeBase64Url(crypto.getRandomValues(new Uint8Array(16))))}`,
	);
	console.log(`state in ${dir}; Ctrl+C stops`);
};
socket.connect();

const timer = setInterval(() => {
	void sessionOrg.tick([...hosts, ...idle.map(session => ({ ...session, inputRequired: false }))]);
	broadcast();
}, POLL_MS);

process.on("SIGINT", () => {
	clearInterval(timer);
	socket.close();
	relay.stop();
	process.exit(0);
});
