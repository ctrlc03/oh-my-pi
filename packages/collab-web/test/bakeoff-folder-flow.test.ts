import { afterEach, describe, expect, it } from "bun:test";
import type { BakeoffFolder } from "@oh-my-pi/pi-wire/bakeoff";
import {
	type BakeoffFormValues,
	buildBakeoffCreate,
	friendlyListError,
	isGitFolder,
	judgeView,
	type MetricPick,
	validateBakeoff,
} from "../src/components/bakeoff/bakeoff-flow";
import {
	CompanionClient,
	type CompanionHost,
	type CompanionReply,
	type CompanionRequest,
	INITIAL_SNAPSHOT,
} from "../src/lib/companion";
import { generateRoomKey, importRoomKey } from "../src/lib/codec";
import { formatCollabLink, generateRoomId, parseCollabLink } from "../src/lib/link";
import { CollabSocket } from "../src/lib/socket";
import { startLocalRelay } from "../scripts/local-relay";

const folder = (over: Partial<BakeoffFolder> = {}): BakeoffFolder => ({
	git: false,
	files: 12,
	name: "notes",
	...over,
});
const pick: MetricPick = { presets: ["simplicity"], customs: [], starred: null };

/** The values of the form opened on a folder that is not a git repository, with a pasted design. */
const values = (over: Partial<BakeoffFormValues> = {}): BakeoffFormValues => ({
	cwd: "/work/notes",
	subject: { kind: "doc" },
	sessionId: "s-1",
	useConversation: false,
	doc: { source: "paste", name: "", text: "Use a queue." },
	mode: "design",
	start: "original",
	goal: "",
	metrics: pick,
	instructions: "",
	models: ["anthropic/a", "openai/b"],
	reviewer: "anthropic/r",
	judge: judgeView({ state: "native", label: "typesafe/jev", reachable: true }),
	judgeUse: null,
	judgeAdvisory: false,
	test: null,
	bench: null,
	limit: "12",
	folder: true,
	...over,
});

const request = (over: Partial<BakeoffFormValues> = {}) => {
	const made = buildBakeoffCreate(values(over));
	if ("error" in made) throw new Error(made.error);
	return made.request;
};
const error = (over: Partial<BakeoffFormValues> = {}) => {
	const made = buildBakeoffCreate(values(over));
	return "error" in made ? made.error : null;
};

describe("whether a folder is a git repository", () => {
	it("assumes one when the companion cannot tell, whatever the folder is", () => {
		expect(isGitFolder("/work/notes", false, null)).toBe(true);
		expect(isGitFolder("", false, null)).toBe(true);
		expect(isGitFolder("/work/notes", false, folder())).toBe(true);
	});

	it("takes a scratch folder and the no-project choice as plain folders for a companion that can tell", () => {
		expect(isGitFolder("", true, null)).toBe(false);
		expect(isGitFolder("/Users/me/.omp/scratch/2026-01-02-notes-a1b2c3", true, null)).toBe(false);
	});

	it("follows what the companion said of any other folder, and assumes a repository until it has", () => {
		expect(isGitFolder("/work/repo", true, null)).toBe(true);
		expect(isGitFolder("/work/repo", true, folder({ git: true }))).toBe(true);
		expect(isGitFolder("/work/repo", true, folder({ git: false }))).toBe(false);
	});
});

describe("the request a folder's form makes", () => {
	it("asks for a design from a pasted document, with no ref, base or pull request", () => {
		const made = request({ doc: { source: "paste", name: " Queue ", text: " Use a queue. " } });
		expect(made.mode).toBe("design");
		expect(made.cwd).toBe("/work/notes");
		expect(made.doc).toEqual({ text: "Use a queue.", name: "Queue" });
		expect("ref" in made).toBe(false);
		expect("base" in made).toBe(false);
		expect("pr" in made).toBe(false);
		expect("start" in made).toBe(false);
		expect("test" in made).toBe(false);
		expect("bench" in made).toBe(false);
	});

	it("asks for a design from a text file of the folder", () => {
		const made = request({ doc: { source: "file", path: " notes/design.md " } });
		expect(made.doc).toEqual({ path: "notes/design.md" });
		expect("ref" in made).toBe(false);
		expect("base" in made).toBe(false);
	});

	it("names the session only when the conversation box is ticked", () => {
		expect(request({ useConversation: true }).sessionId).toBe("s-1");
		expect("sessionId" in request({ useConversation: false })).toBe(false);
		expect("sessionId" in request({ useConversation: true, sessionId: null })).toBe(false);
	});

	it("needs the design", () => {
		expect(error({ doc: null })).toBe("Add the design: paste it or name a file.");
		expect(error({ doc: { source: "paste", name: "", text: "  " } })).toBe("The design is empty.");
	});

	it("keeps a file path inside the folder, in words about the folder", () => {
		for (const path of ["/etc/passwd", "../outside.md", "a/../../b.md"]) {
			expect(error({ doc: { source: "file", path } })).toBe(
				"The design's file must be inside the folder: give its path from the folder's top.",
			);
		}
		expect(error({ doc: { source: "file", path: "" } })).toBe("Name the file of the design.");
	});

	it("refuses an implementation with a clear message", () => {
		expect(error({ mode: "implementation" })).toBe(
			"An implementation needs a git repository, and this folder is not one: compare a design instead.",
		);
	});

	it("refuses a change, a branch or a pull request as the subject", () => {
		const message =
			"This folder is not a git repository, so there are no changes to compare: give a design document.";
		expect(error({ subject: { kind: "changes" } })).toBe(message);
		expect(error({ subject: { kind: "branch", name: "main" } })).toBe(message);
		expect(error({ subject: { kind: "pr", number: 4, title: "x" } })).toBe(message);
		expect(validateBakeoff(values({ subject: { kind: "changes" } }))).toContain(message);
	});

	it("leaves a repository's form as it was", () => {
		const repo = values({ folder: undefined, subject: { kind: "changes" }, doc: null });
		const made = buildBakeoffCreate(repo);
		if ("error" in made) throw new Error(made.error);
		expect(made.request.ref).toBe("@worktree");
		expect(made.request.base).toBe("@default");
		expect(validateBakeoff(values({ folder: undefined, mode: "implementation" }))).toContain(
			"An implementation needs a change to start from: pick this session's changes, a branch or a pull request.",
		);
	});
});

