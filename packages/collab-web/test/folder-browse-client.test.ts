import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { generateRoomKey, importRoomKey } from "../src/lib/codec";
import {
	CompanionClient,
	type CompanionHost,
	INITIAL_SNAPSHOT,
	type CompanionReply,
	type CompanionRequest,
} from "../src/lib/companion";
import { formatCollabLink, generateRoomId, parseCollabLink } from "../src/lib/link";
import { CollabSocket } from "../src/lib/socket";
import { startLocalRelay } from "../scripts/local-relay";
import { createMockForeign } from "../scripts/mock-foreign";
import { createMockStart } from "../scripts/mock-start";

const stops: Array<() => void> = [];
const dirs: string[] = [];

afterEach(async () => {
	for (const stop of stops.splice(0)) stop();
	for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

/** A companion room over the local relay answering with the mock's real browsing code, and a client paired to it. */
async function connect(options: { browse: boolean }) {
	const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "browse-client-test-")));
	dirs.push(dir);
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
	const hosts: CompanionHost[] = [];
	const starts = createMockStart({
		dir,
		hosts,
		baseFolders: async () => [],
		onChange: () => {},
		foreign: createMockForeign({ hosts }),
	});
	const seen: CompanionRequest[] = [];
	socket.onFrame = (frame, peer) => {
		if (frame.t === "auth") {
			socket.send({ t: "authed", deviceId: `device-${peer}` }, peer);
			// An older companion sends no `canBrowseFolders`.
			const { canBrowseFolders, ...older } = starts.capabilities;
			socket.send(
				{
					t: "hosts",
					machine: "mock",
					hosts: [],
					idle: [],
					vapidKey: "",
					...(options.browse ? { canBrowseFolders } : older),
				},
				peer,
			);
			return;
		}
		if (!("reqId" in frame)) return;
		seen.push(frame);
		const answer = starts.handles(frame) ? starts.answer(frame) : Promise.reject(new Error("unhandled"));
		answer.then(
			reply => socket.send(reply, peer),
			(err: unknown) =>
				socket.send(
					{ t: "error", reqId: frame.reqId, message: err instanceof Error ? err.message : String(err) },
					peer,
				),
		);
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
	return { client, seen, home: path.join(dir, "home") };
}

describe("the companion client's folder browsing", () => {
	it("reads canBrowseFolders from the hello; an older companion has none", async () => {
		expect(INITIAL_SNAPSHOT.canBrowseFolders).toBe(false);
		expect((await connect({ browse: true })).client.getSnapshot().canBrowseFolders).toBe(true);
		expect((await connect({ browse: false })).client.getSnapshot().canBrowseFolders).toBe(false);
	});

	it("asks with the path and hidden flag as given, and returns the listing the companion sent", async () => {
		const { client, seen, home } = await connect({ browse: true });
		const first = await client.requestBrowseFolders();
		expect(seen.at(-1)).toMatchObject({ t: "browse-folders" });
		expect(first.path).toBe(home);
		expect(first.parent).toBe(path.dirname(home));
		expect(first.folders.map(folder => folder.name)).toEqual([
			"big",
			"code",
			"Desktop",
			"Documents",
			"Downloads",
			"empty",
			"projects",
		]);
		expect(first.truncated).toBe(false);

		const hidden = await client.requestBrowseFolders("~", true);
		expect(seen.at(-1)).toMatchObject({ t: "browse-folders", path: "~", hidden: true });
		expect(hidden.folders.map(folder => folder.name)).toContain(".config");

		const code = await client.requestBrowseFolders("~/code");
		expect(code.path).toBe(path.join(home, "code"));
		expect(code.folders.map(folder => [folder.name, folder.git])).toEqual([
			["api-server", true],
			["Archive", false],
			["notes", false],
			["web-app", true],
		]);
		const big = await client.requestBrowseFolders("~/big");
		expect(big.folders).toHaveLength(500);
		expect(big.truncated).toBe(true);
	});

	it("rejects with the companion's words for a path that is missing or not a folder", async () => {
		const { client, home } = await connect({ browse: true });
		await expect(client.requestBrowseFolders("~/nope")).rejects.toThrow(`${path.join(home, "nope")} does not exist`);
		await expect(client.requestBrowseFolders("~/README.txt")).rejects.toThrow("is not a folder");
	});

	it("starts only in a folder that exists, ~ included", async () => {
		const { client } = await connect({ browse: true });
		await expect(client.startSession("~/typo", {})).rejects.toThrow("does not exist");
		await expect(client.startSession("~/README.txt", {})).rejects.toThrow("is not a folder");
		expect(await client.startSession("~/code/api-server", {})).toMatch(/^start-1-/);
	});
});
