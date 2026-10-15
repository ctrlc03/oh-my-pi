/**
 * The high-stakes mode watch: a visible marker and a session entry when the mode the companion keeps for the checkout
 * differs from the one the session last recorded, nothing when it is unchanged, one marker for a change made while
 * the session was not running. Timers, hosts and the state reader are fakes, plus one run against a real state file.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	formatStakesState,
	STAKES_ENTRY_TYPE as WIRE_ENTRY_TYPE,
	STAKES_MARKER_TYPE as WIRE_MARKER_TYPE,
	STAKES_STATE_DIR,
	type StakesState,
	stakesStateKey,
} from "@oh-my-pi/pi-wire/stakes";
import type { SessionEntry } from "../src/session/session-entries";
import {
	HighStakesWatch,
	type HighStakesWatchHost,
	type HighStakesWatchTimers,
	readRecordedStakesMode,
	STAKES_ENTRY_TYPE,
	STAKES_MARKER_TYPE,
	type StakesMarkerDetails,
	stakesMarkerText,
} from "../src/high-stakes/watch";
import { StakesFileReader } from "../src/high-stakes/state";

function state(overrides: Partial<StakesState> = {}): StakesState {
	return { rev: 1, on: true, checkout: "/repo", passMark: 90, by: "", at: 1, trees: [], ...overrides };
}

class FakeTimers implements HighStakesWatchTimers {
	handlers = new Map<number, { handler: () => void; ms: number }>();
	#next = 1;
	setInterval(handler: () => void, ms: number): unknown {
		const id = this.#next++;
		this.handlers.set(id, { handler, ms });
		return id;
	}
	clearInterval(handle: unknown): void {
		if (typeof handle === "number") this.handlers.delete(handle);
	}
	tick(): void {
		for (const { handler } of Array.from(this.handlers.values())) handler();
	}
}

/** The session side: an append-only list of entries and messages, as `sessionManager` and `sendCustomMessage` would keep. */
class FakeSession implements HighStakesWatchHost {
	entries: SessionEntry[] = [];
	messages: Array<{ text: string; details: StakesMarkerDetails }> = [];
	writable = true;
	failAnnounce = 0;
	folder = "/repo";

	cwd(): string {
		return this.folder;
	}
	agentDir(): string {
		return "/agent";
	}
	canWrite(): boolean {
		return this.writable;
	}
	recorded(): boolean {
		return readRecordedStakesMode(this.entries);
	}
	async announce(text: string, details: StakesMarkerDetails): Promise<void> {
		if (this.failAnnounce > 0) {
			this.failAnnounce--;
			throw new Error("session busy");
		}
		this.messages.push({ text, details });
	}
	record(on: boolean): void {
		this.entries.push({
			type: "custom",
			customType: STAKES_ENTRY_TYPE,
			data: { on },
			id: `e${this.entries.length}`,
			parentId: null,
			timestamp: new Date().toISOString(),
		} as unknown as SessionEntry);
	}
}

function harness(initial: StakesState | null = null) {
	const session = new FakeSession();
	const timers = new FakeTimers();
	const published = { current: initial };
	const reads: Array<[string, string]> = [];
	const watch = new HighStakesWatch({
		host: session,
		timers,
		read: (cwd, agentDir) => {
			reads.push([cwd, agentDir]);
			return published.current;
		},
	});
	return { session, timers, published, reads, watch };
}

describe("stakes marker constants", () => {
	it("are the ones the wire module defines", () => {
		expect(STAKES_MARKER_TYPE).toBe(WIRE_MARKER_TYPE);
		expect(STAKES_ENTRY_TYPE).toBe(WIRE_ENTRY_TYPE);
		expect(STAKES_MARKER_TYPE).toBe("high-stakes");
	});

	it("say what changed", () => {
		expect(stakesMarkerText(true, "phone")).toBe(
			"High-stakes mode is on. Pushing and pull requests are blocked until the user passes a quiz on this session's changes; ask the user to take it in the collab app.",
		);
		expect(stakesMarkerText(false, "Phone")).toBe(
			"High-stakes mode was turned off by Phone. Pushes and pull requests are no longer blocked.",
		);
		expect(stakesMarkerText(false, "")).toBe(
			"High-stakes mode was turned off. Pushes and pull requests are no longer blocked.",
		);
	});
});

