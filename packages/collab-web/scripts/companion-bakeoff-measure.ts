/**
 * Measured facts of an implementation entry (docs/design-review.md, *Measured facts*): what the companion finds out
 * itself after the entry settles, never what the entry reports. Diff size comes from `git diff --numstat` against the
 * same base for every entry; the test and the benchmark are run targets (a fixed argv from the repository's own
 * scripts, never free text) started through the run manager under a synthetic session key.
 *
 * Cheating and breakage are flagged, not hidden: an entry that changed the script of the target is `unverified`,
 * and a run that cannot start, times out or fails to give a number is recorded as that and never counted as a pass.
 */

import type { BakeoffFacts } from "@oh-my-pi/pi-wire/bakeoff";
import { git, gitFailure } from "./companion-git";
import type { RunManager } from "./companion-run";
import type { RunInfo, RunTarget } from "../src/lib/companion";

export const TEST_TIMEOUT_MS = 15 * 60_000;
export const BENCH_TIMEOUT_MS = 10 * 60_000;
export const BENCH_RUNS = 3;
/** The end of a benchmark's output that `valueRegex` is applied to. */
const TAIL_CHARS = 4_096;
const MAX_REGEX_CHARS = 200;

export const SCRIPT_CHANGED = "test script changed";

/** `files`, `+`, `−` of `git diff --numstat -M base head` (binary files count as a file with no lines). */
export async function numstat(
	root: string,
	base: string,
	head: string,
): Promise<{ files: number; added: number; removed: number }> {
	const result = await git(root, ["diff", "--numstat", "-M", "--no-color", "--no-ext-diff", base, head, "--"], {
		maxBytes: 16 * 1024 * 1024,
	});
	if (result.code !== 0) throw gitFailure(result, "git diff");
	let files = 0;
	let added = 0;
	let removed = 0;
	for (const line of new TextDecoder().decode(result.out).split("\n")) {
		const [a, r] = line.split("\t");
		if (a === undefined || r === undefined) continue;
		files++;
		if (/^\d+$/.test(a)) added += Number(a);
		if (/^\d+$/.test(r)) removed += Number(r);
	}
	return { files, added, removed };
}

export interface MeasureDeps {
	runs: Pick<RunManager, "start" | "finished" | "stop" | "output" | "targets">;
	/** Refuses a root a sandboxed session works in (`checkRunnableRoot`); rejects with the reason. */
	checkRoot?(root: string): Promise<void>;
	/** Resolves after `ms`; tests make it quick. */
	sleep?(ms: number): Promise<void>;
	testTimeoutMs?: number;
	benchTimeoutMs?: number;
}

/** A target as the person confirmed it. */
export interface TargetChoice {
	target: string;
	detail?: string;
}

/** Why a run did not give a result, in plain words. */
function failureReason(info: RunInfo): string {
	if (info.state === "failed") return "it could not be started";
	if (info.state === "stopped") return "it was stopped";
	if (info.signal) return `it was killed (${info.signal})`;
	return `it exited with code ${info.exitCode ?? "unknown"}`;
}

/** Run `target` in `root` and wait for it; the run is stopped when it outlasts `timeoutMs`. */
async function runTarget(
	deps: MeasureDeps,
	key: string,
	root: string,
	choice: TargetChoice,
	timeoutMs: number,
): Promise<{ info: RunInfo; timedOut: boolean }> {
	await deps.checkRoot?.(root);
	const started = await deps.runs.start(key, root, choice.target, choice.detail);
	const timeout = Symbol("timeout");
	const sleep = deps.sleep ?? Bun.sleep;
	const first = await Promise.race([deps.runs.finished(started.runId), sleep(timeoutMs).then(() => timeout)]);
	if (first !== timeout) return { info: first as RunInfo, timedOut: false };
	deps.runs.stop(started.runId);
	return { info: await deps.runs.finished(started.runId), timedOut: true };
}

/** The last `chars` characters a run printed. */
async function tailOf(runs: MeasureDeps["runs"], runId: string, chars: number): Promise<string> {
	let from = 0;
	let tail = "";
	for (;;) {
		const page = runs.output(runId, from);
		tail = (tail + page.text).slice(-chars);
		if (page.next <= from) break;
		from = page.next;
	}
	return tail;
}

/**
 * Whether an entry changed the script the target runs: the entry's tree must list the target with the same command
 * and the same body (`detail`) the person confirmed. `reference` are the targets of the original's tree.
 */
export function scriptChanged(
	reference: readonly RunTarget[],
	entry: readonly RunTarget[],
	choice: TargetChoice,
): boolean {
	const was = reference.find(target => target.id === choice.target);
	const now = entry.find(target => target.id === choice.target);
	return !was || !now || was.command !== now.command || was.detail !== now.detail;
}

