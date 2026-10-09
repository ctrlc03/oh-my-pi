import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as crypto from "node:crypto";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
	COLLAB_IDLE_REGISTRY_VERSION,
	COLLAB_REGISTRY_VERSION,
	type CollabHostPublication,
	type CollabHostRegistrySource,
	type CollabHostSnapshot,
	type CollabIdleRegistrySource,
	type CollabIdleSnapshot,
	CollabLinkError,
	listCollabHosts,
	listCollabSessions,
	publishCollabHost,
	publishCollabIdle,
	resolveCollabHostLink,
	startCollabSession,
} from "@oh-my-pi/pi-coding-agent/collab/registry";

const cleanupDirs: string[] = [];
const openPublications: CollabHostPublication[] = [];
const openServers: { server: net.Server; sockets: Set<net.Socket> }[] = [];

afterEach(async () => {
	for (const pub of openPublications.splice(0)) {
		try {
			await pub.close();
		} catch {
			// best-effort
		}
	}
	for (const { server, sockets } of openServers.splice(0)) {
		// Hung fixture sockets must not keep server.close() waiting forever.
		for (const socket of sockets) socket.destroy();
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		await closed.promise;
	}
	for (const dir of cleanupDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-registry-"));
	cleanupDirs.push(dir);
	return dir;
}

interface Fixture {
	snapshot: CollabHostSnapshot;
	roomKey: string;
	writeToken: string;
	controlUrl: string;
	viewUrl: string;
}

function makeFixture(over: Partial<CollabHostSnapshot> = {}): Fixture {
	const roomKey = `ROOMKEY-${crypto.randomBytes(6).toString("hex")}`;
	const writeToken = `WRITETOKEN-${crypto.randomBytes(6).toString("hex")}`;
	return {
		snapshot: {
			instanceId: crypto.randomBytes(8).toString("hex"),
			generation: 1,
			sessionId: `sess-${crypto.randomBytes(4).toString("hex")}`,
			sessionName: "Fixture Session",
			cwd: "/tmp/fixture-cwd",
			pid: process.pid,
			model: { provider: "test", id: "fixture-model" },
			startedAt: 1_700_000_000_000,
			participants: 3,
			relayConnected: true,
			inputRequired: false,
			busy: false,
			access: "control",
			...over,
		},
		roomKey,
		writeToken,
		controlUrl: `https://collab.example/control/#room=${roomKey}&k=${writeToken}`,
		viewUrl: `https://collab.example/view/#room=${roomKey}`,
	};
}

function sourceFor(f: Fixture): CollabHostRegistrySource {
	return {
		snapshot: () => f.snapshot,
		link: access => (access === "view" ? f.viewUrl : f.snapshot.access === "control" ? f.controlUrl : null),
	};
}

async function publish(dir: string, f: Fixture): Promise<CollabHostPublication> {
	const pub = await publishCollabHost(sourceFor(f), { dir, instanceId: f.snapshot.instanceId });
	openPublications.push(pub);
	return pub;
}

/** Reads the discovery token from the single metadata file in `dir`. */
async function readSoleToken(dir: string): Promise<string> {
	const names = (await fs.readdir(dir)).filter(n => n.endsWith(".json"));
	expect(names).toHaveLength(1);
	const [name] = names;
	if (!name) throw new Error("published registry metadata is missing");
	const meta = await Bun.file(path.join(dir, name)).json();
	return meta.token as string;
}

/** Connects to `endpoint`, sends one JSON request line, returns the raw response line. */
function rawRequest(endpoint: string, request: object): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	let buffer = "";
	const socket = net.createConnection({ path: endpoint });
	const done = (fn: () => void): void => {
		socket.destroy();
		fn();
	};
	socket.setEncoding("utf8");
	socket.once("error", err => done(() => reject(err)));
	socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
	socket.on("data", chunk => {
		buffer += chunk;
		const nl = buffer.indexOf("\n");
		if (nl >= 0) done(() => resolve(buffer.slice(0, nl)));
	});
	return promise;
}

function auxEndpoint(dir: string, label: string): string {
	const id = crypto.randomBytes(4).toString("hex");
	return process.platform === "win32"
		? `\\\\.\\pipe\\omp-collab-test-${label}-${id}`
		: path.join(dir, `${label}-${id}.sock`);
}

async function writeMetadata(dir: string, name: string, meta: Record<string, unknown>): Promise<void> {
	await Bun.write(
		path.join(dir, name),
		JSON.stringify({ instanceId: crypto.randomBytes(8).toString("hex"), ...meta }),
	);
}

function freshDeadPid(): number {
	// The child has exited by the time spawnSync returns: a real, dead PID.
	return Bun.spawnSync([process.execPath, "-e", ""]).pid;
}

async function collectRegularFiles(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await collectRegularFiles(full)));
		else if (entry.isFile()) out.push(full);
	}
	return out;
}

