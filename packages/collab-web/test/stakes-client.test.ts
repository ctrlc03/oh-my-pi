import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { StakesStatus } from "@oh-my-pi/pi-wire/stakes";
import { CompanionClient, type CompanionHost, type CompanionReply, type CompanionRequest } from "../src/lib/companion";
import { generateRoomKey, importRoomKey } from "../src/lib/codec";
import { formatCollabLink, generateRoomId, parseCollabLink } from "../src/lib/link";
import { CollabSocket } from "../src/lib/socket";
import { startLocalRelay } from "../scripts/local-relay";
import { createMockQuiz, type MockQuiz } from "../scripts/mock-quiz";
import { createMockStakes } from "../scripts/mock-stakes";

const host: CompanionHost = {
	instanceId: "inst-7",
	sessionId: "session-7",
	sessionName: "api-pagination",
	cwd: "/work/api-pagination",
	model: null,
	startedAt: 0,
	participants: 1,
	busy: false,
	inputRequired: false,
	relayConnected: true,
};

const stops: Array<() => void> = [];
const dirs: string[] = [];

afterEach(async () => {
	for (const stop of stops.splice(0)) stop();
	for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

/** The `stakes-set` request the companion last saw: what the client put on the wire. */
function lastStakesSet(seen: readonly CompanionRequest[]): Extract<CompanionRequest, { t: "stakes-set" }> {
	const last = seen.at(-1);
	if (last?.t !== "stakes-set") throw new Error(`the last request was ${last?.t}, not stakes-set`);
	return last;
}

/** A companion room over the local relay, answering like scripts/mock-companion.ts, and a client paired to it. */
async function connect(options: { enabled: boolean }) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stakes-client-test-"));
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
	const peers = new Set<number>();
	const seen: CompanionRequest[] = [];
	let quiz: MockQuiz | undefined;
	const stakes = createMockStakes({
		enabled: options.enabled,
		dir,
		hosts: [host],
		idle: [],
		initiallyOn: ["inst-7"],
		marker: undefined,
		addQuiz: (id, sessionId, delta) => quiz?.addStakesQuiz(id, sessionId, delta),
		broadcastFrame: frame => {
			for (const peer of peers) socket.send(frame, peer);
		},
		onHostsChanged: () => {},
	});
	quiz = createMockQuiz({ instanceId: "inst-7", stakes: stakes.quizHook, onChanged: () => {} });
	stops.push(() => quiz?.stop());
	socket.onFrame = (frame, peer) => {
		if (frame.t === "auth") {
			peers.add(peer);
			socket.send({ t: "authed", deviceId: `device-${peer}` }, peer);
			socket.send(
				{
					t: "hosts",
					machine: "mock",
					hosts: stakes.decorate([host]),
					idle: [],
					vapidKey: "",
					canQuiz: true,
					...stakes.capabilities,
				},
				peer,
			);
			return;
		}
		if (!("reqId" in frame)) return;
		seen.push(frame);
		const answer = stakes.handles(frame) ? stakes.answer(frame, "device-1") : Promise.reject(new Error("unhandled"));
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
	return { client, seen };
}

describe("the companion client's high-stakes requests", () => {
	it("reads canHighStakes from the hello, and the host row's highStakes", async () => {
		const { client } = await connect({ enabled: true });
		const snap = client.getSnapshot();
		expect(snap.canHighStakes).toBe(true);
		expect(snap.hosts[0]?.highStakes).toBe(true);
	});

	it("reads an older companion's hello as no capability and no mode", async () => {
		const { client } = await connect({ enabled: false });
		const snap = client.getSnapshot();
		expect(snap.canHighStakes).toBe(false);
		expect(snap.hosts[0]?.highStakes).toBeUndefined();
	});

	it("asks for the status and the quiz of a session, and for the settings", async () => {
		const { client, seen } = await connect({ enabled: true });
		const status: StakesStatus = await client.stakesStatus("inst-7");
		expect(status).toMatchObject({ on: true, covered: false, needs: "full", passMark: 90 });
		expect(seen.at(-1)).toMatchObject({ t: "stakes-get", instanceId: "inst-7" });
		expect(await client.stakesQuiz("inst-7")).toMatchObject({ delta: false, created: true });
		expect((await client.stakesQuiz("inst-7")).created).toBe(false);
		expect(await client.stakesSettings()).toEqual({ passMark: 90 });
		expect(seen.at(-1)).toMatchObject({ t: "stakes-settings" });
		expect(await client.stakesSettings(75)).toEqual({ passMark: 75 });
		expect(seen.at(-1)).toMatchObject({ t: "stakes-settings", passMark: 75 });
		await expect(client.stakesSettings(101)).rejects.toThrow("whole percent from 50 to 100");
	});

	it("sends confirmOff only when the caller confirms, and the companion's refusal reaches the caller", async () => {
		const { client, seen } = await connect({ enabled: true });
		await expect(client.setHighStakes("inst-7", false)).rejects.toThrow("confirmation");
		expect(lastStakesSet(seen)).toMatchObject({ on: false });
		expect(lastStakesSet(seen).confirmOff).toBeUndefined();
		await expect(client.setHighStakes("inst-7", false, { confirmOff: false })).rejects.toThrow("confirmation");
		expect(lastStakesSet(seen).confirmOff).toBeUndefined();
		const off = await client.setHighStakes("inst-7", false, { confirmOff: true });
		expect(lastStakesSet(seen)).toMatchObject({ on: false, confirmOff: true });
		expect(off).toMatchObject({ on: false, covered: true });
		const on = await client.setHighStakes("inst-7", true);
		expect(lastStakesSet(seen).confirmOff).toBeUndefined();
		expect(on.on).toBe(true);
	});

	it("carries the stakes on a branch review, and calls a listener when the companion pushes stakes-changed", async () => {
		const { client } = await connect({ enabled: true });
		const review = await client.requestReview("inst-7");
		expect(review.stakes).toMatchObject({ on: true, covered: false });
		const changed: string[] = [];
		const stop = client.onStakesChanged(sessionId => changed.push(sessionId));
		// The companion sends the push before it answers the request, on the same connection, so it has arrived by now.
		await client.setHighStakes("inst-7", false, { confirmOff: true });
		expect(changed).toEqual(["session-7"]);
		stop();
		await client.setHighStakes("inst-7", true);
		expect(changed).toEqual(["session-7"]);
	});

	it("refuses a push and a pull request while blocked, with the companion's wording", async () => {
		const { client } = await connect({ enabled: true });
		await expect(client.pushBranch("inst-7")).rejects.toThrow("high-stakes session");
		await expect(client.createPullRequest("inst-7", "t", "b")).rejects.toThrow("high-stakes session");
	});
});