describe("what a failed list says", () => {
	it("explains a plain folder an old companion cannot take, in words", () => {
		const said = friendlyListError("not a git repository", false);
		expect(said).toBe(
			"Bake-offs need a git repository here, and this computer's companion cannot make them for a plain folder yet. Update omp on that computer.",
		);
		expect(friendlyListError("fatal: Not a git repository (or any parent)", false)).toBe(said);
	});

	it("keeps any other message, and every message of a companion that takes a folder", () => {
		expect(friendlyListError("Request timed out.", false)).toBe("Request timed out.");
		expect(friendlyListError("not a git repository", true)).toBe("not a git repository");
	});
});

const host: CompanionHost = {
	instanceId: "inst-7",
	sessionId: "session-7",
	sessionName: "notes",
	cwd: "/work/notes",
	model: null,
	startedAt: 0,
	participants: 1,
	busy: false,
	inputRequired: false,
	relayConnected: true,
};

const stops: Array<() => void> = [];
afterEach(() => {
	for (const stop of stops.splice(0)) stop();
});

/** A companion room over the local relay whose hello carries `capabilities`, and a client paired to it. */
async function connect(capabilities: { canBakeoff?: boolean; canBakeoffFolder?: boolean }): Promise<CompanionClient> {
	const relay = startLocalRelay(0);
	stops.push(() => relay.stop());
	const rawKey = generateRoomKey();
	const link = formatCollabLink(relay.url, generateRoomId(), rawKey);
	const room = parseCollabLink(link);
	if ("error" in room) throw new Error(room.error);
	const socket = new CollabSocket<CompanionReply, CompanionRequest>({
		wsUrl: room.wsUrl,
		role: "host",
		key: importRoomKey(rawKey),
	});
	stops.push(() => socket.close());
	socket.onFrame = (frame, peer) => {
		if (frame.t !== "auth") return;
		socket.send({ t: "authed", deviceId: `device-${peer}` }, peer);
		socket.send({ t: "hosts", machine: "mock", hosts: [host], idle: [], vapidKey: "", ...capabilities }, peer);
	};
	socket.connect();
	const client = new CompanionClient({ link }, () => {});
	stops.push(() => client.close());
	const live = new Promise<void>(resolve => {
		const stop = client.subscribe(() => {
			if (client.getSnapshot().phase !== "live") return;
			stop();
			resolve();
		});
	});
	client.connect();
	await live;
	return client;
}

describe("a companion that predates bake-offs of a folder (compatibility)", () => {
	it("reads no canBakeoffFolder in its hello as false, with canBakeoff as sent", async () => {
		expect(INITIAL_SNAPSHOT.canBakeoffFolder).toBe(false);
		const { canBakeoff, canBakeoffFolder } = (await connect({ canBakeoff: true })).getSnapshot();
		expect(canBakeoff).toBe(true);
		expect(canBakeoffFolder).toBe(false);
	});

	it("assumes a git repository for a scratch folder, and words its refusal", async () => {
		const { canBakeoffFolder } = (await connect({ canBakeoff: true })).getSnapshot();
		expect(isGitFolder("/Users/me/.omp/scratch/2026-01-02-notes-a1b2c3", canBakeoffFolder, null)).toBe(true);
		expect(friendlyListError("not a git repository", canBakeoffFolder)).toContain("Update omp on that computer.");
	});

	it("reads canBakeoffFolder as sent once the hello carries it", async () => {
		const { canBakeoffFolder } = (await connect({ canBakeoff: true, canBakeoffFolder: true })).getSnapshot();
		expect(canBakeoffFolder).toBe(true);
		expect(isGitFolder("/Users/me/.omp/scratch/2026-01-02-notes-a1b2c3", canBakeoffFolder, null)).toBe(false);
	});
});
