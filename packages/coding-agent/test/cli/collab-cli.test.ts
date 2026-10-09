import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as collabCli from "@oh-my-pi/pi-coding-agent/cli/collab-cli";
import * as registry from "@oh-my-pi/pi-coding-agent/collab/registry";
import {
	COLLAB_REGISTRY_VERSION,
	type CollabHostPublication,
	type CollabHostSnapshot,
	type CollabIdleRegistrySource,
	type CollabIdleSnapshot,
	CollabLinkError,
	publishCollabHost,
	publishCollabIdle,
	resolveCollabHostLink,
} from "@oh-my-pi/pi-coding-agent/collab/registry";
import Collab from "@oh-my-pi/pi-coding-agent/commands/collab";
import { type CliConfig, CliUsageError } from "@oh-my-pi/pi-utils/cli";

interface HostFixture {
	snapshot: CollabHostSnapshot;
	controlUrl: string;
	viewUrl: string;
}

const ALPHA: HostFixture = {
	snapshot: {
		instanceId: "host-alpha",
		generation: 2,
		pid: process.pid,
		sessionId: "sess-alpha",
		sessionName: "Alpha Session",
		cwd: "/tmp/work/alpha",
		model: { provider: "test", id: "alpha-model" },
		startedAt: 1_700_000_000_000,
		participants: 3,
		relayConnected: true,
		inputRequired: true,
		busy: true,
		access: "control",
	},
	controlUrl: "https://collab.test/#alpha-CONTROL-url",
	viewUrl: "https://collab.test/#alpha-VIEW-url",
};

const BRAVO: HostFixture = {
	snapshot: {
		instanceId: "host-bravo",
		generation: 7,
		pid: process.pid,
		sessionId: "sess-bravo",
		sessionName: null,
		cwd: "/tmp/work/bravo",
		model: null,
		startedAt: 1_700_000_100_000,
		participants: 1,
		relayConnected: false,
		inputRequired: false,
		busy: false,
		access: "view",
	},
	controlUrl: "https://collab.test/#bravo-CONTROL-url",
	viewUrl: "https://collab.test/#bravo-VIEW-url",
};

const publications: CollabHostPublication[] = [];
const tmpDirs: string[] = [];
const CONFIG: CliConfig = { bin: "omp", version: "0.0.0-test", commands: new Map() };

async function makeTmpDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-cli-"));
	tmpDirs.push(dir);
	return dir;
}

async function publish(dir: string, fixture: HostFixture): Promise<void> {
	const pub = await publishCollabHost(
		{
			snapshot: () => fixture.snapshot,
			link: access =>
				access === "view" ? fixture.viewUrl : fixture.snapshot.access === "control" ? fixture.controlUrl : null,
		},
		{ dir, instanceId: fixture.snapshot.instanceId },
	);
	publications.push(pub);
}

const IDLE: CollabIdleSnapshot = {
	instanceId: "idle-delta",
	pid: process.pid,
	sessionId: "sess-delta",
	sessionName: "Delta Session",
	cwd: "/tmp/work/delta",
	model: { provider: "test", id: "delta-model" },
	startedAt: 1_700_000_200_000,
	busy: false,
};

async function publishIdle(dir: string, source: Partial<CollabIdleRegistrySource> = {}): Promise<void> {
	const pub = await publishCollabIdle(
		{
			snapshot: () => IDLE,
			start: async access => ({ generation: 1, access, url: `https://collab.test/#delta-${access}-url` }),
			...source,
		},
		{ dir, instanceId: IDLE.instanceId },
	);
	publications.push(pub);
}

interface Collector {
	print: (line: string) => void;
	plain: () => string;
	calls: string[];
}

function collector(): Collector {
	const calls: string[] = [];
	return {
		print: line => calls.push(line),
		plain: () => Bun.stripANSI(calls.join("\n")),
		calls,
	};
}

