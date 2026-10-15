/**
 * High-stakes sessions in the companion: the mode of each session, the states a quiz has covered, and every decision
 * that follows from them. The companion is the source of truth; the layers around it (omp's command gate, the
 * pre-push hook, the app's buttons) ask it or read what it publishes. Design: docs/collab.md, *High-stakes sessions*.
 *
 * A state is *covered* when its tree equals a passed tree, when its patch against the default branch's merge base is
 * the same patch as a passed one (a rebase), or when it has no changes against the default branch. Otherwise the next
 * quiz covers the changes since the newest covered state only (a *delta*), or the whole patch when nothing is covered.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { QuizAttempt } from "@oh-my-pi/pi-wire/quiz";
import {
	formatStakesState,
	isPassMark,
	quizPassed,
	STAKES_MAX_PASSES,
	STAKES_MAX_PUBLISHED_TREES,
	STAKES_REFUSAL_ASK,
	STAKES_REFUSAL_LEAD,
	STAKES_STATE_DIR,
	type StakesCoveredBy,
	type StakesNeeds,
	type StakesPassInfo,
	type StakesQuizInfo,
	type StakesSettings,
	type StakesStatus,
	stakesStateKey,
} from "@oh-my-pi/pi-wire/stakes";
import { holdCommit, releaseCommits, repoInfo, resolveCommit, snapshotWorkingTree } from "./companion-blueprint-git";
import { type HookStatus, hookStatus, installHook, removeHook, STAKES_INDEX_FILE } from "./companion-stakes-hook";
import { type DiffBase, diffBaseOf, hasCommit, patchId, treeOf } from "./companion-stakes-git";
import {
	type Covered,
	loadStakesFile,
	type SessionStakes,
	saveStakesFile,
	type StakesFile,
} from "./companion-stakes-store";
import type { Quizzes } from "./companion-quiz";
import type { QuizDoc } from "./companion-quiz-store";

const STORE_FILE = "high-stakes.json";
const COMMIT_RE = /^[0-9a-f]{40,64}$/;
const PENDING_PREFIX = "pending:";

export interface StakesDeps {
	/** The agent directory: the store, the state files and the hook's endpoint live in it. */
	agentDir: string;
	now(): number;
	/** The listed session behind an instance id; rejects when there is none. */
	session(instanceId: unknown): Promise<{ sessionId: string; cwd: string }>;
	quizzes: Pick<Quizzes, "createForStakes" | "summary" | "get">;
	/** A session's status changed: tell the devices. */
	changed(sessionId: string): void;
	log?(message: string): void;
}

/** A listed session, as {@link Stakes.tick} reads it. */
export interface StakesSessionRow {
	sessionId: string;
	cwd: string;
}

export type StakesAction = "push" | "pr" | "merge";

interface Evaluation {
	/** Tree of the evaluated commit. */
	tree: string;
	commit: string;
	covered: boolean;
	by?: StakesCoveredBy;
	needs: StakesNeeds;
	base?: DiffBase;
	/** The newest covered state a delta quiz starts from. */
	from?: Covered;
	error?: string;
}

