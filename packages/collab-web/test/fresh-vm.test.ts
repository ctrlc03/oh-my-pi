import { describe, expect, it } from "bun:test";
import { VM_MAX_FRESH, type VmEntry } from "@oh-my-pi/pi-wire/vm";
import type { CompanionPhase } from "../src/lib/companion";
import {
	FRESH_APPEAR_MS,
	FRESH_CLEANUP_MS,
	FRESH_CLONE_TIMEOUT_MS,
	FRESH_CONNECT_TIMEOUT_MS,
	freshFolder,
	freshLimitReason,
	type FreshRun,
	type FreshStartDeps,
	forgettableComputers,
	freshStep,
	runFreshStart,
	sleepUnlessAborted,
	usableTemplates,
} from "../src/lib/fresh-vm";

function vm(patch: Partial<VmEntry> = {}): VmEntry {
	return {
		name: "web-1a2b",
		repos: ["acme/web"],
		cpus: 4,
		memoryGiB: 8,
		diskGiB: 60,
		network: "open",
		driver: "lima",
		status: "running",
		createdAt: 1,
		...patch,
	};
}

const template = (patch: Partial<VmEntry> = {}): VmEntry =>
	vm({ name: "web", template: true, status: "stopped", home: "/home/ubuntu", ...patch });

describe("which templates a fresh VM can be cloned from", () => {
	it("takes stopped, idle templates that know their home and repositories", () => {
		const usable = template();
		expect(
			usableTemplates([
				usable,
				vm({ name: "plain", status: "stopped", home: "/home/ubuntu" }),
				template({ name: "running", status: "running" }),
				template({ name: "busy", busy: { action: "start", step: "", message: "Starting…" } }),
				template({ name: "failed", status: "failed" }),
				template({ name: "homeless", home: undefined }),
				template({ name: "empty", repos: [] }),
			]),
		).toEqual([usable]);
	});

	it("finds a repository under the guest's home", () => {
		expect(freshFolder("/home/ubuntu", "acme/web")).toBe("/home/ubuntu/src/acme/web");
	});
});

describe("the limit of fresh VMs", () => {
	const fresh = (name: string): VmEntry => vm({ name, fresh: { from: "web", expiresAt: 9 } });

	it("says why no more can start once the host has the most it allows", () => {
		const some = Array.from({ length: VM_MAX_FRESH - 1 }, (_, n) => fresh(`web-000${n}`));
		expect(freshLimitReason([template(), ...some], "MacBook")).toBeNull();
		const reason = freshLimitReason([template(), ...some, fresh("web-ffff")], "MacBook");
		expect(reason).toContain("MacBook");
		expect(reason).toContain(String(VM_MAX_FRESH));
	});
});

describe("what a fresh start waits for", () => {
	const at = (stage: FreshRun["stage"], stageAt = 0, seen = false): FreshRun => ({ stage, stageAt, seen });

	it("follows the clone's progress, then pairs with the link it ends with", () => {
		const busy = vm({ busy: { action: "clone", step: "boot", message: "Booting the clone…" } });
		expect(freshStep(at("cloning"), { now: 1, vm: busy, phase: null })).toEqual({
			run: at("cloning", 0, true),
			action: { kind: "wait", message: "Booting the clone…" },
		});
		const done = vm({ pairUrl: "https://my.omp.sh/#pair:x" });
		expect(freshStep(at("cloning", 0, true), { now: 5, vm: done, phase: null })).toEqual({
			run: at("connecting", 5, true),
			action: { kind: "pair", url: "https://my.omp.sh/#pair:x" },
		});
	});

	it("keeps waiting for a clone the host has not listed yet, then gives up", () => {
		const first = freshStep(at("cloning"), { now: 1_000, vm: undefined, phase: null });
		expect(first.action.kind).toBe("wait");
		const late = freshStep(at("cloning"), { now: FRESH_APPEAR_MS + 1, vm: undefined, phase: null });
		expect(late.action).toEqual({ kind: "fail", message: "The computer did not start cloning the VM." });
	});

	it("fails with the clone's own error, a vanished clone, or a clone without a link", () => {
		expect(freshStep(at("cloning"), { now: 1, vm: vm({ error: "disk full" }), phase: null }).action).toEqual({
			kind: "fail",
			message: "disk full",
		});
		expect(freshStep(at("cloning", 0, true), { now: 1, vm: undefined, phase: null }).action.kind).toBe("fail");
		expect(freshStep(at("cloning"), { now: 1, vm: vm(), phase: null }).action).toEqual({
			kind: "fail",
			message: "The VM was cloned but gave no pairing link.",
		});
	});

	it("treats a list that could not be read as no news, until the clone takes too long", () => {
		expect(freshStep(at("cloning", 0, true), { now: 1, vm: null, phase: null }).action.kind).toBe("wait");
		const stuck = freshStep(at("cloning", 0, true), { now: FRESH_CLONE_TIMEOUT_MS + 1, vm: null, phase: null });
		expect(stuck.action).toEqual({ kind: "fail", message: "Cloning the VM took too long." });
	});

	it("starts the session once the new computer is live, and fails when it refuses this device or never comes", () => {
		const connecting = at("connecting", 100, true);
		const listed = vm();
		const phase = (value: CompanionPhase) => freshStep(connecting, { now: 200, vm: listed, phase: value }).action;
		expect(phase("connecting")).toEqual({ kind: "wait", message: "Connecting to the new VM…" });
		expect(phase("live")).toEqual({ kind: "start" });
		expect(phase("unpaired").kind).toBe("fail");
		const late = freshStep(connecting, { now: 100 + FRESH_CONNECT_TIMEOUT_MS + 1, vm: listed, phase: "connecting" });
		expect(late.action.kind).toBe("fail");
		expect(freshStep(connecting, { now: 200, vm: undefined, phase: "offline" }).action.kind).toBe("fail");
	});
});