describe("readRecordedStakesMode", () => {
	const entry = (customType: string, data: unknown): SessionEntry =>
		({ type: "custom", customType, data, id: "x", parentId: null, timestamp: "" }) as unknown as SessionEntry;

	it("is off with no entry", () => {
		expect(readRecordedStakesMode([])).toBe(false);
		expect(readRecordedStakesMode([entry("pr-watch", { on: true })])).toBe(false);
	});

	it("takes the latest entry of its type", () => {
		expect(readRecordedStakesMode([entry(STAKES_ENTRY_TYPE, { on: true })])).toBe(true);
		expect(
			readRecordedStakesMode([entry(STAKES_ENTRY_TYPE, { on: true }), entry(STAKES_ENTRY_TYPE, { on: false })]),
		).toBe(false);
		expect(
			readRecordedStakesMode([
				entry(STAKES_ENTRY_TYPE, { on: true }),
				entry("pr-watch", { prs: [] }),
				{ type: "message" } as unknown as SessionEntry,
			]),
		).toBe(true);
	});

	it("ignores an entry whose data is not a record", () => {
		expect(readRecordedStakesMode([entry(STAKES_ENTRY_TYPE, { on: true }), entry(STAKES_ENTRY_TYPE, "on")])).toBe(
			true,
		);
		expect(readRecordedStakesMode([entry(STAKES_ENTRY_TYPE, null)])).toBe(false);
	});
});

describe("HighStakesWatch", () => {
	it("writes a marker and records the mode when it goes on", async () => {
		const { session, published, watch } = harness();
		await watch.check();
		expect(session.messages).toEqual([]);
		expect(session.entries).toEqual([]);

		published.current = state({ on: true, by: "phone", rev: 4 });
		await watch.check();
		expect(session.messages).toEqual([
			{ text: stakesMarkerText(true, "phone"), details: { on: true, by: "phone", rev: 4 } },
		]);
		expect(session.entries).toHaveLength(1);
		expect(session.entries[0]).toMatchObject({ type: "custom", customType: STAKES_ENTRY_TYPE, data: { on: true } });
	});

	it("writes a marker naming the device when it goes off", async () => {
		const { session, published, watch } = harness(state({ on: true }));
		await watch.check();
		expect(session.messages).toHaveLength(1);

		published.current = state({ on: false, by: "Phone", rev: 7 });
		await watch.check();
		expect(session.messages).toHaveLength(2);
		expect(session.messages[1]).toEqual({
			text: "High-stakes mode was turned off by Phone. Pushes and pull requests are no longer blocked.",
			details: { on: false, by: "Phone", rev: 7 },
		});
		expect(session.entries).toMatchObject([{ data: { on: true } }, { data: { on: false } }]);
		expect(session.recorded()).toBe(false);
	});

	it("writes nothing while the mode is unchanged, however often it looks", async () => {
		const { session, published, watch } = harness(state({ on: true }));
		await watch.check();
		published.current = state({ on: true, rev: 2, trees: ["a".repeat(40)] });
		for (let i = 0; i < 5; i++) await watch.check();
		expect(session.messages).toHaveLength(1);
		expect(session.entries).toHaveLength(1);

		const off = harness(state({ on: false }));
		for (let i = 0; i < 5; i++) await off.watch.check();
		expect(off.session.messages).toEqual([]);
		expect(off.session.entries).toEqual([]);
	});

	it("writes one marker for a change made while the session was not running", async () => {
		// The branch recorded `on`; the mode was turned off while the session was closed.
		const { session, watch } = harness(state({ on: false, by: "laptop" }));
		session.record(true);
		await watch.check();
		await watch.check();
		expect(session.messages).toHaveLength(1);
		expect(session.messages[0].text).toBe(stakesMarkerText(false, "laptop"));
		expect(session.recorded()).toBe(false);

		// The other way: recorded off (no entry), turned on meanwhile.
		const resumed = harness(state({ on: true }));
		await resumed.watch.check();
		await resumed.watch.check();
		expect(resumed.session.messages).toHaveLength(1);
		expect(resumed.session.messages[0].text).toBe(stakesMarkerText(true, ""));
	});

	it("writes nothing for a resumed session whose recorded mode still holds", async () => {
		const { session, watch } = harness(state({ on: true }));
		session.record(true);
		await watch.check();
		expect(session.messages).toEqual([]);
		expect(session.entries).toHaveLength(1);
	});

	it("treats a missing state file as off", async () => {
		const { session, published, watch } = harness(state({ on: true }));
		await watch.check();
		published.current = null;
		await watch.check();
		expect(session.messages.map(message => message.details.on)).toEqual([true, false]);
		expect(session.messages[1].details.by).toBe("");
		expect(session.messages[1].text).toBe(stakesMarkerText(false, ""));
	});

	it("tries again later when the marker could not be written, and records nothing until it was", async () => {
		const { session, watch } = harness(state({ on: true }));
		session.failAnnounce = 2;
		await watch.check();
		await watch.check();
		expect(session.messages).toEqual([]);
		expect(session.entries).toEqual([]);
		await watch.check();
		expect(session.messages).toHaveLength(1);
		expect(session.entries).toHaveLength(1);
	});

	it("does not look while the session cannot take a message", async () => {
		const { session, reads, watch } = harness(state({ on: true }));
		session.writable = false;
		await watch.check();
		expect(reads).toEqual([]);
		expect(session.messages).toEqual([]);
		session.writable = true;
		await watch.check();
		expect(session.messages).toHaveLength(1);
	});

	it("reads the recorded mode again after the session changed", async () => {
		const { session, watch } = harness(state({ on: true }));
		await watch.check();
		expect(session.messages).toHaveLength(1);
		// A new session starts in the same folder: nothing recorded, so the mode is announced there too.
		session.entries = [];
		watch.sessionChanged();
		await watch.check();
		expect(session.messages).toHaveLength(2);
	});

	it("reads the folder and agent directory the host gives, not twice at once", async () => {
		const { session, reads, watch } = harness(state({ on: true }));
		session.folder = "/other";
		await Promise.all([watch.check(), watch.check()]);
		expect(reads[0]).toEqual(["/other", "/agent"]);
		expect(session.messages).toHaveLength(1);
	});

	it("polls on a timer every 2 seconds until disposed", async () => {
		const { session, timers, published, watch } = harness();
		watch.start();
		watch.start();
		expect(timers.handlers.size).toBe(1);
		expect([...timers.handlers.values()][0].ms).toBe(2000);

		published.current = state({ on: true });
		// `check` runs synchronously as far as the marker, so the tick needs no wait.
		timers.tick();
		expect(session.messages).toHaveLength(1);

		watch.dispose();
		expect(timers.handlers.size).toBe(0);
		published.current = state({ on: false });
		await watch.check();
		expect(session.messages).toHaveLength(1);
		watch.start();
		expect(timers.handlers.size).toBe(0);
	});
});