export interface TestInput {
	deps: MeasureDeps;
	/** Session key the runs are filed under: `bk-<id>-<label>`. */
	key: string;
	/** The entry's folder. */
	root: string;
	choice: TargetChoice;
	/** Targets of the original's tree. */
	reference: readonly RunTarget[];
	/** Start from the base: the original's new tests are not in the entry. */
	baseOnly: boolean;
}

/** Run the test target in an entry's folder. */
export async function measureTests(
	input: TestInput,
): Promise<{ tests: NonNullable<BakeoffFacts["tests"]>; flags: string[] }> {
	const { deps, choice } = input;
	let entryTargets: RunTarget[];
	try {
		entryTargets = await deps.runs.targets(input.root);
	} catch (err) {
		return {
			tests: { target: choice.target, ok: null, reason: err instanceof Error ? err.message : String(err) },
			flags: [],
		};
	}
	if (scriptChanged(input.reference, entryTargets, choice))
		return {
			tests: { target: choice.target, ok: null, reason: "the test script was changed in this entry" },
			flags: [SCRIPT_CHANGED],
		};
	const note = input.baseOnly ? "ran the base's tests only" : undefined;
	try {
		const { info, timedOut } = await runTarget(
			deps,
			input.key,
			input.root,
			choice,
			deps.testTimeoutMs ?? TEST_TIMEOUT_MS,
		);
		if (timedOut) return { tests: { target: choice.target, ok: null, reason: "timed out", note }, flags: [] };
		const ok = info.state === "exited" && info.exitCode === 0;
		return {
			tests: {
				target: choice.target,
				ok,
				...(ok ? {} : { reason: failureReason(info) }),
				...(note ? { note } : {}),
			},
			flags: [],
		};
	} catch (err) {
		return {
			tests: {
				target: choice.target,
				ok: null,
				reason: err instanceof Error ? err.message : String(err),
				...(note ? { note } : {}),
			},
			flags: [],
		};
	}
}

export interface BenchInput extends Omit<TestInput, "baseOnly" | "choice"> {
	choice: TargetChoice;
	better: "lower" | "higher";
	/** A number captured from the last 4 KB of output (first group, else the whole match); default: the wall time. */
	valueRegex?: string;
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A regex a person supplied, compiled; undefined when it is invalid or too long. */
export function compileValueRegex(source: string | undefined): RegExp | undefined {
	if (source === undefined || source === "" || source.length > MAX_REGEX_CHARS) return undefined;
	try {
		return new RegExp(source, "g");
	} catch {
		return undefined;
	}
}

/** The number a benchmark printed at its end, by `regex`; null when it did not print one. */
export function captureValue(tail: string, regex: RegExp): number | null {
	let found: RegExpExecArray | null = null;
	for (const match of tail.matchAll(new RegExp(regex.source, regex.flags))) found = match;
	if (!found) return null;
	const value = Number((found[1] ?? found[0]).replace(/[,_\s]/g, ""));
	return Number.isFinite(value) ? value : null;
}

/** Run the benchmark target {@link BENCH_RUNS} times in an entry's folder: the value is the median. */
export async function measureBench(
	input: BenchInput,
): Promise<{ bench: NonNullable<BakeoffFacts["bench"]>; flags: string[] }> {
	const { deps, choice } = input;
	const base = { target: choice.target, better: input.better, runs: [] as number[], value: null as number | null };
	const regex = compileValueRegex(input.valueRegex);
	if (input.valueRegex !== undefined && input.valueRegex !== "" && !regex)
		return { bench: { ...base, reason: "the benchmark's value pattern is not valid" }, flags: [] };
	let entryTargets: RunTarget[];
	try {
		entryTargets = await deps.runs.targets(input.root);
	} catch (err) {
		return { bench: { ...base, reason: err instanceof Error ? err.message : String(err) }, flags: [] };
	}
	if (scriptChanged(input.reference, entryTargets, choice))
		return {
			bench: { ...base, reason: "the benchmark script was changed in this entry" },
			flags: ["benchmark script changed"],
		};
	for (let n = 0; n < BENCH_RUNS; n++) {
		try {
			const { info, timedOut } = await runTarget(
				deps,
				input.key,
				input.root,
				choice,
				deps.benchTimeoutMs ?? BENCH_TIMEOUT_MS,
			);
			if (timedOut) return { bench: { ...base, reason: "timed out" }, flags: [] };
			if (info.state !== "exited" || info.exitCode !== 0)
				return { bench: { ...base, reason: failureReason(info) }, flags: [] };
			if (regex) {
				const value = captureValue(await tailOf(deps.runs, info.runId, TAIL_CHARS), regex);
				if (value === null)
					return { bench: { ...base, reason: "it printed no number matching the pattern" }, flags: [] };
				base.runs.push(value);
			} else {
				base.runs.push((info.endedAt ?? info.startedAt) - info.startedAt);
			}
		} catch (err) {
			return { bench: { ...base, reason: err instanceof Error ? err.message : String(err) }, flags: [] };
		}
	}
	return { bench: { ...base, value: median(base.runs), ...(regex ? {} : { unit: "ms" }) }, flags: [] };
}