/** A host and a new computer the test drives by hand; time moves only when a step sleeps. */
function fakeDeps(over: Partial<FreshStartDeps> = {}) {
	const state = {
		time: 0,
		listed: [] as VmEntry[],
		phase: null as CompanionPhase | null,
		pairs: [] as { url: string; fresh: { hostComputerId: string; name: string } }[],
		deleted: [] as string[],
		forgotten: [] as string[],
		started: [] as string[],
		deleteRefusals: 0,
		/** Runs at each sleep, to let the "host" move on. */
		onSleep: (_state: { time: number }): void => {},
	};
	const deps: FreshStartDeps = {
		vmClone: async () => {},
		vmList: async () => state.listed,
		vmDelete: async name => {
			if (state.deleteRefusals > 0) {
				state.deleteRefusals--;
				throw new Error(`${name} is busy (cloning); wait for it to finish`);
			}
			state.deleted.push(name);
		},
		pair: (url, fresh) => {
			state.pairs.push({ url, fresh });
			return "room-new";
		},
		phaseOf: () => state.phase,
		startSession: async id => {
			state.started.push(id);
			return "inst-1";
		},
		forget: async id => {
			state.forgotten.push(id);
		},
		now: () => state.time,
		sleep: async ms => {
			state.time += ms;
			state.onSleep(state);
		},
		...over,
	};
	return { state, deps };
}

const PARAMS = { template: "web", name: "web-1a2b", hostComputerId: "room-host" };
const live = new AbortController().signal;