/** Exercise parsing and real handlers while keeping registry and output isolated. */
async function runCommand(argv: string[], dir: string, out: Collector): Promise<void> {
	const list = collabCli.runCollabListCommand;
	const link = collabCli.runCollabLinkCommand;
	const start = collabCli.runCollabStartCommand;
	const listSpy = spyOn(collabCli, "runCollabListCommand").mockImplementation(args =>
		list({ ...args, registry: { dir } }, out.print),
	);
	const linkSpy = spyOn(collabCli, "runCollabLinkCommand").mockImplementation(args =>
		link({ ...args, registry: { dir } }, out.print),
	);
	const startSpy = spyOn(collabCli, "runCollabStartCommand").mockImplementation(args =>
		start({ ...args, registry: { dir } }, out.print),
	);
	try {
		await new Collab(argv, CONFIG).run();
	} finally {
		listSpy.mockRestore();
		linkSpy.mockRestore();
		startSpy.mockRestore();
	}
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(publications.splice(0).map(pub => pub.close()));
	for (const dir of tmpDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

describe("Collab CLI", () => {
	it("reports no active hosts against an empty registry", async () => {
		const dir = await makeTmpDir();
		const out = collector();
		await runCommand(["list"], dir, out);

		expect(out.plain()).toBe("No active Collab hosts.");
	});

	it("lists host identities, sessions, generations and attention state without either capability", async () => {
		const dir = await makeTmpDir();
		await publish(dir, BRAVO);
		await publish(dir, ALPHA);
		const out = collector();
		await runCommand(["list"], dir, out);

		const text = out.plain();
		expect(text).toContain("2 active Collab hosts");
		expect(text).toContain("host-alpha  Alpha Session (sess-alpha)  /tmp/work/alpha");
		expect(text).toContain("host-bravo  sess-bravo  /tmp/work/bravo");
		expect(text).toContain(`pid ${process.pid}`);
		expect(text).toContain("gen 2 · test/alpha-model");
		expect(text).toContain("gen 7 · no model");
		expect(text).toContain("2 guests · control · relay connected · input required · working");
		expect(text).toContain("0 guests · view · relay reconnecting · idle");
		expect(text.indexOf(ALPHA.snapshot.instanceId)).toBeLessThan(text.indexOf(BRAVO.snapshot.instanceId));
		for (const fixture of [ALPHA, BRAVO]) {
			expect(text).not.toContain(fixture.controlUrl);
			expect(text).not.toContain(fixture.viewUrl);
		}
	});

	it("renders no activity token for a host that does not report busy", async () => {
		const dir = await makeTmpDir();
		const legacy: HostFixture = {
			snapshot: { ...BRAVO.snapshot, instanceId: "host-charlie", sessionId: "sess-charlie", busy: null },
			controlUrl: "https://collab.test/#charlie-CONTROL-url",
			viewUrl: "https://collab.test/#charlie-VIEW-url",
		};
		await publish(dir, legacy);
		const out = collector();
		await runCommand(["list"], dir, out);

		const text = out.plain();
		expect(text).toContain("host-charlie");
		// An older host reports nothing, and the row guesses nothing.
		expect(text).not.toMatch(/working|idle/);
	});

	it("emits repeatable, two-space metadata-only JSON for list and the default action with -j", async () => {
		const dir = await makeTmpDir();
		await publish(dir, BRAVO);
		await publish(dir, ALPHA);
		const out = collector();
		await runCommand(["list", "--json"], dir, out);

		const expected = { version: COLLAB_REGISTRY_VERSION, hosts: [ALPHA.snapshot, BRAVO.snapshot], idle: [] };
		expect(out.plain()).toBe(JSON.stringify(expected, null, 2));
		for (const fixture of [ALPHA, BRAVO]) {
			expect(out.plain()).not.toContain(fixture.controlUrl);
			expect(out.plain()).not.toContain(fixture.viewUrl);
		}
		const again = collector();
		await runCommand(["-j"], dir, again);
		expect(again.plain()).toBe(out.plain());
	});

	it("lists idle sessions in their own section, apart from hosts, and under `idle` in JSON", async () => {
		const dir = await makeTmpDir();
		await publish(dir, ALPHA);
		await publishIdle(dir);
		const text = collector();
		await runCommand(["list"], dir, text);

		const plain = text.plain();
		expect(plain).toContain("1 active Collab host");
		expect(plain).toContain("1 idle omp session (not shared)");
		expect(plain).toContain("idle-delta  Delta Session (sess-delta)  /tmp/work/delta");
		expect(plain).toContain("omp collab start <instanceId|pid>");
		// Hosts come first; the idle process is not rendered as a host row.
		expect(plain.indexOf("host-alpha")).toBeLessThan(plain.indexOf("1 idle omp session"));
		expect(plain.indexOf("idle-delta")).toBeGreaterThan(plain.indexOf("1 idle omp session"));
		expect(plain).not.toContain("gen 1");

		const json = collector();
		await runCommand(["list", "--json"], dir, json);
		expect(JSON.parse(json.plain())).toEqual({
			version: COLLAB_REGISTRY_VERSION,
			hosts: [ALPHA.snapshot],
			idle: [IDLE],
		});
	});

	it("starts an idle session with control by default or view on request and prints only that link", async () => {
		const dir = await makeTmpDir();
		const requested: string[] = [];
		await publishIdle(dir, {
			start: async access => {
				requested.push(access);
				return { generation: 3, access, url: `https://collab.test/#delta-${access}-url` };
			},
		});
		const control = collector();
		await runCommand(["start", String(process.pid)], dir, control);
		expect(control.calls).toEqual(["https://collab.test/#delta-control-url"]);
		const view = collector();
		await runCommand(["start", IDLE.instanceId, "--view"], dir, view);
		expect(view.calls).toEqual(["https://collab.test/#delta-view-url"]);
		expect(requested).toEqual(["control", "view"]);

		const json = collector();
		await runCommand(["start", IDLE.instanceId, "-j"], dir, json);
		expect(JSON.parse(json.plain())).toEqual({
			version: COLLAB_REGISTRY_VERSION,
			instanceId: IDLE.instanceId,
			generation: 3,
			access: "control",
			url: "https://collab.test/#delta-control-url",
		});
	});

	it("reports why an idle session could not start as a nonzero failure without output", async () => {
		const dir = await makeTmpDir();
		await publishIdle(dir, {
			start: () => Promise.reject(new Error("No relay configured.\nSet collab.relayUrl")),
		});
		const errors: string[] = [];
		spyOn(process.stderr, "write").mockImplementation(chunk => {
			errors.push(String(chunk));
			return true;
		});
		const previousExitCode = process.exitCode;
		const out = collector();
		try {
			await runCommand(["start", IDLE.instanceId], dir, out);
			expect(process.exitCode).toBe(1);
			expect(errors.join("")).toBe(
				`error: session ${IDLE.instanceId} failed to start hosting: No relay configured. Set collab.relayUrl\n`,
			);
			expect(out.calls).toEqual([]);
		} finally {
			process.exitCode = previousExitCode ?? 0;
		}
	});

	it("prints only the control URL when linking by instance ID", async () => {
		const dir = await makeTmpDir();
		await publish(dir, ALPHA);
		const out = collector();
		await runCommand(["link", ALPHA.snapshot.instanceId], dir, out);

		expect(out.calls).toEqual([ALPHA.controlUrl]);
	});

	it("prints only the view URL when --view is requested", async () => {
		const dir = await makeTmpDir();
		await publish(dir, ALPHA);
		const out = collector();
		await runCommand(["link", ALPHA.snapshot.instanceId, "--view"], dir, out);

		expect(out.calls).toEqual([ALPHA.viewUrl]);
		expect(out.plain()).not.toContain(ALPHA.controlUrl);
	});

	it("emits a versioned link JSON response with identity, generation and access", async () => {
		const dir = await makeTmpDir();
		await publish(dir, ALPHA);
		const out = collector();
		await runCommand(["link", ALPHA.snapshot.instanceId, "-j"], dir, out);

		expect(out.plain()).toBe(
			JSON.stringify(
				{
					version: COLLAB_REGISTRY_VERSION,
					instanceId: ALPHA.snapshot.instanceId,
					generation: ALPHA.snapshot.generation,
					access: "control",
					url: ALPHA.controlUrl,
				},
				null,
				2,
			),
		);
	});

	it("accepts a unique PID selector", async () => {
		const dir = await makeTmpDir();
		await publish(dir, ALPHA);
		const out = collector();
		await runCommand(["link", String(process.pid)], dir, out);

		expect(out.calls).toEqual([ALPHA.controlUrl]);
	});

	it.each([
		{ code: "not_found", selector: "missing-host", fixtures: [] },
		{ code: "ambiguous", selector: String(process.pid), fixtures: [ALPHA, BRAVO] },
	])("surfaces $code as a nonzero failure with the registry message and no URL or stack", async testCase => {
		const dir = await makeTmpDir();
		for (const fixture of testCase.fixtures) await publish(dir, fixture);
		const error = await resolveCollabHostLink(testCase.selector, "control", { dir }).catch((error: unknown) => error);
		if (!(error instanceof CollabLinkError)) throw new Error("expected a registry selection failure");
		expect(error.code).toBe(testCase.code);
		const errors: string[] = [];
		spyOn(process.stderr, "write").mockImplementation(chunk => {
			errors.push(String(chunk));
			return true;
		});
		const previousExitCode = process.exitCode;
		const out = collector();
		try {
			await runCommand(["link", testCase.selector, "--json"], dir, out);
			expect(process.exitCode).toBe(1);
			expect(errors.join("")).toBe(`error: ${error.message}\n`);
			expect(out.calls).toEqual([]);
			for (const fixture of [ALPHA, BRAVO]) {
				expect(errors.join("")).not.toContain(fixture.controlUrl);
				expect(errors.join("")).not.toContain(fixture.viewUrl);
			}
		} finally {
			process.exitCode = previousExitCode ?? 0;
		}
	});

	const usageRejections: string[][] = [
		["list", "--view"],
		["list", "extra"],
		["link"],
		["link", "a", "b"],
		["start"],
		["start", "a", "b"],
	];
	for (const argv of usageRejections) {
		it(`rejects ${JSON.stringify(argv)} through the usage path before invoking the registry`, async () => {
			const unexpected = new Error("registry must not be invoked for invalid usage");
			const listSpy = spyOn(registry, "listCollabSessions").mockRejectedValue(unexpected);
			const linkSpy = spyOn(registry, "resolveCollabHostLink").mockRejectedValue(unexpected);
			const startSpy = spyOn(registry, "startCollabSession").mockRejectedValue(unexpected);

			await expect(new Collab(argv, CONFIG).run()).rejects.toBeInstanceOf(CliUsageError);
			expect(listSpy).not.toHaveBeenCalled();
			expect(linkSpy).not.toHaveBeenCalled();
			expect(startSpy).not.toHaveBeenCalled();
		});
	}
});