describe("collab registry", () => {
	it("lists metadata without capabilities and resolves only the requested access by instance ID", async () => {
		const dir = await tempDir();
		const f = makeFixture();
		await publish(dir, f);

		const hosts = await listCollabHosts({ dir });
		expect(hosts.map(host => host.instanceId)).toEqual([f.snapshot.instanceId]);
		expect(hosts[0]).not.toHaveProperty("url");
		expect(JSON.stringify(hosts)).not.toContain(f.roomKey);
		expect(JSON.stringify(hosts)).not.toContain(f.writeToken);

		expect(await resolveCollabHostLink(f.snapshot.instanceId, "control", { dir })).toEqual({
			instanceId: f.snapshot.instanceId,
			generation: f.snapshot.generation,
			access: "control",
			url: f.controlUrl,
		});
		const view = await resolveCollabHostLink(f.snapshot.instanceId, "view", { dir });
		expect(view).toEqual({
			instanceId: f.snapshot.instanceId,
			generation: f.snapshot.generation,
			access: "view",
			url: f.viewUrl,
		});
		expect(JSON.stringify(view)).not.toContain(f.controlUrl);
		expect(JSON.stringify(view)).not.toContain(f.writeToken);
	});

	it("returns only the requested URL on the link wire, never the control capability to a view request", async () => {
		const dir = await tempDir();
		const f = makeFixture();
		const pub = await publish(dir, f);
		const request = { v: COLLAB_REGISTRY_VERSION, token: await readSoleToken(dir), op: "link", generation: 1 };

		const control = await rawRequest(pub.endpoint, { ...request, access: "control" });
		expect(JSON.parse(control)).toEqual({ ok: true, v: COLLAB_REGISTRY_VERSION, url: f.controlUrl });
		const view = await rawRequest(pub.endpoint, { ...request, access: "view" });
		expect(JSON.parse(view)).toEqual({ ok: true, v: COLLAB_REGISTRY_VERSION, url: f.viewUrl });
		expect(view).not.toContain(f.controlUrl);
		expect(view).not.toContain(f.writeToken);
	});

	it("refuses control access to a view-only host through resolution and the wire", async () => {
		const dir = await tempDir();
		const f = makeFixture({ access: "view" });
		const pub = await publish(dir, f);

		await expect(resolveCollabHostLink(f.snapshot.instanceId, "control", { dir })).rejects.toMatchObject({
			name: "CollabLinkError",
			code: "access_unavailable",
		});
		const line = await rawRequest(pub.endpoint, {
			v: COLLAB_REGISTRY_VERSION,
			token: await readSoleToken(dir),
			op: "link",
			access: "control",
			generation: f.snapshot.generation,
		});
		expect(JSON.parse(line)).toEqual({ ok: false, v: COLLAB_REGISTRY_VERSION, error: "access_unavailable" });
		expect(await resolveCollabHostLink(f.snapshot.instanceId, "view", { dir })).toMatchObject({
			access: "view",
			url: f.viewUrl,
		});
	});

	it("rejects a listed generation after the room rotates without returning its successor's URL", async () => {
		const dir = await tempDir();
		const f = makeFixture();
		const pub = await publish(dir, f);
		const [listed] = await listCollabHosts({ dir });
		if (!listed) throw new Error("published host was not discoverable");
		f.snapshot.generation++;

		const line = await rawRequest(pub.endpoint, {
			v: COLLAB_REGISTRY_VERSION,
			token: await readSoleToken(dir),
			op: "link",
			access: "control",
			generation: listed.generation,
		});
		expect(JSON.parse(line)).toEqual({ ok: false, v: COLLAB_REGISTRY_VERSION, error: "stale_generation" });
	});

	it("surfaces stale_generation when the host rotates between resolution's snapshot and link requests", async () => {
		const dir = await tempDir();
		const f = makeFixture();
		const source = sourceFor(f);
		let rotate = false;
		source.snapshot = () => {
			const snapshot = { ...f.snapshot };
			if (rotate) {
				f.snapshot.generation++;
				rotate = false;
			}
			return snapshot;
		};
		openPublications.push(await publishCollabHost(source, { dir, instanceId: f.snapshot.instanceId }));
		await listCollabHosts({ dir });
		rotate = true;

		await expect(resolveCollabHostLink(f.snapshot.instanceId, "control", { dir })).rejects.toMatchObject({
			name: "CollabLinkError",
			code: "stale_generation",
		});
	});

	it("surfaces stale_generation when the room rotated to a new endpoint between resolution's listing and link request", async () => {
		const dir = await tempDir();
		const first = makeFixture({ instanceId: "rotating-endpoint", sessionId: "generation-1" });
		const pub = await publish(dir, first);
		const second = makeFixture({ instanceId: "rotating-endpoint", sessionId: "generation-2", generation: 2 });

		// The listing inside resolution answers from generation 1; the room then
		// rotates — the old endpoint is withdrawn and generation 2 publishes under
		// its own — before the link request connects.
		const realConnect = net.createConnection;
		let connections = 0;
		const connect = spyOn(net, "createConnection").mockImplementation(((options: net.NetConnectOpts) => {
			if (++connections !== 2) return realConnect(options);
			const socket = new net.Socket();
			void pub
				.close()
				.then(() => publish(dir, second))
				.then(() => socket.connect(options));
			return socket;
		}) as typeof net.createConnection);
		try {
			await expect(resolveCollabHostLink("rotating-endpoint", "control", { dir })).rejects.toMatchObject({
				name: "CollabLinkError",
				code: "stale_generation",
			});
		} finally {
			connect.mockRestore();
		}

		// Listing again yields the successor, and only its link.
		expect(await listCollabHosts({ dir })).toMatchObject([{ instanceId: "rotating-endpoint", generation: 2 }]);
		expect(await resolveCollabHostLink("rotating-endpoint", "control", { dir })).toMatchObject({
			generation: 2,
			url: second.controlUrl,
		});
	});

	it("reports stale_generation, not access_unavailable, when a view-only generation rotated to control before the link request", async () => {
		const dir = await tempDir();
		const viewOnly = makeFixture({ instanceId: "upgrading-host", access: "view" });
		const pub = await publish(dir, viewOnly);
		const control = makeFixture({ instanceId: "upgrading-host", generation: 2, access: "control" });

		// The listing sees a view-only generation; a control link is requested;
		// before that request connects the room has rotated to a control-capable
		// generation. The caller must be told to re-list, not that control is
		// unavailable.
		const realConnect = net.createConnection;
		let connections = 0;
		const connect = spyOn(net, "createConnection").mockImplementation(((options: net.NetConnectOpts) => {
			if (++connections !== 2) return realConnect(options);
			const socket = new net.Socket();
			void pub
				.close()
				.then(() => publish(dir, control))
				.then(() => socket.connect(options));
			return socket;
		}) as typeof net.createConnection);
		try {
			await expect(resolveCollabHostLink("upgrading-host", "control", { dir })).rejects.toMatchObject({
				name: "CollabLinkError",
				code: "stale_generation",
			});
		} finally {
			connect.mockRestore();
		}
		expect(await resolveCollabHostLink("upgrading-host", "control", { dir })).toMatchObject({
			generation: 2,
			url: control.controlUrl,
		});
	});

	it("keeps a host with an oversized session name or cwd listable by bounding snapshot fields on the wire", async () => {
		const dir = await tempDir();
		// Each of these alone would push the snapshot JSON past the 64 KiB response cap.
		const f = makeFixture({ sessionName: "n".repeat(100_000), cwd: `/deep/${"d".repeat(100_000)}` });
		await publish(dir, f);

		const hosts = await listCollabHosts({ dir });
		expect(hosts).toHaveLength(1);
		expect(hosts[0]!.sessionName).toBe("n".repeat(1024));
		expect(hosts[0]!.cwd).toBe(`/deep/${"d".repeat(1024 - "/deep/".length)}`);
		expect(await resolveCollabHostLink(f.snapshot.instanceId, "control", { dir })).toMatchObject({
			url: f.controlUrl,
		});
	});

	it("resolves a unique PID and rejects it as ambiguous when a second instance shares the process", async () => {
		const dir = await tempDir();
		const first = makeFixture({ instanceId: "pid-first" });
		await publish(dir, first);
		expect(await resolveCollabHostLink(String(process.pid), "control", { dir })).toMatchObject({
			instanceId: first.snapshot.instanceId,
			url: first.controlUrl,
		});

		await publish(dir, makeFixture({ instanceId: "pid-second" }));
		await expect(resolveCollabHostLink(String(process.pid), "control", { dir })).rejects.toMatchObject({
			name: "CollabLinkError",
			code: "ambiguous",
		});
	});

	it("prefers an exact numeric instance ID over a matching PID", async () => {
		const dir = await tempDir();
		const exact = makeFixture({ instanceId: "99999999" });
		await publish(dir, exact);
		await publish(dir, makeFixture({ instanceId: "numeric-pid", pid: 99_999_999 }));

		expect(await resolveCollabHostLink("99999999", "control", { dir })).toMatchObject({
			instanceId: exact.snapshot.instanceId,
			url: exact.controlUrl,
		});
	});

	it("reports not_found for an unknown selector", async () => {
		const dir = await tempDir();
		await publish(dir, makeFixture());
		await expect(resolveCollabHostLink("missing-host", "control", { dir })).rejects.toMatchObject({
			name: "CollabLinkError",
			code: "not_found",
		});
	});

	it("rejects invalid access and missing or unknown operations without returning capabilities", async () => {
		const dir = await tempDir();
		const f = makeFixture();
		const pub = await publish(dir, f);
		const auth = { v: COLLAB_REGISTRY_VERSION, token: await readSoleToken(dir) };

		const invalidAccess = await rawRequest(pub.endpoint, { ...auth, op: "link", access: "write", generation: 1 });
		expect(JSON.parse(invalidAccess)).toEqual({ ok: false, v: COLLAB_REGISTRY_VERSION, error: "invalid_access" });
		const missingOp = await rawRequest(pub.endpoint, auth);
		expect(JSON.parse(missingOp)).toEqual({ ok: false, v: COLLAB_REGISTRY_VERSION, error: "invalid_operation" });
		const unknownOp = await rawRequest(pub.endpoint, { ...auth, op: "unknown" });
		expect(JSON.parse(unknownOp)).toEqual({ ok: false, v: COLLAB_REGISTRY_VERSION, error: "invalid_operation" });
	});

	it("lists a host that omits busy as unknown and drops one that reports garbage", async () => {
		const dir = await tempDir();
		// An omp older than the `busy` field: same protocol version, one key short.
		const older = makeFixture({ sessionId: "older-host" });
		const { busy: _busy, ...withoutBusy } = older.snapshot;
		openPublications.push(
			await publishCollabHost(
				{ snapshot: () => withoutBusy as CollabHostSnapshot, link: () => null },
				{ dir, instanceId: older.snapshot.instanceId },
			),
		);
		const broken = makeFixture({ sessionId: "broken-host", busy: "yes" as unknown as boolean });
		await publish(dir, broken);

		const hosts = await listCollabHosts({ dir });
		// Unknown, never idle: the older host stays listed with a null flag, and a
		// snapshot that answers with a non-boolean is malformed, not busy.
		expect(hosts.map(host => [host.sessionId, host.busy])).toEqual([["older-host", null]]);
	});

	it("keeps both URLs and room secrets off disk even after resolving links", async () => {
		const dir = await tempDir();
		const f = makeFixture();
		await publish(dir, f);
		await listCollabHosts({ dir });
		await resolveCollabHostLink(f.snapshot.instanceId, "control", { dir });
		await resolveCollabHostLink(f.snapshot.instanceId, "view", { dir });

		const files = await collectRegularFiles(dir);
		expect(files.filter(file => file.endsWith(".json"))).toHaveLength(1);
		for (const file of files) {
			const content = await Bun.file(file).text();
			expect(content).not.toContain(f.controlUrl);
			expect(content).not.toContain(f.viewUrl);
			expect(content).not.toContain(f.roomKey);
			expect(content).not.toContain(f.writeToken);
		}
	});

	it("rejects a wrong bearer without leaking metadata or capabilities", async () => {
		const dir = await tempDir();
		const f = makeFixture();
		const pub = await publish(dir, f);
		const auth = { v: COLLAB_REGISTRY_VERSION, token: "not-the-real-token" };

		const snapshot = await rawRequest(pub.endpoint, { ...auth, op: "snapshot" });
		expect(JSON.parse(snapshot)).toEqual({ ok: false, v: COLLAB_REGISTRY_VERSION, error: "authentication_failed" });
		const link = await rawRequest(pub.endpoint, { ...auth, op: "link", access: "control", generation: 1 });
		expect(JSON.parse(link)).toEqual({ ok: false, v: COLLAB_REGISTRY_VERSION, error: "authentication_failed" });
	});

	it("sorts hosts by startedAt, pid, then instanceId regardless of publication order", async () => {
		const dir = await tempDir();
		const early = makeFixture({ instanceId: "early-host", startedAt: 900, pid: 99 });
		const highPid = makeFixture({ instanceId: "high-pid", startedAt: 1000, pid: 50 });
		const lowId = makeFixture({ instanceId: "tie-alpha", startedAt: 1000, pid: 30 });
		const highId = makeFixture({ instanceId: "tie-bravo", startedAt: 1000, pid: 30 });
		await publish(dir, highPid);
		await publish(dir, highId);
		await publish(dir, early);
		await publish(dir, lowId);

		const hosts = await listCollabHosts({ dir });
		expect(hosts.map(h => h.instanceId)).toEqual(["early-host", "tie-alpha", "tie-bravo", "high-pid"]);
	});

	it("lists healthy hosts, prunes malformed or dead entries, and preserves live incompatible or timed-out entries", async () => {
		const dir = await tempDir();
		await publish(dir, makeFixture({ sessionId: "healthy" }));
		await Bun.write(path.join(dir, "garbage.json"), "{not json");
		await writeMetadata(dir, "version-mismatch.json", {
			version: 99,
			pid: freshDeadPid(),
			endpoint: auxEndpoint(dir, "vmismatch"),
			createdAt: Date.now(),
			token: crypto.randomBytes(16).toString("hex"),
		});
		await writeMetadata(dir, "live-version-mismatch.json", {
			version: 99,
			pid: process.pid,
			endpoint: auxEndpoint(dir, "live-version"),
			createdAt: Date.now(),
			token: crypto.randomBytes(16).toString("hex"),
		});
		await writeMetadata(dir, "stale.json", {
			version: COLLAB_REGISTRY_VERSION,
			pid: freshDeadPid(),
			endpoint: auxEndpoint(dir, "stale-missing"),
			createdAt: Date.now(),
			token: crypto.randomBytes(16).toString("hex"),
		});

		const unresponsiveEndpoint = auxEndpoint(dir, "unresponsive");
		const hungSockets = new Set<net.Socket>();
		const unresponsive = net.createServer(socket => {
			hungSockets.add(socket);
			socket.on("error", () => {});
			socket.once("close", () => hungSockets.delete(socket));
		});
		openServers.push({ server: unresponsive, sockets: hungSockets });
		const listening = Promise.withResolvers<void>();
		unresponsive.once("error", err => listening.reject(err));
		unresponsive.listen(unresponsiveEndpoint, () => listening.resolve());
		await listening.promise;
		await writeMetadata(dir, "unresponsive.json", {
			version: COLLAB_REGISTRY_VERSION,
			pid: process.pid,
			endpoint: unresponsiveEndpoint,
			createdAt: Date.now(),
			token: crypto.randomBytes(16).toString("hex"),
		});

		const hosts = await listCollabHosts({ dir, timeoutMs: 250 });
		expect(hosts.map(h => h.sessionId)).toEqual(["healthy"]);
		const remaining = await fs.readdir(dir);
		expect(remaining).not.toContain("garbage.json");
		expect(remaining).not.toContain("version-mismatch.json");
		expect(remaining).not.toContain("stale.json");
		expect(remaining).toContain("live-version-mismatch.json");
		expect(remaining).toContain("unresponsive.json");
	});

	it("skips a transient connection error without pruning a host that becomes reachable again", async () => {
		const dir = await tempDir();
		const f = makeFixture();
		await publish(dir, f);
		const connect = spyOn(net, "createConnection").mockImplementation(() => {
			const socket = new net.Socket();
			queueMicrotask(() => socket.emit("error", Object.assign(new Error("file limit"), { code: "EMFILE" })));
			return socket;
		});
		try {
			expect(await listCollabHosts({ dir })).toEqual([]);
		} finally {
			connect.mockRestore();
		}

		expect(await resolveCollabHostLink(f.snapshot.instanceId, "control", { dir })).toMatchObject({
			url: f.controlUrl,
		});
	});

	it("does not prune a successor room that republished under the same instance between stale-entry validation and removal", async () => {
		const dir = await tempDir();
		// Stale metadata for generation N whose endpoint is already gone.
		await writeMetadata(dir, "rotating-host.json", {
			version: COLLAB_REGISTRY_VERSION,
			instanceId: "rotating-host",
			pid: process.pid,
			endpoint: path.join(dir, "rotating-host.sock"),
			createdAt: Date.now(),
			token: "stale-token",
		});
		// The listing finds N dead and starts removing it; before its first
		// unlink lands, generation N+1 publishes under the same instance. The
		// removal must only ever hit N's own artifacts.
		const successor = makeFixture({ instanceId: "rotating-host", sessionId: "generation-2" });
		const realRm = nodeFs.promises.rm;
		let republished: Promise<CollabHostPublication> | undefined;
		const rm = spyOn(nodeFs.promises, "rm").mockImplementation(async (target, options) => {
			republished ??= publish(dir, successor);
			await republished;
			return realRm(target, options);
		});
		let hosts: CollabHostSnapshot[];
		try {
			hosts = await listCollabHosts({ dir });
		} finally {
			rm.mockRestore();
		}
		expect(republished).toBeDefined();

		// The stale query yields nothing, N's metadata is gone, and the
		// successor stays listed and linkable.
		expect(hosts).toEqual([]);
		expect(await fs.readdir(dir)).not.toContain("rotating-host.json");
		expect(await listCollabHosts({ dir })).toMatchObject([
			{ instanceId: "rotating-host", sessionId: "generation-2" },
		]);
		expect(await resolveCollabHostLink("rotating-host", "control", { dir })).toMatchObject({
			url: successor.controlUrl,
		});
	});

	it("leaves no artifacts behind when the metadata write fails, and the instance can publish again", async () => {
		const dir = await tempDir();
		const f = makeFixture();
		const realOpen = nodeFs.promises.open;
		const open = spyOn(nodeFs.promises, "open").mockImplementation(async (...args: Parameters<typeof realOpen>) => {
			const handle = await realOpen(...args);
			// The exclusive create succeeded; the write then hits a full disk.
			handle.writeFile = () =>
				Promise.reject(Object.assign(new Error("no space left on device"), { code: "ENOSPC" }));
			return handle;
		});
		try {
			await expect(publish(dir, f)).rejects.toMatchObject({ code: "ENOSPC" });
		} finally {
			open.mockRestore();
		}
		expect(await fs.readdir(dir)).toEqual([]);

		await publish(dir, f);
		expect(await listCollabHosts({ dir })).toMatchObject([{ instanceId: f.snapshot.instanceId }]);
	});

	it("removes metadata and socket and disappears from listings after close", async () => {
		const dir = await tempDir();
		const f = makeFixture();
		const pub = await publish(dir, f);
		expect(await listCollabHosts({ dir })).toHaveLength(1);
		await pub.close();

		expect(await listCollabHosts({ dir })).toEqual([]);
		expect((await fs.readdir(dir)).filter(n => n.endsWith(".json"))).toEqual([]);
		if (process.platform !== "win32") {
			await expect(fs.stat(pub.endpoint)).rejects.toMatchObject({ code: "ENOENT" });
		}
	});

	it("treats endpoint death as authoritative over a reused PID", async () => {
		const dir = await tempDir();
		const forgedFile = "reused-pid.json";
		await writeMetadata(dir, forgedFile, {
			version: COLLAB_REGISTRY_VERSION,
			pid: process.pid,
			endpoint: auxEndpoint(dir, "reused"),
			createdAt: Date.now(),
			token: crypto.randomBytes(16).toString("hex"),
		});

		expect(await listCollabHosts({ dir })).toEqual([]);
		expect(await Bun.file(path.join(dir, forgedFile)).exists()).toBe(false);
	});

	it("cannot duplicate a genuine host using a forged token and does not prune its live endpoint", async () => {
		const dir = await tempDir();
		const f = makeFixture({ sessionId: "genuine" });
		const pub = await publish(dir, f);
		await writeMetadata(dir, "forged.json", {
			version: COLLAB_REGISTRY_VERSION,
			pid: process.pid,
			endpoint: pub.endpoint,
			createdAt: Date.now(),
			token: crypto.randomBytes(16).toString("hex"),
		});

		expect((await listCollabHosts({ dir })).map(host => host.instanceId)).toEqual([f.snapshot.instanceId]);
		expect(await Bun.file(path.join(dir, "forged.json")).exists()).toBe(true);
		expect(await resolveCollabHostLink(f.snapshot.instanceId, "control", { dir })).toMatchObject({
			url: f.controlUrl,
		});
	});

	it.skipIf(process.platform === "win32")("creates an owner-only directory, metadata file, and socket", async () => {
		const dir = path.join(await tempDir(), "r");
		const f = makeFixture();
		const pub = await publish(dir, f);

		expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
		const [metaName] = (await fs.readdir(dir)).filter(n => n.endsWith(".json"));
		expect((await fs.stat(path.join(dir, metaName ?? ""))).mode & 0o777).toBe(0o600);
		expect((await fs.stat(pub.endpoint)).mode & 0o777).toBe(0o600);
	});

	it.skipIf(process.platform === "win32")("tightens a pre-existing 0755 registry directory to 0700", async () => {
		const dir = await tempDir();
		await fs.chmod(dir, 0o755);
		await publish(dir, makeFixture());

		expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
	});

	it("refuses a symlinked registry directory instead of listing or pruning through it", async () => {
		// A planted symlink must not turn listing (which prunes malformed
		// `*.json`) into a way to delete files in an unrelated directory.
		const target = await tempDir();
		const bystander = path.join(target, "important.json");
		await Bun.write(bystander, "{not registry metadata");
		const link = path.join(await tempDir(), "collab-hosts");
		await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
		const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
		if (!descriptor) throw new Error("Missing process.platform descriptor");
		try {
			// Exercise the Windows branch on Unix CI too; native Windows uses a junction.
			for (const platform of new Set([process.platform, "win32"])) {
				Object.defineProperty(process, "platform", { configurable: true, value: platform });
				await expect(listCollabHosts({ dir: link })).rejects.toThrow();
				expect(await Bun.file(bystander).text()).toBe("{not registry metadata");
				await expect(publishCollabHost(sourceFor(makeFixture()), { dir: link })).rejects.toThrow(/symlink/);
				expect(await fs.readdir(target)).toEqual(["important.json"]);
			}
		} finally {
			Object.defineProperty(process, "platform", descriptor);
		}
	});

	it.skipIf(process.platform === "win32")(
		"relocates the socket to a short owner-private directory when the canonical path overflows sun_path",
		async () => {
			// A deep config root pushes `<dir>/<instanceId>.sock` past the 104/108
			// byte socket path limit; the host must still publish, and listers
			// must find it through the endpoint recorded in the metadata.
			const base = await tempDir();
			const dir = path.join(base, "n".repeat(60), "m".repeat(60), "collab-hosts");
			await fs.mkdir(dir, { recursive: true, mode: 0o700 });
			const fallbackBase = await tempDir();
			const f = makeFixture({ instanceId: "deep-config-root" });
			const pub = await publishCollabHost(sourceFor(f), {
				dir,
				instanceId: f.snapshot.instanceId,
				socketFallbackBase: fallbackBase,
			});
			openPublications.push(pub);

			// Relocated under the (short, in production `/tmp`) fallback base, in a
			// deterministic owner-only directory keyed by this registry directory.
			expect(path.dirname(path.dirname(pub.endpoint))).toBe(fallbackBase);
			expect(path.basename(path.dirname(pub.endpoint))).toMatch(/^omp-collab-[0-9a-f]{20}$/);
			expect((await fs.stat(path.dirname(pub.endpoint))).mode & 0o777).toBe(0o700);
			expect(await listCollabHosts({ dir })).toMatchObject([{ instanceId: "deep-config-root" }]);
			expect(await resolveCollabHostLink("deep-config-root", "control", { dir })).toMatchObject({
				url: f.controlUrl,
			});

			await pub.close();
			expect(await fs.readdir(path.dirname(pub.endpoint))).toEqual([]);
			expect(await listCollabHosts({ dir })).toEqual([]);
		},
	);

	describe("idle entries", () => {
		function makeIdle(over: Partial<CollabIdleSnapshot> = {}): CollabIdleSnapshot {
			return {
				instanceId: crypto.randomBytes(8).toString("hex"),
				pid: process.pid,
				sessionId: "idle-session",
				sessionName: null,
				cwd: "/tmp/idle-cwd",
				model: null,
				startedAt: 1_700_000_000_000,
				busy: false,
				...over,
			};
		}

		async function publishIdle(
			dir: string,
			snapshot: CollabIdleSnapshot,
			source: Partial<CollabIdleRegistrySource> = {},
		): Promise<CollabHostPublication> {
			const pub = await publishCollabIdle(
				{
					snapshot: () => snapshot,
					start: async access => ({ generation: 1, access, url: `https://collab.example/${access}/started` }),
					...source,
				},
				{ dir, instanceId: snapshot.instanceId },
			);
			openPublications.push(pub);
			return pub;
		}

		it("lists an idle process under `idle`, never as a host, and tags its metadata with a version old listers skip", async () => {
			const dir = await tempDir();
			const host = makeFixture();
			await publish(dir, host);
			const idle = makeIdle({ sessionId: "not-shared", sessionName: "Quiet", model: { provider: "p", id: "m" } });
			await publishIdle(dir, idle);

			expect((await listCollabHosts({ dir })).map(h => h.instanceId)).toEqual([host.snapshot.instanceId]);
			expect(await listCollabSessions({ dir })).toEqual({ hosts: [host.snapshot], idle: [idle] });

			// An omp that only knows version 1 never connects to, lists, or prunes a
			// live entry whose version it does not recognise.
			const metas = await Promise.all(
				(await fs.readdir(dir))
					.filter(name => name.endsWith(".json"))
					.map(name => Bun.file(path.join(dir, name)).json() as Promise<Record<string, unknown>>),
			);
			const idleMeta = metas.find(meta => meta.instanceId === idle.instanceId);
			expect(idleMeta).toMatchObject({ version: COLLAB_IDLE_REGISTRY_VERSION, kind: "idle", pid: process.pid });
			expect(COLLAB_IDLE_REGISTRY_VERSION).not.toBe(COLLAB_REGISTRY_VERSION);
			expect(metas.find(meta => meta.instanceId === host.snapshot.instanceId)?.version).toBe(
				COLLAB_REGISTRY_VERSION,
			);
		});

		it("starts hosting through the idle endpoint for the requested access and returns that link", async () => {
			const dir = await tempDir();
			const idle = makeIdle();
			const requested: string[] = [];
			await publishIdle(dir, idle, {
				start: async access => {
					requested.push(access);
					return { generation: 4, access, url: `https://collab.example/${access}/room` };
				},
			});

			expect(await startCollabSession(String(process.pid), "control", { dir })).toEqual({
				instanceId: idle.instanceId,
				generation: 4,
				access: "control",
				url: "https://collab.example/control/room",
			});
			expect(await startCollabSession(idle.instanceId, "view", { dir })).toMatchObject({
				access: "view",
				url: "https://collab.example/view/room",
			});
			expect(requested).toEqual(["control", "view"]);
		});

		it("hands out the existing link of a process that is already hosting instead of starting it again", async () => {
			const dir = await tempDir();
			const f = makeFixture();
			await publish(dir, f);
			const start = spyOn(
				{ start: async () => ({ generation: 1, access: "control" as const, url: "unused" }) },
				"start",
			);
			await publishIdle(dir, makeIdle({ instanceId: f.snapshot.instanceId }), { start });

			expect(await startCollabSession(f.snapshot.instanceId, "view", { dir })).toMatchObject({ url: f.viewUrl });
			expect(start).not.toHaveBeenCalled();
			// A view-only room refuses a control request exactly as `link` does.
			const viewOnly = makeFixture({ access: "view" });
			await publish(dir, viewOnly);
			await expect(startCollabSession(viewOnly.snapshot.instanceId, "control", { dir })).rejects.toMatchObject({
				code: "access_unavailable",
			});
		});

		it("lists a process once it hosts only as a host, and again as idle when its idle source says it can start", async () => {
			const dir = await tempDir();
			const idle = makeIdle();
			let startable = false;
			await publishIdle(dir, idle, {
				snapshot: () => {
					if (!startable) throw new Error("already hosting");
					return idle;
				},
			});
			const host = makeFixture({ instanceId: idle.instanceId });
			const hosting = await publish(dir, host);

			expect(await listCollabSessions({ dir })).toEqual({ hosts: [host.snapshot], idle: [] });
			await hosting.close();
			startable = true;
			expect(await listCollabSessions({ dir })).toEqual({ hosts: [], idle: [idle] });
		});

		it("reports the reason an idle process cannot start without leaking a link", async () => {
			const dir = await tempDir();
			const idle = makeIdle();
			await publishIdle(dir, idle, {
				start: () => Promise.reject(new CollabLinkError("not_startable", `joined as guest\n${"x".repeat(2000)}`)),
			});

			const error = await startCollabSession(idle.instanceId, "control", { dir }).catch((e: unknown) => e);
			if (!(error instanceof CollabLinkError)) throw new Error("expected a start failure");
			expect(error.code).toBe("not_startable");
			// Single line, bounded on the wire.
			expect(error.message).toStartWith(`session ${idle.instanceId} cannot start hosting: joined as guest xxx`);
			expect(error.message.length).toBeLessThan(500);
			expect(error.message).not.toContain("\n");
		});

		it("never runs a start request that lacks the bearer token or speaks another protocol version", async () => {
			const dir = await tempDir();
			const idle = makeIdle();
			const start = spyOn(
				{ start: async () => ({ generation: 1, access: "control" as const, url: "unused" }) },
				"start",
			);
			const pub = await publishIdle(dir, idle, { start });
			const token = await readSoleToken(dir);

			const forged = await rawRequest(pub.endpoint, {
				v: COLLAB_IDLE_REGISTRY_VERSION,
				token: "not-the-real-token",
				op: "start",
				access: "control",
			});
			expect(JSON.parse(forged)).toEqual({
				ok: false,
				v: COLLAB_IDLE_REGISTRY_VERSION,
				error: "authentication_failed",
			});
			const hostVersion = await rawRequest(pub.endpoint, {
				v: COLLAB_REGISTRY_VERSION,
				token,
				op: "start",
				access: "control",
			});
			expect(JSON.parse(hostVersion)).toEqual({
				ok: false,
				v: COLLAB_IDLE_REGISTRY_VERSION,
				error: "unsupported_protocol",
			});
			// An idle endpoint never hands out host capabilities.
			const link = await rawRequest(pub.endpoint, {
				v: COLLAB_IDLE_REGISTRY_VERSION,
				token,
				op: "link",
				access: "control",
				generation: 1,
			});
			expect(JSON.parse(link)).toEqual({ ok: false, v: COLLAB_IDLE_REGISTRY_VERSION, error: "invalid_operation" });
			const badAccess = await rawRequest(pub.endpoint, {
				v: COLLAB_IDLE_REGISTRY_VERSION,
				token,
				op: "start",
				access: "admin",
			});
			expect(JSON.parse(badAccess)).toEqual({ ok: false, v: COLLAB_IDLE_REGISTRY_VERSION, error: "invalid_access" });
			expect(start).not.toHaveBeenCalled();
		});

		it("prunes a stale idle entry, keeps a live one that cannot be started right now, and never writes a link to disk", async () => {
			const dir = await tempDir();
			await writeMetadata(dir, "stale-idle.json", {
				version: COLLAB_IDLE_REGISTRY_VERSION,
				kind: "idle",
				pid: freshDeadPid(),
				endpoint: auxEndpoint(dir, "stale-idle"),
				createdAt: Date.now(),
				token: crypto.randomBytes(16).toString("hex"),
			});
			const busy = makeIdle({ sessionId: "guest-session" });
			await publishIdle(dir, busy, {
				snapshot: () => {
					throw new Error("collab guest owns the session");
				},
			});
			const idle = makeIdle({ sessionId: "startable" });
			await publishIdle(dir, idle);
			await startCollabSession(idle.instanceId, "control", { dir });

			expect((await listCollabSessions({ dir })).idle).toEqual([idle]);
			const names = await fs.readdir(dir);
			expect(names).not.toContain("stale-idle.json");
			expect(names.filter(name => name.endsWith(".json"))).toHaveLength(2);
			for (const file of await collectRegularFiles(dir)) {
				expect(await Bun.file(file).text()).not.toContain("https://collab.example");
			}
		});

		it("prunes a dead idle entry from a host-only listing but leaves a live one untouched", async () => {
			const dir = await tempDir();
			await writeMetadata(dir, "dead-idle.json", {
				version: COLLAB_IDLE_REGISTRY_VERSION,
				kind: "idle",
				pid: freshDeadPid(),
				endpoint: auxEndpoint(dir, "dead-idle"),
				createdAt: Date.now(),
				token: crypto.randomBytes(16).toString("hex"),
			});
			const live = makeIdle();
			await publishIdle(dir, live);

			expect(await listCollabHosts({ dir })).toEqual([]);
			const names = await fs.readdir(dir);
			expect(names).not.toContain("dead-idle.json");
			expect(names.filter(name => name.endsWith(".json"))).toHaveLength(1);
			expect((await listCollabSessions({ dir })).idle).toEqual([live]);
		});

		it.skipIf(process.platform === "win32")("creates the idle metadata file and socket owner-only", async () => {
			const dir = path.join(await tempDir(), "r");
			const pub = await publishIdle(dir, makeIdle());

			const [metaName] = (await fs.readdir(dir)).filter(n => n.endsWith(".json"));
			expect((await fs.stat(path.join(dir, metaName ?? ""))).mode & 0o777).toBe(0o600);
			expect((await fs.stat(pub.endpoint)).mode & 0o777).toBe(0o600);
			expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
		});
	});
});
