import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CompanionClient, type CompanionHost, type CompanionReply, type CompanionRequest } from "../src/lib/companion";
import { generateRoomKey, importRoomKey } from "../src/lib/codec";
import { formatCollabLink, generateRoomId, parseCollabLink } from "../src/lib/link";
import { CollabSocket } from "../src/lib/socket";
import { startLocalRelay } from "../scripts/local-relay";
import { createMockDisk } from "../scripts/mock-disk";

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

/**
 * A companion room over the local relay and a client paired to it. `disk: true` is a companion with the disk guard
 * (the mock's canned one); `false` answers like one that predates it: its `hosts` frame carries nothing about disks and
 * it does not know the requests.
 */
async function connect(options: { disk: boolean }) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "disk-client-test-"));
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
	const disk = options.disk ? await createMockDisk({ dir, onChange: () => {} }) : null;
	socket.onFrame = (frame, peer) => {
		if (frame.t === "auth") {
			peers.add(peer);
			socket.send({ t: "authed", deviceId: `device-${peer}` }, peer);
			socket.send(
				{ t: "hosts", machine: "mock", hosts: [host], idle: [], vapidKey: "", ...disk?.hostsFields() },
				peer,
			);
			return;
		}
		if (!("reqId" in frame)) return;
		const answer = disk?.handles(frame) ? disk.answer(frame) : Promise.reject(new Error("unhandled"));
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
	return { client, dir };
}

describe("the companion client's disk guard", () => {
	it("reads canDiskGuard and the low-space warning from the hosts frame", async () => {
		const { client } = await connect({ disk: true });
		const snap = client.getSnapshot();
		expect(snap.canDiskGuard).toBe(true);
		expect(snap.disk).toMatchObject({ freeBytes: 6_300_000_000, limitBytes: 40_000_000_000 });
	});

	it("reads an older companion's frame as no capability and no warning: nothing shows", async () => {
		const { client } = await connect({ disk: false });
		const snap = client.getSnapshot();
		expect(snap.canDiskGuard).toBe(false);
		expect(snap.disk).toBeNull();
	});

	it("reads the guard's state: settings (40 GB, off, 6 h), the low volume and the recent cleans", async () => {
		const { client } = await connect({ disk: true });
		const state = await client.diskGuard();
		expect(state.settings).toEqual({ limitGb: 40, autoClean: false, idleHours: 6 });
		expect(state.volumes[0]).toMatchObject({ low: true, freeBytes: 6_300_000_000 });
		expect(state.cleans.length).toBeGreaterThan(0);
		expect(state.cleans[0]).toMatchObject({ trigger: expect.stringMatching(/auto|manual/) });
	});

	it("saves settings on the computer, and refuses an invalid one with the reason", async () => {
		const { client, dir } = await connect({ disk: true });
		const saved = await client.diskGuard({ limitGb: 60, autoClean: true, idleHours: 12 });
		expect(saved.settings).toEqual({ limitGb: 60, autoClean: true, idleHours: 12 });
		expect((await client.diskGuard()).settings.limitGb).toBe(60);
		expect(JSON.parse(await Bun.file(path.join(dir, "collab-companion-disk.json")).text()).settings.limitGb).toBe(60);
		await expect(client.diskGuard({ limitGb: 0, autoClean: true, idleHours: 12 })).rejects.toThrow("invalid limitGb");
	});

	it("scans the candidates with path, size, idle time and the reason one is skipped", async () => {
		const { client } = await connect({ disk: true });
		const scan = await client.diskScan();
		const skips = scan.candidates.map(candidate => candidate.skip);
		expect(skips).toContain("busy");
		expect(skips).toContain("recent");
		expect(skips).toContain(null);
		for (const candidate of scan.candidates) {
			expect(candidate.path.startsWith("/")).toBe(true);
			expect(candidate.idleMs).toBeGreaterThan(0);
			if (candidate.skip !== null) expect(candidate.why).toBeTruthy();
		}
	});

	it("cleans what was picked, gives the space back, and refuses the busy one", async () => {
		const { client } = await connect({ disk: true });
		const scan = await client.diskScan();
		const free = scan.candidates.find(candidate => candidate.skip === null && candidate.sized);
		const busy = scan.candidates.find(candidate => candidate.skip === "busy");
		if (free === undefined || busy === undefined) throw new Error("the mock has no free and busy candidate");
		const before = scan.volumes[0]?.freeBytes ?? 0;
		const done = await client.diskClean([free.path, busy.path]);
		expect(done.cleans).toHaveLength(1);
		expect(done.cleans[0]).toMatchObject({ path: free.path, trigger: "manual", bytes: free.bytes });
		expect(done.refused).toEqual([{ path: busy.path, reason: busy.why ?? "" }]);
		expect(done.volumes[0]?.freeBytes).toBe(before + free.bytes);
		const after = await client.diskScan();
		expect(after.candidates.some(candidate => candidate.path === free.path)).toBe(false);
		expect((await client.diskGuard()).cleans[0]?.path).toBe(free.path);
	});

	it("an older companion answers the request with an error, not a hang", async () => {
		const { client } = await connect({ disk: false });
		await expect(client.diskGuard()).rejects.toThrow();
	});
});
