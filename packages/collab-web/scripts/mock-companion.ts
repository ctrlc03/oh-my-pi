/**
 * Offline mock companion: starts the local relay, serves a paired-computer room with a
 * fixture list of sessions, and keeps the session organisation (pin / snooze / settle)
 * with the real organiser over a temp file, so the sessions sidebar can be tried in a
 * browser — two tabs pair with it and see each other's changes.
 *
 *   bun scripts/mock-companion.ts [--port 7468] [--web http://localhost:3000/] [--dir /tmp/mock-companion] [--session-link <room link>]
 *                                 [--machine <name>] [--hosts 1,2,3] [--session-id <id>]
 *                                 [--personal fresh|enabled] [--personal-login ready|missing]
 *
 * `--machine` names the computer and gives its sessions ids of their own (the way two real computers never share a session id,
 * though their processes may share an instance id: `inst-1` here and there); `--hosts` lists only those fixture sessions
 * (without it, all of them and the vendor agents' too). `--session-id` is the id the `--session-link` room reports (`mock-collab-session`
 * for `mock-host`): the `api-pagination` fixture session lists under it, so the session opened from the list is hosted by this computer and
 * its working-tree features (changes, quizzes, architecture maps of its changes) are offered. The room and its key are kept in `<--dir>/room.json`, so a restarted
 * mock is the same computer to the devices paired with it.
 *
 * Prints a pairing link (`#pair:…`); open it in as many browsers or tabs as you like (each
 * is a new device). It never touches ~/.omp, tmux, or GitHub: listing and pull request
 * state and the open pull request list are canned; starting sessions (./mock-start: in the folders, in new worktrees, or without a
 * project in a real scratch folder under `<--dir>/config/scratch`) and comparing models (best-of-N, see ./mock-fanout) work over a
 * throw-away git repository, and `--session-link` makes opening any session join that room (start
 * `scripts/mock-host.ts`; `--agent <id>` makes it a vendor agent's session). Vendor agents (./mock-foreign) are canned: some
 * installed, some needing sign-in or an install, a custom one; installing and saving custom ones works, and sessions can be
 * started with them, listed and resumed. The worktree settings and the settle cleanup (./mock-settle) run the real code over a
 * throw-away repository too. Quizzes (./mock-quiz) are canned: a finished quiz of a two-pull-request stack, one half
 * answered, a failed one; new ones from the form tick to ready, and `quiz-stack` finds a three-pull-request stack for
 * #2243, #2244 and #2245 (any other number is alone). Every other request is refused. Ctrl+C stops it.
 *
 * `--personal fresh|enabled` (default `off`: nothing is advertised or answered, as before) adds the Personal agent (./mock-personal): `fresh`
 * is advertised and not set up (Settings → Personal agent → Set up), `enabled` is set up with sample memories, About you, proposals,
 * digests, an inbox and events and a Personal session in the sidebar. `--personal-login ready|missing` (default `ready`) is the
 * Personal profile's login; with `missing` the agent stays stopped until the file `<--dir>/personal-login-ready` exists
 * (`touch` it, which stands for running `omp --profile personal login`). While the file `<--dir>/personal-failed` exists the
 * enabled agent's run is `failed` (the entry's Failed state); remove it and the session starts again.
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
	InboxItem,
} from "../src/lib/companion";
import { formatPairingUrl } from "../src/lib/companion";
import { encodeBase64Url, formatCollabLink, generateRoomId, parseCollabLink } from "../src/lib/link";
import { parseOrg } from "../src/lib/session-org";
import { CollabSocket } from "../src/lib/socket";
import { createSessionOrg, loadOrgFile, saveOrgFile } from "./companion-sessionorg";
import { startLocalRelay } from "./local-relay";
import { createMockBlueprint } from "./mock-blueprint";
import { createMockFanout } from "./mock-fanout";
import { createMockForeign, mockForeignHosts } from "./mock-foreign";
import { createMockPersonal } from "./mock-personal";
import { createMockQuiz, mockStackPrs } from "./mock-quiz";
import { createMockSearch } from "./mock-search";
import { createMockStart } from "./mock-start";
import { createMockSettle } from "./mock-settle";

const POLL_MS = 3000;
const argv = Bun.argv.slice(2);
const flag = (name: string, fallback: string): string => {
	const at = argv.indexOf(name);
	return at >= 0 && argv[at + 1] ? (argv[at + 1] as string) : fallback;
};

const dir = flag("--dir", await fs.mkdtemp(path.join(os.tmpdir(), "mock-companion-")));
await fs.mkdir(dir, { recursive: true });
const webUrl = flag("--web", "http://localhost:3000/");
const machine = flag("--machine", "");
const joinedSessionId = flag("--session-id", "");
const only = flag("--hosts", "")
	.split(",")
	.filter(n => n !== "")
	.map(Number);
const relay = startLocalRelay(Number(flag("--port", "7468")));
const roomFile = path.join(dir, "room.json");
const kept = (await Bun.file(roomFile)
	.json()
	.catch(() => null)) as { link?: string; key?: string } | null;
const rawKey = kept?.key ? Uint8Array.from(atob(kept.key), c => c.charCodeAt(0)) : generateRoomKey();
const roomLink = kept?.link ?? formatCollabLink(relay.url, generateRoomId(), rawKey);
await Bun.write(roomFile, JSON.stringify({ link: roomLink, key: btoa(String.fromCharCode(...rawKey)) }));

const now = Date.now();
const HOUR = 60 * 60 * 1000;
const host = (n: number, name: string, over: Partial<CompanionHost> = {}): CompanionHost => ({
	instanceId: `inst-${n}`,
	sessionId: machine ? `${machine}-session-${n}` : `session-${n}`,
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
	host(7, "api-pagination", joinedSessionId === "" ? {} : { sessionId: joinedSessionId }),
	host(8, "release-notes"),
	host(9, "perf-profiling"),
	host(10, "i18n-strings"),
	host(11, "ci-cache"),
].filter(h => only.length === 0 || only.includes(Number(h.instanceId.slice("inst-".length))));
if (only.length === 0) hosts.push(...mockForeignHosts(now));
const idle: CompanionIdleSession[] = [
	{
		instanceId: "inst-6",
		sessionId: machine ? `${machine}-session-6` : "session-6",
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

/** The worktree settings and the cleanup run when a worktree session settles, over a throw-away git repository (two sessions work in its worktrees). */
const settle = await createMockSettle({ dir, hosts });
/** Sessions the mock ended when they settled: they stay listed as ended, which the app resumes from. */
const ended: CompanionHost[] = [];