describe("running a fresh start", () => {
	it("clones, pairs with the clone, waits until it is live and starts the session on it", async () => {
		const { state, deps } = fakeDeps();
		const messages: string[] = [];
		state.listed = [vm({ busy: { action: "clone", step: "boot", message: "Booting the clone…" } })];
		state.onSleep = s => {
			if (s.time === 2_000) state.listed = [vm({ pairUrl: "https://my.omp.sh/#pair:x" })];
			if (s.time === 4_000) state.phase = "live";
		};
		const result = await runFreshStart(deps, PARAMS, live, progress =>
			messages.push(`${progress.stage}: ${progress.message}`),
		);
		expect(result).toEqual({ ok: true, computerId: "room-new", instanceId: "inst-1" });
		expect(state.pairs).toEqual([
			{ url: "https://my.omp.sh/#pair:x", fresh: { hostComputerId: "room-host", name: "web-1a2b" } },
		]);
		expect(state.started).toEqual(["room-new"]);
		expect(state.deleted).toEqual([]);
		expect(messages).toContain("cloning: Booting the clone…");
		expect(messages).toContain("connecting: Connecting to the new VM…");
		expect(messages.at(-1)).toBe("starting: Starting the session…");
	});

	it("is refused before anything exists: nothing to delete", async () => {
		const { state, deps } = fakeDeps({
			vmClone: async () => {
				throw new Error("web is not a template");
			},
		});
		const result = await runFreshStart(deps, PARAMS, live, () => {});
		expect(result).toMatchObject({ ok: false, cancelled: false, message: "web is not a template" });
		expect(state.deleted).toEqual([]);
	});

	it("deletes the half-made clone, and forgets its computer, when the session cannot start", async () => {
		const { state, deps } = fakeDeps({
			startSession: async () => {
				throw new Error("tmux is not installed");
			},
		});
		state.listed = [vm({ pairUrl: "https://my.omp.sh/#pair:x" })];
		state.phase = "live";
		const result = await runFreshStart(deps, PARAMS, live, () => {});
		expect(result).toMatchObject({ ok: false, cancelled: false, message: "tmux is not installed" });
		if (result.ok) throw new Error("expected a failure");
		expect(await result.cleanup).toBeUndefined();
		expect(state.forgotten).toEqual(["room-new"]);
		expect(state.deleted).toEqual(["web-1a2b"]);
	});

	it("reports the clone's error and deletes it, without a computer to forget", async () => {
		const { state, deps } = fakeDeps();
		state.listed = [vm({ status: "failed", error: "limactl clone failed" })];
		const result = await runFreshStart(deps, PARAMS, live, () => {});
		expect(result).toMatchObject({ ok: false, message: "limactl clone failed" });
		if (result.ok) throw new Error("expected a failure");
		await result.cleanup;
		expect(state.forgotten).toEqual([]);
		expect(state.deleted).toEqual(["web-1a2b"]);
	});

	it("gives up on a computer that never connects", async () => {
		const { state, deps } = fakeDeps();
		state.listed = [vm({ pairUrl: "https://my.omp.sh/#pair:x" })];
		state.phase = "connecting";
		const result = await runFreshStart(deps, PARAMS, live, () => {});
		expect(result).toMatchObject({
			ok: false,
			cancelled: false,
			message: expect.stringContaining("did not connect"),
		});
		if (result.ok) throw new Error("expected a failure");
		await result.cleanup;
		expect(state.forgotten).toEqual(["room-new"]);
		expect(state.deleted).toEqual(["web-1a2b"]);
	});

	it("cancelling while the clone runs keeps asking the host to delete it until the host accepts", async () => {
		const abort = new AbortController();
		const { state, deps } = fakeDeps();
		state.listed = [vm({ busy: { action: "clone", step: "clone", message: "Copying the template's disk…" } })];
		state.deleteRefusals = 3;
		state.onSleep = () => abort.abort();
		const result = await runFreshStart(deps, PARAMS, abort.signal, () => {});
		expect(result).toMatchObject({ ok: false, cancelled: true });
		if (result.ok) throw new Error("expected a cancel");
		expect(await result.cleanup).toBeUndefined();
		expect(state.deleted).toEqual(["web-1a2b"]);
		expect(state.deleteRefusals).toBe(0);
	});

	it("says so when the host never accepts the delete, and that the VM expires by itself", async () => {
		const { state, deps } = fakeDeps({
			vmDelete: async () => {
				throw new Error("busy");
			},
		});
		state.listed = [vm({ error: "boom" })];
		const result = await runFreshStart(deps, PARAMS, live, () => {});
		if (result.ok) throw new Error("expected a failure");
		const note = await result.cleanup;
		expect(note).toContain("web-1a2b could not be deleted: busy");
		expect(state.time).toBeGreaterThanOrEqual(FRESH_CLEANUP_MS);
	});
});

describe("sleepUnlessAborted", () => {
	it("returns early once aborted, and at once when already aborted", async () => {
		const abort = new AbortController();
		const started = performance.now();
		const slept = sleepUnlessAborted(60_000, abort.signal);
		abort.abort();
		await slept;
		await sleepUnlessAborted(60_000, abort.signal);
		expect(performance.now() - started).toBeLessThan(5_000);
	});
});

describe("which fresh computers the app forgets", () => {
	const fresh = { hostComputerId: "host", name: "web-1a2b" };
	const computer = (id: string, phase: CompanionPhase, marked = true) => ({
		id,
		...(marked ? { fresh } : {}),
		snap: { phase },
	});
	const lists = (...names: string[]) => new Map([["host", names.map(name => ({ name }))]]);

	it("forgets a fresh computer that is not connected once its VM is gone from the host's list", () => {
		expect(forgettableComputers([computer("a", "offline")], lists("web-9999"))).toEqual(["a"]);
		expect(forgettableComputers([computer("a", "connecting")], lists())).toEqual(["a"]);
	});

	it("keeps one whose VM is still listed, one that is connected, and computers that are not fresh", () => {
		expect(forgettableComputers([computer("a", "offline")], lists("web-1a2b"))).toEqual([]);
		expect(forgettableComputers([computer("a", "live")], lists())).toEqual([]);
		expect(forgettableComputers([computer("a", "offline", false)], lists())).toEqual([]);
	});

	it("leaves a computer alone while its host could not be asked", () => {
		expect(forgettableComputers([computer("a", "offline")], new Map())).toEqual([]);
		expect(forgettableComputers([computer("a", "offline")], new Map([["elsewhere", []]]))).toEqual([]);
	});
});