export interface Stakes {
	/** Load the store, drop sessions that were still being started, publish every state file and put the hooks in place. */
	init(): Promise<void>;
	settings(): StakesSettings;
	setPassMark(value: unknown): Promise<StakesSettings>;
	/** The pass mark in force, percent. */
	mark(): number;
	isOn(sessionId: string): boolean;
	/** `rows` with `highStakes: true` on the sessions whose mode is on. */
	markRows<T extends { sessionId: string }>(rows: readonly T[]): (T & { highStakes?: true })[];
	status(instanceId: unknown): Promise<StakesStatus>;
	/** Turn the mode on or off; off needs `confirmOff === true`. `by` names the device, for the log and the marker. */
	set(instanceId: unknown, on: unknown, options: { confirmOff?: unknown; by: string }): Promise<StakesStatus>;
	/** The quiz for exactly the diff that is needed: the one that exists, or a new one. */
	quiz(instanceId: unknown): Promise<{ id: string; delta: boolean; created: boolean }>;
	/** Throw when the session is high stakes and the commit (default HEAD) is not covered. */
	guard(instanceId: unknown, action: StakesAction, commit?: string): Promise<void>;
	/** The pre-push hook's question: the folder of the push, then one commit per line. */
	prePush(body: string): Promise<{ allow: boolean; message: string }>;
	/** An attempt at a stakes quiz was answered: true when it finished above the pass mark, and the pass is recorded. */
	finished(doc: QuizDoc, attempt: QuizAttempt): Promise<boolean>;
	/** Keep the checkouts, hooks and covered states of the listed high-stakes sessions current. */
	tick(rows: readonly StakesSessionRow[]): Promise<void>;
	/** A session is about to start in `cwd` with the mode on: gate the folder at once. Resolves with a handle for {@link adopt} and {@link discard}. */
	expect(cwd: string, by: string): Promise<string>;
	/** The session the handle was for now has an id. */
	adopt(handle: string, sessionId: string): Promise<void>;
	/** The session never started. */
	discard(handle: string): Promise<void>;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Entries of `lists[0]` that every other list holds, in the first list's order. */
function intersect(lists: readonly (readonly string[])[]): string[] {
	if (lists.length === 0) return [];
	const rest = lists.slice(1).map(list => new Set(list));
	return lists[0]!.filter(item => rest.every(set => set.has(item)));
}

function describeNeed(ev: Evaluation): string {
	if (ev.error) return ev.error;
	return ev.needs === "delta"
		? "The changes since the last passed quiz are not covered yet."
		: "No passed quiz covers this session's changes yet.";
}

export function createStakes(deps: StakesDeps): Stakes {
	const storeFile = path.join(deps.agentDir, STORE_FILE);
	const stateDir = path.join(deps.agentDir, STAKES_STATE_DIR);
	const log = deps.log ?? (() => undefined);
	let file: StakesFile | undefined;
	let queue: Promise<unknown> = Promise.resolve();
	/** What each checkout's state file last said, so an unchanged one is not rewritten or given a new revision. */
	const published = new Map<string, string>();
	const patchIds = new Map<string, string | null>();
	const lastHead = new Map<string, string>();

	const need = (): StakesFile => {
		if (file === undefined) throw new Error("High-stakes state is not loaded yet.");
		return file;
	};

	const holdId = (sessionId: string, tree: string): string =>
		`stakes/${crypto.createHash("sha1").update(sessionId).digest("hex").slice(0, 10)}/${tree.slice(0, 16)}`;

	/** Publish every checkout's state file that changed, and the index of them. */
	async function publishAll(): Promise<void> {
		const current = need();
		const byCheckout = new Map<string, SessionStakes[]>();
		for (const record of Object.values(current.sessions)) {
			const list = byCheckout.get(record.checkout) ?? [];
			list.push(record);
			byCheckout.set(record.checkout, list);
		}
		await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
		const keys: string[] = [];
		for (const [checkout, records] of byCheckout) {
			const gated = records.filter(record => record.on);
			const last = records.reduce((a, b) => (b.at >= a.at ? b : a));
			const trees = intersect(gated.map(record => record.covered.map(covered => covered.tree))).slice(
				0,
				STAKES_MAX_PUBLISHED_TREES,
			);
			const body = {
				on: gated.length > 0,
				checkout,
				passMark: current.passMark,
				by: last.by,
				at: last.at,
				trees,
			};
			const key = stakesStateKey(checkout);
			keys.push(`${key}\t${checkout}`);
			const signature = JSON.stringify(body);
			if (published.get(key) === signature) continue;
			current.rev++;
			const target = path.join(stateDir, key);
			const temp = `${target}.${process.pid}.tmp`;
			await fs.writeFile(temp, formatStakesState({ rev: current.rev, ...body }), { mode: 0o600 });
			await fs.rename(temp, target);
			published.set(key, signature);
		}
		const live = new Set(keys.map(line => line.split("\t")[0]!));
		for (const key of published.keys()) {
			if (live.has(key)) continue;
			await fs.rm(path.join(stateDir, key), { force: true });
			published.delete(key);
		}
		const index = path.join(stateDir, STAKES_INDEX_FILE);
		await fs.writeFile(`${index}.tmp`, `${keys.join("\n")}${keys.length > 0 ? "\n" : ""}`, { mode: 0o600 });
		await fs.rename(`${index}.tmp`, index);
	}

	/** Run `change` on the store, then publish and save it; changes run one after the other. */
	function mutate<T>(change: (current: StakesFile) => T | Promise<T>): Promise<T> {
		const run = queue.then(async () => {
			const current = need();
			const result = await change(current);
			await publishAll();
			await saveStakesFile(storeFile, current);
			return result;
		});
		queue = run.catch(() => undefined);
		return run;
	}

	function record(sessionId: string): SessionStakes | undefined {
		return need().sessions[sessionId];
	}

	/** Put `entry` first in a session's covered states, replacing an older entry for the same tree and holding its commit. */
	async function cover(sessionId: string, entry: Covered): Promise<void> {
		const rec = record(sessionId);
		if (!rec) return;
		await holdCommit(rec.root, holdId(sessionId, entry.tree), "head", entry.commit);
		const rest = rec.covered.filter(covered => covered.tree !== entry.tree);
		rec.covered = [entry, ...rest];
		for (const dropped of rec.covered.splice(STAKES_MAX_PASSES))
			await releaseCommits(rec.root, holdId(sessionId, dropped.tree)).catch(() => undefined);
	}

	async function patchIdOf(root: string, base: string, head: string): Promise<string | null> {
		const key = `${base}:${head}`;
		if (patchIds.has(key)) return patchIds.get(key) ?? null;
		const id = await patchId(root, base, head);
		if (patchIds.size > 500) patchIds.clear();
		patchIds.set(key, id);
		return id;
	}

	/** Whether `commit` is covered for session `sessionId`, and what the next quiz must cover when it is not. */
	async function evaluate(sessionId: string, commit: string): Promise<Evaluation> {
		const rec = record(sessionId);
		if (!rec) throw new Error("This session is not high stakes.");
		const tree = await treeOf(rec.checkout, commit);
		if (tree === null)
			return { tree: "", commit, covered: false, needs: "full", error: "The commit could not be read." };
		const direct = rec.covered.find(covered => covered.tree === tree);
		if (direct)
			return { tree, commit, covered: true, by: direct.via === "pass" ? "pass" : "same-diff", needs: "none" };
		const found = await diffBaseOf(rec.root, commit);
		if ("error" in found) return { tree, commit, covered: false, needs: "full", error: found.error };
		const { base } = found;
		if (base.tree === tree) return { tree, commit, covered: true, by: "nothing-to-publish", needs: "none", base };
		const id = await patchIdOf(rec.root, base.commit, commit);
		if (id !== null && rec.covered.some(covered => covered.diffId === id)) {
			await mutate(() => cover(sessionId, { tree, commit, diffId: id, via: "same-diff", at: deps.now() }));
			return { tree, commit, covered: true, by: "same-diff", needs: "none", base };
		}
		for (const covered of rec.covered) {
			if (covered.tree !== tree && (await hasCommit(rec.root, covered.commit)))
				return { tree, commit, covered: false, needs: "delta", base, from: covered };
		}
		return { tree, commit, covered: false, needs: "full", base };
	}

	/** The session's folder resolved to its checkout, for a record. */
	async function placeOf(cwd: string): Promise<{ checkout: string; root: string }> {
		try {
			const info = await repoInfo(cwd);
			return { checkout: info.checkout, root: info.root };
		} catch {
			const real = await fs.realpath(cwd).catch(() => cwd);
			return { checkout: real, root: real };
		}
	}

	/** Put the hook in place unless it is (a hook that cannot be installed reports why instead of throwing). */
	async function ensureHook(rec: SessionStakes): Promise<HookStatus> {
		try {
			const present = await hookStatus(rec.root, deps.agentDir);
			return present.state === "missing" ? await installHook(rec.root, deps.agentDir) : present;
		} catch (err) {
			return { state: "unavailable", note: `The pre-push hook could not be installed: ${errorText(err)}` };
		}
	}

	/** Take the hook out of every repository that no longer has a high-stakes session. */
	async function releaseHooks(roots: readonly string[]): Promise<void> {
		const current = need();
		for (const root of new Set(roots)) {
			if (Object.values(current.sessions).some(rec => rec.on && rec.root === root)) continue;
			await removeHook(root).catch(err => log(`removing the pre-push hook in ${root} failed: ${errorText(err)}`));
		}
	}

	function passedOf(rec: SessionStakes): StakesPassInfo | undefined {
		const pass = rec.covered.find(covered => covered.via === "pass");
		if (!pass || pass.quizId === undefined || pass.points === undefined || pass.total === undefined) return undefined;
		return { at: pass.at, quizId: pass.quizId, points: pass.points, total: pass.total, delta: pass.delta === true };
	}

	async function quizInfo(rec: SessionStakes, ev: Evaluation): Promise<StakesQuizInfo | undefined> {
		if (ev.covered) return undefined;
		const baseCommit = ev.from?.commit ?? ev.base?.commit;
		const binding = rec.quizzes.find(
			item => item.headTree === ev.tree && item.baseCommit === baseCommit && deps.quizzes.summary(item.quizId),
		);
		if (!binding) return undefined;
		const summary = deps.quizzes.summary(binding.quizId);
		if (!summary) return undefined;
		let best: StakesQuizInfo["best"];
		if (summary.status === "ready") {
			const { quiz, attempts } = await deps.quizzes.get(binding.quizId).catch(() => ({ quiz: null, attempts: [] }));
			if (quiz) {
				for (const attempt of attempts) {
					if (attempt.finishedAt === undefined || attempt.questions.length !== quiz.questions.length) continue;
					const { points, total } = attempt.score;
					if (best === undefined || points / total > best.points / best.total) best = { points, total };
				}
			}
		}
		return {
			id: binding.quizId,
			status: summary.status,
			delta: binding.delta,
			...(best ? { best } : {}),
			...(summary.error ? { error: summary.error } : {}),
		};
	}

	function statusOf(sessionId: string, rec: SessionStakes | undefined): StakesStatus {
		return {
			sessionId,
			on: rec?.on === true,
			passMark: need().passMark,
			covered: true,
			needs: "none",
			hook: "installed",
			message: "",
		};
	}

	async function currentStatus(
		instanceId: unknown,
	): Promise<{ status: StakesStatus; ev?: Evaluation; rec?: SessionStakes; sessionId: string; checkout?: string }> {
		const { sessionId, cwd } = await deps.session(instanceId);
		const rec = record(sessionId);
		const status = statusOf(sessionId, rec);
		if (!rec?.on) return { status, sessionId };
		const place = await placeOf(cwd);
		if (place.checkout !== rec.checkout || place.root !== rec.root)
			await mutate(() => {
				rec.checkout = place.checkout;
				rec.root = place.root;
			});
		const hook = await ensureHook(rec);
		status.hook = hook.state;
		if (hook.note) status.hookNote = hook.note;
		status.passed = passedOf(rec);
		let commit: string;
		try {
			commit = await snapshotWorkingTree(rec.checkout);
		} catch (err) {
			status.covered = true;
			status.error = errorText(err);
			status.message = status.error;
			return { status, rec, sessionId, checkout: rec.checkout };
		}
		const ev = await evaluate(sessionId, commit);
		status.covered = ev.covered;
		status.needs = ev.needs;
		if (ev.by) status.coveredBy = ev.by;
		if (ev.error) status.error = ev.error;
		if (!ev.covered) {
			status.message = ev.error
				? ev.error
				: ev.needs === "delta"
					? "Pass a quiz on the changes since your last pass to push."
					: "Pass a quiz on this session's changes to push.";
			const quiz = await quizInfo(rec, ev);
			if (quiz) status.quiz = quiz;
		}
		return { status, ev, rec, sessionId, checkout: rec.checkout };
	}

	function refusal(ev: Evaluation): string {
		return `${STAKES_REFUSAL_LEAD} ${describeNeed(ev)} ${STAKES_REFUSAL_ASK}`;
	}

	return {
		async init() {
			file = await loadStakesFile(storeFile);
			const current = file;
			for (const id of Object.keys(current.sessions)) if (id.startsWith(PENDING_PREFIX)) delete current.sessions[id];
			await publishAll();
			await saveStakesFile(storeFile, current);
			for (const rec of Object.values(current.sessions)) {
				if (!rec.on) continue;
				const hook = await ensureHook(rec);
				if (hook.state === "unavailable") log(`high stakes: ${hook.note ?? "no pre-push hook"}`);
			}
		},

		settings() {
			return { passMark: need().passMark };
		},

		mark() {
			return need().passMark;
		},

		async setPassMark(value) {
			if (!isPassMark(value)) throw new Error("The pass mark is a whole percent from 50 to 100.");
			await mutate(current => {
				current.passMark = value;
			});
			return { passMark: value };
		},

		isOn(sessionId) {
			return record(sessionId)?.on === true;
		},

		markRows(rows) {
			return rows.map(row => (record(row.sessionId)?.on ? { ...row, highStakes: true as const } : row));
		},

		async status(instanceId) {
			return (await currentStatus(instanceId)).status;
		},

		async set(instanceId, on, options) {
			if (typeof on !== "boolean") throw new Error("invalid request");
			if (!on && options.confirmOff !== true) throw new Error("Turning high stakes off needs confirmation.");
			const { sessionId, cwd } = await deps.session(instanceId);
			const existing = record(sessionId);
			if (existing?.on !== on && !(existing === undefined && !on)) {
				const place = await placeOf(cwd);
				await mutate(current => {
					const rec = current.sessions[sessionId] ?? {
						on,
						checkout: place.checkout,
						root: place.root,
						by: "",
						at: 0,
						covered: [],
						quizzes: [],
					};
					rec.on = on;
					rec.checkout = place.checkout;
					rec.root = place.root;
					rec.by = options.by;
					rec.at = deps.now();
					current.sessions[sessionId] = rec;
				});
				log(
					`high stakes ${on ? "turned on" : "turned off"} for session ${sessionId} by ${options.by || "a device"}`,
				);
				const rec = record(sessionId)!;
				if (on) await ensureHook(rec);
				else await releaseHooks([rec.root]);
				deps.changed(sessionId);
			}
			return (await currentStatus(instanceId)).status;
		},

		async quiz(instanceId) {
			const { status, ev, rec, sessionId } = await currentStatus(instanceId);
			if (!status.on || !rec) throw new Error("This session is not high stakes.");
			if (ev === undefined || status.covered)
				throw new Error("The session's changes are already covered: nothing to quiz.");
			if (ev.error) throw new Error(ev.error);
			const base = ev.from ? { commit: ev.from.commit, tree: ev.from.tree } : ev.base;
			if (!base) throw new Error("There is nothing to compare the changes with.");
			const delta = ev.needs === "delta";
			const known = rec.quizzes.find(
				item =>
					item.headTree === ev.tree &&
					item.baseCommit === base.commit &&
					deps.quizzes.summary(item.quizId)?.status !== "failed" &&
					deps.quizzes.summary(item.quizId),
			);
			if (known) return { id: known.quizId, delta: known.delta, created: false };
			const created = await deps.quizzes.createForStakes({
				cwd: rec.checkout,
				sessionId,
				head: { commit: ev.commit, ref: "@worktree", subject: "Working tree" },
				base: {
					commit: base.commit,
					ref: ev.from ? undefined : ev.base?.ref,
					subject: delta ? "Last passed state" : undefined,
				},
				stakes: {
					sessionId,
					headTree: ev.tree,
					headCommit: ev.commit,
					baseCommit: base.commit,
					baseTree: base.tree,
					delta,
				},
			});
			await mutate(() => {
				rec.quizzes = [
					{ quizId: created.id, headTree: ev.tree, baseCommit: base.commit, delta, at: deps.now() },
					...rec.quizzes,
				].slice(0, 20);
			});
			deps.changed(sessionId);
			return { id: created.id, delta, created: true };
		},

		async guard(instanceId, action, commit) {
			const { sessionId, cwd } = await deps.session(instanceId);
			const rec = record(sessionId);
			if (!rec?.on) return;
			const place = await placeOf(cwd);
			let target: string | null;
			if (commit === undefined) target = await resolveCommit(place.checkout, "HEAD");
			else {
				// A pull request's head the checkout does not hold cannot be matched to a quiz: refuse rather than guess.
				target = COMMIT_RE.test(commit) ? await resolveCommit(place.checkout, commit) : null;
				if (target === null)
					throw new Error(
						"This session is high stakes, and the pull request's head is not in this checkout, so no quiz can cover it. Fetch it, or push the branch from here, then try again.",
					);
			}
			if (target === null) throw new Error("This repository has no commits yet.");
			const ev = await evaluate(sessionId, target);
			if (ev.covered) return;
			const verb = action === "push" ? "pushing" : action === "pr" ? "opening a pull request" : "merging";
			throw new Error(
				`This session is high stakes, so ${verb} needs a passed quiz. ${describeNeed(ev)} Use Take the quiz.`,
			);
		},

		async prePush(body) {
			const [cwd, ...rest] = body.split("\n").map(line => line.trim());
			const shas = rest.filter(line => line !== "");
			if (!cwd || shas.some(sha => !COMMIT_RE.test(sha)))
				return { allow: false, message: "The pre-push hook sent a request the companion could not read." };
			const place = await placeOf(cwd);
			const gated = Object.entries(need().sessions).filter(([, rec]) => rec.on && rec.checkout === place.checkout);
			if (gated.length === 0) return { allow: true, message: "" };
			for (const sha of shas) {
				const commit = await resolveCommit(place.checkout, sha);
				for (const [sessionId] of gated) {
					if (commit === null)
						return {
							allow: false,
							message: `${STAKES_REFUSAL_LEAD} ${sha.slice(0, 8)} could not be read. ${STAKES_REFUSAL_ASK}`,
						};
					const ev = await evaluate(sessionId, commit);
					if (!ev.covered) return { allow: false, message: refusal(ev) };
				}
			}
			return { allow: true, message: "" };
		},

		async finished(doc, attempt) {
			const stakes = doc.stakes;
			if (!stakes) return false;
			if (stakes.passedAttempt !== undefined) return true;
			if (attempt.finishedAt === undefined || attempt.questions.length !== doc.quiz.questions.length) return false;
			if (!quizPassed(attempt.score.points, attempt.score.total, need().passMark)) return false;
			const rec = record(stakes.sessionId);
			if (!rec) return false;
			if (stakes.delta && !rec.covered.some(covered => covered.tree === stakes.baseTree)) {
				log(
					`high stakes: quiz ${doc.id} starts from a state that is no longer covered, so its pass was not recorded`,
				);
				return false;
			}
			const found = await diffBaseOf(rec.root, stakes.headCommit);
			const diffId = "base" in found ? await patchIdOf(rec.root, found.base.commit, stakes.headCommit) : null;
			await mutate(() =>
				cover(stakes.sessionId, {
					tree: stakes.headTree,
					commit: stakes.headCommit,
					...(diffId ? { diffId } : {}),
					via: "pass",
					at: deps.now(),
					quizId: doc.id,
					attempt: attempt.id,
					points: attempt.score.points,
					total: attempt.score.total,
					delta: stakes.delta,
				}),
			);
			log(
				`high stakes: session ${stakes.sessionId} passed quiz ${doc.id} (${attempt.score.points}/${attempt.score.total})`,
			);
			deps.changed(stakes.sessionId);
			return true;
		},

		async tick(rows) {
			const current = need();
			for (const row of rows) {
				const rec = current.sessions[row.sessionId];
				if (!rec?.on) continue;
				try {
					const place = await placeOf(row.cwd);
					if (place.checkout !== rec.checkout || place.root !== rec.root) {
						await mutate(() => {
							rec.checkout = place.checkout;
							rec.root = place.root;
						});
					}
					if ((await hookStatus(rec.root, deps.agentDir)).state === "missing") await ensureHook(rec);
					const head = await resolveCommit(rec.checkout, "HEAD");
					if (head === null) continue;
					const tree = await treeOf(rec.checkout, head);
					if (tree === null || lastHead.get(row.sessionId) === tree) continue;
					lastHead.set(row.sessionId, tree);
					const before = rec.covered.length;
					await evaluate(row.sessionId, head);
					if (rec.covered.length !== before) deps.changed(row.sessionId);
				} catch (err) {
					log(`high stakes: checking session ${row.sessionId} failed: ${errorText(err)}`);
				}
			}
		},

		async expect(cwd, by) {
			const place = await placeOf(cwd);
			const handle = `${PENDING_PREFIX}${crypto.randomUUID()}`;
			await mutate(current => {
				current.sessions[handle] = {
					on: true,
					checkout: place.checkout,
					root: place.root,
					by,
					at: deps.now(),
					covered: [],
					quizzes: [],
				};
			});
			await ensureHook(record(handle)!);
			return handle;
		},

		async adopt(handle, sessionId) {
			await mutate(current => {
				const pending = current.sessions[handle];
				if (!pending) return;
				delete current.sessions[handle];
				const existing = current.sessions[sessionId];
				current.sessions[sessionId] = existing
					? { ...existing, on: true, by: pending.by, at: pending.at }
					: pending;
			});
			deps.changed(sessionId);
		},

		async discard(handle) {
			const root = record(handle)?.root;
			await mutate(current => {
				delete current.sessions[handle];
			});
			if (root) await releaseHooks([root]);
		},
	};
}
