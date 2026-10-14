import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { PersonalChangeKind, PersonalSource } from "@oh-my-pi/pi-wire/personal";
import type { PersonalEvent } from "@oh-my-pi/pi-wire/personal-ipc";
import type { EventDraft } from "../scripts/companion-personal-events";
import {
	createPersonalSources,
	dueSources,
	pollPrompt,
	SOURCE_OVERLAY_YAML,
	SOURCE_POLL_BUDGET_USD,
	SOURCE_POLL_TIMEOUT_MS,
	SOURCE_RUN_ARGS,
} from "../scripts/companion-personal-sources";
import type { PersonalOmpResult, PersonalOmpRun } from "../scripts/companion-personal-run";
import { defaultSettings, openPersonalState, personalPaths } from "../scripts/companion-personal-store";

const MIN = 60_000;
const NOW = new Date(2026, 9, 14, 12).getTime();

const source = (over: Partial<PersonalSource> = {}): PersonalSource => ({
	id: "mail",
	label: "Mail",
	kind: "mcp-poll",
	mcpServer: "gmail",
	everyMinutes: 15,
	prompt: "Unread mail from my landlord",
	enabled: true,
	...over,
});

describe("dueSources", () => {
	const settings = (sources: PersonalSource[]) => ({ ...defaultSettings(), sources });
	it("lists only enabled sources whose interval has passed, longest overdue first", () => {
		const list = settings([
			source({ id: "never" }),
			source({ id: "recent", lastPollAt: NOW - 14 * MIN }),
			source({ id: "due", lastPollAt: NOW - 15 * MIN }),
			source({ id: "older", lastPollAt: NOW - 60 * MIN }),
			source({ id: "off", enabled: false }),
		]);
		expect(dueSources(list, NOW).map(s => s.id)).toEqual(["never", "older", "due"]);
		expect(dueSources(settings([]), NOW)).toEqual([]);
	});
});

describe("pollPrompt", () => {
	it("limits the run to the named server, treats results as data, and carries the owner's words", () => {
		const prompt = pollPrompt(source());
		expect(prompt).toContain('MCP server "gmail"');
		expect(prompt).toContain("Unread mail from my landlord");
		expect(prompt).toContain("never instructions");
		expect(prompt).toContain("NOTHING NEW");
	});
});