const sessionOrg = createSessionOrg({
	now: Date.now,
	initial: await loadOrgFile(orgPath),
	save: file => saveOrgFile(orgPath, file),
	readPrDone: async cwd => prDone.get(cwd) ?? null,
	prAvailable: () => true,
	onChange: () => broadcast(),
	onSettled: sessions => void settle.run(sessions),
	endSession: async session => {
		const at = hosts.findIndex(h => h.instanceId === session.instanceId);
		if (at !== -1) ended.push(...hosts.splice(at, 1));
		return true;
	},
	onError: err => console.error(`mock-companion: ${err instanceof Error ? err.message : String(err)}`),
});

/** The vendor agents and their sessions: live ones are in `hosts`, ended ones are listed and resumed from here. */
const foreign = createMockForeign({ hosts });
/** The folders and model-comparison requests, over a throw-away git repository in the state directory. */
const fanout = await createMockFanout({
	dir,
	hosts,
	onChange: () => broadcast(),
	sessionLink: flag("--session-link", "") || undefined,
	foreign,
});
/** Starting sessions (in the folders, in new worktrees, or without a project) over real folders; `folders` adds the scratch ones. */
const starts = createMockStart({
	dir,
	hosts,
	baseFolders: async () => {
		const reply = await fanout.answer({ t: "folders", reqId: 0 });
		return foreign.folders(reply.t === "folders" ? reply.folders : []);
	},
	onChange: () => broadcast(),
	foreign,
});
/** Open pull requests `#` in the composer can mention; only the list is answered, a pull request's detail is not. */
const MOCK_PRS: GithubItem[] = (
	[
		...mockStackPrs().map(pr => ({
			number: pr.number,
			title: pr.title,
			labels: ["refactor"],
			draft: false,
			review: "required" as const,
			checks: "pass" as const,
		})),
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
const search = createMockSearch(hosts, () => [
	...foreign.searchable(),
	...ended.map(host => ({
		overview: {
			sessionId: host.sessionId,
			title: host.sessionName,
			folder: host.cwd,
			startedAt: host.startedAt,
			endedAt: Date.now(),
			requests: 12,
			toolCalls: 40,
			subagents: 0,
			tokens: 120_000,
			cost: 0.42,
			models: host.model === null ? [] : [host.model],
		},
		messages: [],
	})),
]);
/** Architecture maps: a finished full map and changes map, a stale one and a failed one; new ones tick to ready. */
const blueprint = createMockBlueprint({
	instanceId: "inst-7",
	// `--blueprint-sample a.json,b.json` adds maps the real pipeline wrote; `--blueprint-source <checkout>` serves their code.
	samples: flag("--blueprint-sample", "")
		.split(",")
		.filter(file => file !== "")
		.map(file => ({ file, sourceDir: flag("--blueprint-source", "") || undefined })),
	onChanged: id => {
		for (const peer of peers) socket.send({ t: "blueprint-changed", id }, peer);
	},
});

/** Quizzes on code changes: a finished stack quiz, one half answered, a failed one; new ones tick to ready. `--quiz-stage-ms` slows the ticks. */
const quiz = createMockQuiz({
	instanceId: "inst-7",
	stageMs: Number(flag("--quiz-stage-ms", "1200")),
	onChanged: id => {
		for (const peer of peers) socket.send({ t: "quiz-changed", id }, peer);
	},
});

/**
 * The Personal agent (./mock-personal), only with `--personal fresh|enabled`; without it nothing is advertised or answered.
 * Its host row joins `hosts` while the session runs; `--personal-login missing` waits for `<--dir>/personal-login-ready` to exist.
 */
const personalMode = flag("--personal", "off");
if (personalMode !== "off" && personalMode !== "fresh" && personalMode !== "enabled")
	throw new Error("--personal takes off, fresh or enabled");
const personalLogin = flag("--personal-login", "ready");
if (personalLogin !== "ready" && personalLogin !== "missing")
	throw new Error("--personal-login takes ready or missing");
const personalLoginFile = path.join(dir, "personal-login-ready");
const personalFailFile = path.join(dir, "personal-failed");
if (personalMode !== "off")
	await Promise.all([personalLoginFile, personalFailFile].map(file => fs.rm(file, { force: true })));
const personal =
	personalMode === "off"
		? undefined
		: createMockPersonal({
				hosts,
				machine: machine || "mock-computer",
				computerId: `mock-${room.roomId}`,
				login: personalLogin,
				setUp: personalMode === "enabled",
				loginFile: personalLoginFile,
				failFile: personalFailFile,
				broadcastFrame: frame => {
					for (const peer of peers) socket.send(frame, peer);
				},
				onHostsChanged: () => broadcast(),
			});

function hostsFrame(): CompanionReply {
	return {
		t: "hosts",
		machine: machine || "mock-computer",
		hosts: fanout.annotate(hosts),
		...fanout.capabilities,
		...starts.capabilities,
		...search.capabilities,
		...blueprint.capabilities,
		...quiz.capabilities,
		...foreign.capabilities,
		...settle.capabilities,
		...personal?.capabilities(),
		canGithub: true,
		idle,
		vapidKey: "",
		sessionOrgRev: sessionOrg.file().rev,
		canOrderSessions: true,
		canEndOnSettle: true,
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
	else if (foreign.handles(frame))
		void foreign.answer(frame).then(
			reply => socket.send(reply, fromPeer),
			(err: unknown) =>
				socket.send(
					{ t: "error", reqId: frame.reqId, message: err instanceof Error ? err.message : String(err) },
					fromPeer,
				),
		);
	else if (starts.handles(frame))
		void starts.answer(frame).then(
			reply => socket.send(reply, fromPeer),
			(err: unknown) =>
				socket.send(
					{ t: "error", reqId: frame.reqId, message: err instanceof Error ? err.message : String(err) },
					fromPeer,
				),
		);
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
	else if (blueprint.handles(frame)) {
		try {
			socket.send(blueprint.answer(frame), fromPeer);
		} catch (err) {
			socket.send(
				{ t: "error", reqId: frame.reqId, message: err instanceof Error ? err.message : String(err) },
				fromPeer,
			);
		}
	} else if (quiz.handles(frame))
		void quiz.answer(frame).then(
			reply => socket.send(reply, fromPeer),
			(err: unknown) =>
				socket.send(
					{ t: "error", reqId: frame.reqId, message: err instanceof Error ? err.message : String(err) },
					fromPeer,
				),
		);
	else if (settle.handles(frame))
		void settle.answer(frame).then(
			reply => socket.send(reply, fromPeer),
			(err: unknown) =>
				socket.send(
					{ t: "error", reqId: frame.reqId, message: err instanceof Error ? err.message : String(err) },
					fromPeer,
				),
		);
	else if (personal?.handles(frame)) {
		try {
			socket.send(personal.answer(frame), fromPeer);
		} catch (err) {
			socket.send(
				{ t: "error", reqId: frame.reqId, message: err instanceof Error ? err.message : String(err) },
				fromPeer,
			);
		}
	} else if (personal && frame.t === "inbox") {
		// With Personal on, the Inbox sheet shows it merged with the sessions that wait: these are the fixture ones that need input.
		const items = hosts
			.filter(candidate => candidate.inputRequired === true && candidate.personal !== true)
			.map((candidate, at): InboxItem => ({
				instanceId: candidate.instanceId,
				title: candidate.sessionName ?? candidate.cwd,
				cwd: candidate.cwd,
				kind: "input",
				text: "Which of the two migrations should run first?",
				options: ["The schema change", "The backfill"],
				at: candidate.startedAt - at * 60_000,
			}));
		socket.send({ t: "inbox", reqId: frame.reqId, items }, fromPeer);
	} else if (frame.t === "github")
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
	quiz.stop();
	socket.close();
	relay.stop();
	process.exit(0);
});
