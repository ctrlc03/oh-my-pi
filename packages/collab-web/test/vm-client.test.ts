import { afterEach, describe, expect, it } from "bun:test";
import {
	CompanionClient,
	type CompanionHost,
	type CompanionReply,
	type CompanionRequest,
	extractPairing,
	formatPairingUrl,
} from "../src/lib/companion";
import { generateRoomKey, importRoomKey } from "../src/lib/codec";
import { encodeBase64Url, formatCollabLink, generateRoomId, parseCollabLink } from "../src/lib/link";
import { CollabSocket } from "../src/lib/socket";
import { startLocalRelay } from "../scripts/local-relay";
import { createMockVm } from "../scripts/mock-vm";

const host: CompanionHost = {
	instanceId: "inst-8",
	sessionId: "session-8",
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

afterEach(() => {
	for (const stop of stops.splice(0)) stop();
});

/** A sleep the test releases by hand: each pending step or action of the mock waits for `release()`. */
function heldSleep() {
	const waiting: Array<() => void> = [];
	const release = (): void => {
		for (const resolve of waiting.splice(0)) resolve();
	};
	return {
		sleep: (_ms: number) => {
			const { promise, resolve } = Promise.withResolvers<void>();
			waiting.push(resolve);
			return promise;
		},
		release,
		/** Releases every step the mock waits on, as often as it takes, until `done` settles. */
		async through(done: Promise<void>): Promise<void> {
			let finished = false;
			void done.then(() => {
				finished = true;
			});
			while (!finished) {
				release();
				await Promise.resolve();
			}
		},
	};
}

/**
 * A companion room over the local relay and a client paired to it. `vm: true` is a companion that runs `omp vm` (the mock's
 * canned one); `false` answers like one without: its `hosts` frame says nothing about VMs and it does not know the requests.
 */
async function connect(options: { vm: boolean; github?: "ready" | "missing" }) {
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
	const pairLink = formatCollabLink(relay.url, generateRoomId(), generateRoomKey());
	const pairUrl = formatPairingUrl(
		"https://my.omp.sh/",
		pairLink,
		encodeBase64Url(crypto.getRandomValues(new Uint8Array(16))),
	);
	const held = heldSleep();
	let changed: () => void = () => {};
	const vm = options.vm
		? createMockVm({ github: options.github, sleep: held.sleep, pairUrl: () => pairUrl, onChange: () => changed() })
		: undefined;
	socket.onFrame = (frame, peer) => {
		if (frame.t === "auth") {
			socket.send({ t: "authed", deviceId: `device-${peer}` }, peer);
			socket.send(
				{ t: "hosts", machine: "mock", hosts: [host], idle: [], vapidKey: "", ...vm?.hostsFields() },
				peer,
			);
			return;
		}
		if (!("reqId" in frame)) return;
		const answer = vm?.handles(frame) ? vm.answer(frame) : Promise.reject(new Error("unhandled"));
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
	const { promise: live, resolve: goneLive } = Promise.withResolvers<void>();
	const stopWaiting = client.subscribe(() => {
		if (client.getSnapshot().phase !== "live") return;
		stopWaiting();
		goneLive();
	});
	client.connect();
	await live;
	/** Resolves at the mock's next change (a job finished). */
	const nextChange = (): Promise<void> => {
		const { promise, resolve } = Promise.withResolvers<void>();
		changed = resolve;
		return promise;
	};
	return { client, held, pairLink, nextChange };
}

describe("the companion client's virtual machines", () => {
	it("reads canVms from the hosts frame, true with a companion that runs omp vm", async () => {
		const { client } = await connect({ vm: true });
		expect(client.getSnapshot().canVms).toBe(true);
	});

	it("reads an older companion's frame as no capability, and its answer to a request as an error", async () => {
		const { client } = await connect({ vm: false });
		expect(client.getSnapshot().canVms).toBe(false);
		await expect(client.vmList()).rejects.toThrow();
	});

	it("lists the VMs with their repositories and status, and what is missing to create one", async () => {
		const { client } = await connect({ vm: true, github: "missing" });
		const { ready, vms } = await client.vmList();
		expect(ready.ok).toBe(false);
		expect(ready.reason).toBeTruthy();
		expect(ready.github.configured).toBe(false);
		expect(vms.map(vm => [vm.name, vm.status, vm.repos[0]])).toEqual([
			["oh-my-pi", "running", "ctrlc03/oh-my-pi"],
			["scratch", "stopped", "ctrlc03/scratch"],
		]);
		await expect(client.vmCreate({ name: "new-vm", repos: ["ctrlc03/new"] })).rejects.toThrow(ready.reason ?? "");
	});

	it("creates a VM: accepted at once, busy with a step while it runs, then running with a pairing link to pair", async () => {
		const { client, held, pairLink, nextChange } = await connect({ vm: true });
		const created = nextChange();
		await client.vmCreate({
			name: "web",
			repos: ["ctrlc03/web"],
			cpus: 2,
			memoryGiB: 4,
			diskGiB: 20,
			network: "allowlist",
			dailyCostUsd: 3,
		});
		const during = (await client.vmList()).vms.find(vm => vm.name === "web");
		expect(during).toMatchObject({
			status: "creating",
			cpus: 2,
			memoryGiB: 4,
			network: "allowlist",
			budget: { dailyCostUsd: 3 },
			busy: { action: "create" },
		});
		expect(during?.busy?.message).toBeTruthy();
		expect(during?.pairUrl).toBeUndefined();

		// Every step takes its time until it is released.
		await held.through(created);
		const after = (await client.vmList()).vms.find(vm => vm.name === "web");
		expect(after?.status).toBe("running");
		expect(after?.busy).toBeUndefined();
		expect(extractPairing(after?.pairUrl ?? "")?.link).toBe(pairLink);
	});

	it("refuses a second action on a VM that is busy and a duplicate or invalid create", async () => {
		const { client, held, nextChange } = await connect({ vm: true });
		const stopped = nextChange();
		await client.vmAction("oh-my-pi", "stop");
		await expect(client.vmAction("oh-my-pi", "delete")).rejects.toThrow("oh-my-pi is busy");
		expect((await client.vmList()).vms.find(vm => vm.name === "oh-my-pi")?.busy?.action).toBe("stop");
		await held.through(stopped);
		expect((await client.vmList()).vms.find(vm => vm.name === "oh-my-pi")).toMatchObject({ status: "stopped" });

		await expect(client.vmCreate({ name: "scratch", repos: ["a/b"] })).rejects.toThrow("scratch already exists");
		await expect(client.vmCreate({ name: "Bad Name", repos: ["a/b"] })).rejects.toThrow("name");
		await expect(client.vmAction("ghost", "start")).rejects.toThrow("no VM named ghost");
	});

	it("starts, resets and deletes VMs", async () => {
		const { client, held, nextChange } = await connect({ vm: true });
		const statusOf = async (name: string) => (await client.vmList()).vms.find(vm => vm.name === name)?.status;
		let changed = nextChange();
		await client.vmAction("scratch", "start");
		await held.through(changed);
		expect(await statusOf("scratch")).toBe("running");

		changed = nextChange();
		await client.vmAction("scratch", "reset");
		await held.through(changed);
		expect((await client.vmList()).vms.find(vm => vm.name === "scratch")?.pairUrl).toBeTruthy();

		changed = nextChange();
		await client.vmAction("scratch", "delete");
		await held.through(changed);
		expect(await statusOf("scratch")).toBeUndefined();
	});

	it("pairs a VM: a fresh link the app can take, and the link left by a create is used up", async () => {
		const { client, held, pairLink, nextChange } = await connect({ vm: true });
		const reset = nextChange();
		await client.vmAction("oh-my-pi", "reset");
		await held.through(reset);
		expect((await client.vmList()).vms.find(vm => vm.name === "oh-my-pi")?.pairUrl).toBeTruthy();

		const { url, expiresAt } = await client.vmPair("oh-my-pi");
		expect(extractPairing(url)?.link).toBe(pairLink);
		expect(expiresAt).toBeGreaterThan(Date.now());
		expect((await client.vmList()).vms.find(vm => vm.name === "oh-my-pi")?.pairUrl).toBeUndefined();
	});
});