describe("StakesFileReader and the watch on a real state file", () => {
	let root: string;
	let agentDir: string;
	let repo: string;

	function git(cwd: string, ...args: string[]): void {
		const run = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
		if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
	}

	function publish(overrides: Partial<StakesState>): void {
		fs.mkdirSync(path.join(agentDir, STAKES_STATE_DIR), { recursive: true });
		fs.writeFileSync(
			path.join(agentDir, STAKES_STATE_DIR, stakesStateKey(repo)),
			formatStakesState(state({ checkout: repo, ...overrides })),
		);
	}

	beforeEach(() => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-stakes-watch-")));
		agentDir = path.join(root, "agent");
		fs.mkdirSync(agentDir);
		repo = path.join(root, "repo");
		fs.mkdirSync(repo);
		git(repo, "init", "-q", "-b", "main");
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("reads nothing, and resolves no checkout, until the companion has published", () => {
		let clock = 0;
		const reader = new StakesFileReader(() => clock);
		expect(reader.read(repo, agentDir)).toBeNull();
		publish({ on: true, by: "phone" });
		expect(reader.read(repo, agentDir)?.by).toBe("phone");
		clock += 100;
		expect(reader.read(repo, agentDir)?.by).toBe("phone");
	});

	it("follows a change of the file, and a removal", () => {
		const reader = new StakesFileReader();
		publish({ on: true, rev: 1 });
		expect(reader.read(repo, agentDir)?.on).toBe(true);
		publish({ on: false, rev: 2, by: "Phone" });
		const second = reader.read(repo, agentDir);
		expect(second?.on).toBe(false);
		expect(second?.by).toBe("Phone");
		fs.rmSync(path.join(agentDir, STAKES_STATE_DIR, stakesStateKey(repo)));
		expect(reader.read(repo, agentDir)).toBeNull();
	});

	it("finds a checkout that appears later, after the retry interval", () => {
		const folder = path.join(root, "later");
		fs.mkdirSync(folder);
		let clock = 0;
		const reader = new StakesFileReader(() => clock);
		fs.mkdirSync(path.join(agentDir, STAKES_STATE_DIR), { recursive: true });
		expect(reader.read(folder, agentDir)).toBeNull();
		git(folder, "init", "-q", "-b", "main");
		fs.writeFileSync(
			path.join(agentDir, STAKES_STATE_DIR, stakesStateKey(fs.realpathSync(folder))),
			formatStakesState(state({ checkout: folder })),
		);
		expect(reader.read(folder, agentDir)).toBeNull();
		clock += StakesFileReader.RETRY_MS;
		expect(reader.read(folder, agentDir)?.on).toBe(true);
	});

	it("drives the watch end to end", async () => {
		const session = new FakeSession();
		session.folder = repo;
		const agent = agentDir;
		session.agentDir = () => agent;
		const watch = new HighStakesWatch({ host: session, timers: new FakeTimers() });
		await watch.check();
		expect(session.messages).toEqual([]);

		publish({ on: true, rev: 1, by: "phone" });
		await watch.check();
		expect(session.messages.map(message => message.text)).toEqual([stakesMarkerText(true, "phone")]);

		await watch.check();
		expect(session.messages).toHaveLength(1);

		publish({ on: false, rev: 2, by: "Phone" });
		await watch.check();
		expect(session.messages.map(message => message.text)).toEqual([
			stakesMarkerText(true, "phone"),
			"High-stakes mode was turned off by Phone. Pushes and pull requests are no longer blocked.",
		]);
		expect(session.recorded()).toBe(false);
	});
});