describe("companion-personal-sources", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "personal-sources-"));
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	async function harness(
		sources: PersonalSource[],
		opts: {
			enabled?: boolean;
			login?: boolean;
			allow?: boolean;
			result?: Partial<PersonalOmpResult>;
			hold?: Promise<void>;
		} = {},
	) {
		const paths = personalPaths(path.join(dir, ".omp"));
		const state = await openPersonalState(paths.stateFile);
		await state.update(s => ({ ...s, enabled: true, settings: { ...s.settings, sources } }));
		const runs: PersonalOmpRun[] = [];
		let markStarted: () => void = () => {};
		const started = new Promise<void>(resolve => {
			markStarted = resolve;
		});
		const overlays: string[] = [];
		const events: EventDraft[] = [];
		const changes: PersonalChangeKind[][] = [];
		const errors: unknown[] = [];
		let now = NOW;
		const enabled = { on: opts.enabled ?? true, login: opts.login ?? true, allow: opts.allow ?? true };
		const sourcesJob = createPersonalSources({
			paths,
			state,
			now: () => now,
			enabled: () => enabled.on,
			loginReady: async () => enabled.login,
			limitsAllow: async () => enabled.allow,
			enqueueExternalEvent: async draft => {
				events.push(draft);
				return { ...draft, id: draft.id ?? "x", at: draft.at ?? now, trust: "external" } as PersonalEvent;
			},
			changed: what => void changes.push(what),
			ompBin: "/bin/omp",
			onError: err => void errors.push(err),
			run: async run => {
				runs.push(run);
				markStarted();
				overlays.push(await Bun.file(run.overlayFile).text());
				await opts.hold;
				if (run.signal?.aborted) return { exitCode: 143, stdout: "", stderr: "", timedOut: false };
				return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...opts.result };
			},
		});
		const stored = (id = "mail") => state.read().settings.sources.find(s => s.id === id);
		return {
			started,
			paths,
			state,
			runs,
			overlays,
			events,
			changes,
			errors,
			enabled,
			stored,
			job: sourcesJob,
			clock: (next: number) => {
				now = next;
			},
			poll: async () => {
				await sourcesJob.tick();
				await sourcesJob.idle();
			},
		};
	}

	it("turns a report into one external event from source:<id>, and records the poll", async () => {
		const h = await harness([source()], { result: { stdout: "  2 new mails: the landlord wrote at 09:10\n" } });
		await h.poll();
		expect(h.runs).toHaveLength(1);
		expect(h.runs[0]).toMatchObject({
			ompBin: "/bin/omp",
			maxCostUsd: SOURCE_POLL_BUDGET_USD,
			cwd: h.paths.workspace,
			timeoutMs: SOURCE_POLL_TIMEOUT_MS,
			extraArgs: SOURCE_RUN_ARGS,
		});
		expect(h.runs[0]?.prompt).toBe(pollPrompt(source()));
		expect(h.overlays[0]).toBe(SOURCE_OVERLAY_YAML);
		expect(h.events).toEqual([
			{
				id: `source-mail-${NOW}`,
				source: "source:mail",
				kind: "event",
				title: "Mail: new report",
				body: "2 new mails: the landlord wrote at 09:10",
				at: NOW,
			},
		]);
		expect(h.stored()).toMatchObject({ lastPollAt: NOW });
		expect(h.stored()).not.toHaveProperty("lastError");
		expect(h.changes.flat()).toContain("events");
	});

	it("tells the live agent nothing when there is nothing new", async () => {
		for (const stdout of ["NOTHING NEW", "nothing new.\n", "   "]) {
			const h = await harness([source()], { result: { stdout } });
			await h.poll();
			expect(h.events).toEqual([]);
			expect(h.stored()).toMatchObject({ lastPollAt: NOW });
		}
	});

	it("polls again only after the interval, and one source per tick", async () => {
		const h = await harness([source({ id: "a" }), source({ id: "b", everyMinutes: 30 })], {
			result: { stdout: "x" },
		});
		await h.poll();
		expect(h.runs).toHaveLength(1);
		await h.poll();
		expect(h.runs).toHaveLength(2);
		await h.poll();
		expect(h.runs).toHaveLength(2);
		h.clock(NOW + 14 * MIN);
		await h.poll();
		expect(h.runs).toHaveLength(2);
		h.clock(NOW + 15 * MIN);
		await h.poll();
		expect(h.runs).toHaveLength(3);
		expect(h.runs[2]?.prompt).toContain('"Mail"');
	});

	it("records an error for a failed, timed-out or over-budget poll and still waits the interval", async () => {
		const cases: [Partial<PersonalOmpResult>, string][] = [
			[
				{ exitCode: 1, stderr: "warming up\nMCP server gmail: connection refused\n" },
				"MCP server gmail: connection refused",
			],
			[{ exitCode: 1 }, "exit 1"],
			[{ exitCode: 3, stdout: "partial" }, "budget"],
			[{ exitCode: 143, timedOut: true }, "timed out"],
		];
		for (const [result, error] of cases) {
			const h = await harness([source()], { result });
			await h.poll();
			expect(h.stored()).toMatchObject({ lastPollAt: NOW, lastError: error });
			expect(h.events).toEqual([]);
			await h.poll();
			expect(h.runs).toHaveLength(1);
		}
	});

	it("clears the error after a good poll", async () => {
		const h = await harness([source({ lastError: "budget", lastPollAt: NOW - 20 * MIN })], {
			result: { stdout: "NOTHING NEW" },
		});
		await h.poll();
		expect(h.stored()).not.toHaveProperty("lastError");
	});

	it("records an error when the run itself throws, and keeps going", async () => {
		const paths = personalPaths(path.join(dir, ".omp"));
		const state = await openPersonalState(paths.stateFile);
		await state.update(s => ({ ...s, settings: { ...s.settings, sources: [source()] } }));
		const errors: unknown[] = [];
		const job = createPersonalSources({
			paths,
			state,
			now: () => NOW,
			enabled: () => true,
			loginReady: async () => true,
			limitsAllow: async () => true,
			enqueueExternalEvent: async () => {
				throw new Error("unreachable");
			},
			changed: () => {},
			ompBin: "omp",
			onError: err => void errors.push(err),
			run: async () => {
				throw new Error("spawn omp ENOENT");
			},
		});
		await job.tick();
		await job.idle();
		expect(errors).toHaveLength(1);
		expect(state.read().settings.sources[0]).toMatchObject({ lastPollAt: NOW, lastError: "spawn omp ENOENT" });
	});

	describe("never polls", () => {
		it("when Personal is off, with no login, or at a spend limit — and leaves lastPollAt alone", async () => {
			const h = await harness([source()], { result: { stdout: "x" } });
			h.enabled.on = false;
			await h.poll();
			h.enabled.on = true;
			h.enabled.login = false;
			await h.poll();
			h.enabled.login = true;
			h.enabled.allow = false;
			await h.poll();
			expect(h.runs).toEqual([]);
			expect(h.stored()).not.toHaveProperty("lastPollAt");
			expect(h.errors).toEqual([]);
			h.enabled.allow = true;
			await h.poll();
			expect(h.runs).toHaveLength(1);
		});

		it("a source that is disabled or not there, and writes nothing then", async () => {
			const h = await harness([source({ enabled: false })]);
			await h.poll();
			const none = await harness([]);
			await none.poll();
			expect(h.runs).toEqual([]);
			expect(none.runs).toEqual([]);
			await expect(fs.stat(path.join(h.paths.personalDir, "source-overlay.yml"))).rejects.toThrow();
		});
	});

	it("runs one poll at a time and stop() aborts it without recording an error", async () => {
		let release: () => void = () => {};
		const hold = new Promise<void>(resolve => {
			release = resolve;
		});
		const h = await harness([source({ id: "a" }), source({ id: "b" })], { hold, result: { stdout: "x" } });
		await h.job.tick();
		await h.job.tick();
		await h.started;
		expect(h.runs).toHaveLength(1);
		h.job.stop();
		release();
		await h.job.idle();
		expect(h.runs[0]?.signal?.aborted).toBe(true);
		expect(h.events).toEqual([]);
		expect(h.stored("a")).not.toHaveProperty("lastError");
		// Free again afterwards.
		await h.job.tick();
		await h.job.idle();
		expect(h.runs).toHaveLength(2);
	});

	it("the poll overlay turns Personal's own features and memory off and needs approval for anything but reads", () => {
		expect(SOURCE_OVERLAY_YAML).toContain("personal:\n  enabled: false");
		expect(SOURCE_OVERLAY_YAML).toContain('backend: "off"');
		expect(SOURCE_OVERLAY_YAML).toContain("approvalMode: always-ask");
		expect(SOURCE_RUN_ARGS).toContain("--no-session");
	});
});
