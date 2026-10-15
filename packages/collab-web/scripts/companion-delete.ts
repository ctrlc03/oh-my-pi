/**
 * Deleting omp sessions from the app, with a way back. A session is a transcript, `<timestamp>_<sessionId>.jsonl`, in
 * a folder per project under `<config>/agent/sessions/`, and beside it a folder of the same name without `.jsonl`
 * that holds its subagents' transcripts and its artifacts. Deleting moves both into the companion's trash
 * (`<config>/agent/collab-trash/<trashId>/`, private to the user, with a manifest of where they came from and of
 * everything the companion kept about the session), clears the companion's own records of it (sidebar entry,
 * hidden-message marks, settle records, pull request watches) and, when asked, removes the worktree the companion
 * made for it. The trash is emptied after {@link TRASH_KEEP_MS}; until then {@link SessionDelete.restore} puts it all
 * back, refusing when the original place has been taken.
 *
 * What it will not do, whatever a device asks:
 * - The device names sessions by id only. The files are found here, by listing the sessions folder, and every path
 *   is checked: the project folder must be a real folder inside the (symlink-resolved) sessions folder, the
 *   transcript a regular file in it, the artifacts folder a real folder beside it. A link anywhere refuses the
 *   session: nothing is followed, nothing outside the sessions folder is ever moved.
 * - A session file can be rewritten by a sandboxed agent, so nothing read from one is used as a path. The worktree
 *   comes from what the companion recorded when it started the session (see ./companion-settle), the trash path
 *   from the id of a trash entry and the manifest's two plain names.
 * - The Personal agent's session is refused, a session running in a terminal the companion did not start is refused,
 *   and so is one another process has open. A running session the companion started is ended first.
 * - A worktree goes through the same checks as the app's own *Remove worktree* (inside the folders the companion makes
 *   worktrees in, a linked worktree, nothing running in it, no uncommitted changes) and is never forced; one that
 *   another session also used, or that a cleanup command is running in, stays.
 *
 * Work for one session runs under the caller's per-session lock, the same one settling and ending a session take.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionDeletePlan, SessionDeleteResult } from "../src/lib/companion";
import type { Stats } from "node:fs";
import { type HiddenDoc, parseHidden } from "../src/lib/hidden-messages";
import { type OrgEntry, parseOrg } from "../src/lib/session-org";
import { isInside } from "./companion-git";
import type { OrgRecord, SessionOrg } from "./companion-sessionorg";
import { SAFE_ID_RE } from "./companion-sessions";
import type { SettleRecord, SettleCleanup } from "./companion-settle";
import type { HiddenMessages } from "./companion-hidden";
import { parseSettleState } from "./companion-settle";

/** Deleted sessions stay restorable this long. */
export const TRASH_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** How often the companion empties the trash of what is older than that. */
export const TRASH_PURGE_EVERY_MS = 24 * 60 * 60 * 1000;
/** Sessions one request may name. */
export const MAX_DELETE_IDS = 200;
/** How long an ended session may take to leave the listing and let go of its file. */
const STOP_WAIT_MS = 15_000;
const STOP_POLL_MS = 250;
const MAX_REASON_CHARS = 240;

const MANIFEST = "manifest.json";
const TRANSCRIPT = "transcript.jsonl";
const ARTIFACTS = "artifacts";
const WATCH_FILE = "pr-watch.json";
const WATCH_INBOX = "pr-inbox";
/** A name of the trash's own lock; not a session id, so it never collides with one. */
const TRASH_LOCK = "trash:";

/** An omp process, hosting collab or idle, as the companion lists it. */
export interface LiveInstance {
	instanceId: string;
	sessionId: string;
}

export interface SessionDeleteDeps {
	/** `<config>/agent/sessions`. */
	sessionsDir: string;
	/** `<config>/agent/collab-trash`. */
	trashDir: string;
	/** `<config>/run/pr-watch`, where sessions publish their pull request watches. */
	prWatchDir: string;
	/** Folders of other agents' sessions (the Personal agent's profile): a session found in or around one is never touched. */
	protectedDirs(): readonly string[];
	now(): number;
	/** Runs the work of one session after the earlier work for the same id; the settle and end paths use the same lock. */
	lock<T>(key: string, work: () => Promise<T>): Promise<T>;
	/** The Personal agent's session. */
	isPersonal(sessionId: string): boolean;
	/** A fresh listing of the omp processes. */
	live(): Promise<readonly LiveInstance[]>;
	/** The companion started this process (it runs in the tmux session the companion made), so it may end it. */
	startedHere(instanceId: string): Promise<boolean>;
	/** End a process the companion started. */
	stop(instanceId: string): Promise<void>;
	/** How many omp processes other than the companion have the session open (its transcript open for writing, or named in the arguments). */
	holders(sessionId: string, file: string): Promise<number>;
	org: Pick<SessionOrg, "record" | "forget" | "unforget">;
	hidden: Pick<HiddenMessages, "doc" | "forget" | "restore">;
	settle: Pick<SettleCleanup, "record" | "forget" | "restore" | "sessionsIn" | "cleaning">;
	/** The worktree the companion made for this session, when it recorded one and the folder still is that worktree; null otherwise. */
	worktree(sessionId: string): Promise<string | null>;
	/** Remove a worktree the way the app's own *Remove worktree* does: never forced, refused when anything runs in it or it has changes. */
	removeWorktree(tree: string): Promise<void>;
	/** Forget what message search cached of a transcript. */
	forgetSearch(file: string): void;
	/** A record could not be updated after the files were moved; the deletion still stands. */
	onError(err: unknown): void;
	/** Test seams. */
	rename?(from: string, to: string): Promise<void>;
	sleep?(ms: number): Promise<void>;
}

export interface SessionDelete {
	/** Per session: why it cannot be deleted, whether it is running, and the worktree that could go with it. */
	plan(sessionIds: unknown): Promise<SessionDeletePlan[]>;
	/** Delete the sessions one after another (a worktree last, once its sessions are gone); one answer per session. */
	delete(sessionIds: unknown, removeWorktree: unknown): Promise<SessionDeleteResult[]>;
	/** Put a deleted session back; resolves with its session id, rejects with the reason when it cannot. */
	restore(trashId: unknown): Promise<string>;
	/** Remove the trash entries older than {@link TRASH_KEEP_MS}; resolves with how many went. */
	purge(): Promise<number>;
}

/** What the trash keeps beside the files, enough to put the session back. */
interface Manifest {
	v: 1;
	trashId: string;
	sessionId: string;
	deletedAt: number;
	/** The project folder under the sessions folder, one name. */
	projectDir: string;
	/** The transcript's file name in it. */
	name: string;
	artifacts: boolean;
	prWatch: { watch: boolean; inbox: boolean };
	org: OrgRecord;
	hidden: HiddenDoc | null;
	settle: SettleRecord;
}

/** A session found in the sessions folder, by the names the listing gave. */
interface Found {
	projectDir: string;
	name: string;
	/** The project folder is a link (the listing went through it). */
	linked: boolean;
}

interface Located {
	projectPath: string;
	file: string;
	/** The artifacts folder, when there is one. */
	artifacts: string | null;
	found: Found;
}

type Inspected = { ok: true; located: Located } | { ok: false; reason: string };

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Plain sentence from an error message: capitalised, one full stop, bounded. */
function sentence(text: string): string {
	const line = text.trim().split("\n")[0] ?? "";
	const clipped = line.length > MAX_REASON_CHARS ? `${line.slice(0, MAX_REASON_CHARS)}…` : line;
	const cased = clipped.charAt(0).toUpperCase() + clipped.slice(1);
	return /[.!?…]$/.test(cased) ? cased : `${cased}.`;
}

const missing = (err: unknown): boolean => {
	const code = (err as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ENOTDIR";
};

async function lstatOrNull(target: string): Promise<Stats | null> {
	try {
		return await fs.lstat(target);
	} catch (err) {
		if (missing(err)) return null;
		throw err;
	}
}

/** The session id of a transcript file name (`<timestamp>_<sessionId>.jsonl`, the timestamp has no underscore); null for any other name. */
function sessionIdOfName(name: string): string | null {
	if (!name.endsWith(".jsonl")) return null;
	const stem = name.slice(0, -".jsonl".length);
	const at = stem.indexOf("_");
	return at > 0 && at < stem.length - 1 ? stem.slice(at + 1) : null;
}

/** One name, no separators, nothing that climbs: what a manifest may name under the sessions folder. */
const isPlainName = (name: unknown): name is string =>
	typeof name === "string" &&
	name !== "" &&
	name !== "." &&
	name !== ".." &&
	!name.includes("/") &&
	!name.includes("\\") &&
	!name.includes("\0");

function parseIds(raw: unknown): string[] {
	if (!Array.isArray(raw) || raw.length === 0) throw new Error("invalid request");
	if (raw.length > MAX_DELETE_IDS) throw new Error(`delete at most ${MAX_DELETE_IDS} sessions at a time`);
	if (!raw.every(id => typeof id === "string")) throw new Error("invalid request");
	return [...new Set(raw as string[])];
}

/** The manifest from untrusted JSON (the trash is the companion's own folder, but it is only a file): anything off is refused. */
function parseManifest(raw: unknown, trashId: string): Manifest | null {
	const m = raw as Record<string, unknown> | null;
	if (typeof m !== "object" || m === null || m.v !== 1 || m.trashId !== trashId) return null;
	const { sessionId, projectDir, name, deletedAt } = m;
	if (typeof sessionId !== "string" || !SAFE_ID_RE.test(sessionId)) return null;
	if (!isPlainName(projectDir) || !isPlainName(name) || sessionIdOfName(name) !== sessionId) return null;
	if (typeof deletedAt !== "number" || !Number.isFinite(deletedAt)) return null;
	const watch = m.prWatch as { watch?: unknown; inbox?: unknown } | null;
	const org = m.org as { entry?: unknown; activity?: unknown; settled?: unknown; ending?: unknown } | null;
	const entry: OrgEntry | null =
		org?.entry === null || org?.entry === undefined
			? null
			: (parseOrg({ entries: { [sessionId]: org.entry } }).entries[sessionId] ?? null);
	const time = (value: unknown): number | undefined =>
		typeof value === "number" && Number.isFinite(value) ? value : undefined;
	const settle = parseSettleState({
		results: (m.settle as { results?: unknown } | null)?.results,
		sessions: {},
	});
	const worktree = (m.settle as { worktree?: unknown } | null)?.worktree;
	return {
		v: 1,
		trashId,
		sessionId,
		deletedAt,
		projectDir,
		name,
		artifacts: m.artifacts === true,
		prWatch: { watch: watch?.watch === true, inbox: watch?.inbox === true },
		org: { entry, activity: time(org?.activity), settled: time(org?.settled), ending: time(org?.ending) },
		hidden: m.hidden === null || m.hidden === undefined ? null : parseHidden(m.hidden),
		settle: {
			worktree: typeof worktree === "string" && path.isAbsolute(worktree) ? worktree : null,
			results: settle.results,
		},
	};
}

export function createSessionDelete(deps: SessionDeleteDeps): SessionDelete {
	const rename = deps.rename ?? ((from: string, to: string) => fs.rename(from, to));
	const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));

	/** Move a file or folder; across file systems (a sessions folder that is a mount) copy without following links, then remove. */
	const move = async (from: string, to: string): Promise<void> => {
		try {
			await rename(from, to);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
			await fs.cp(from, to, {
				recursive: true,
				verbatimSymlinks: true,
				errorOnExist: true,
				force: false,
				preserveTimestamps: true,
			});
			await fs.rm(from, { recursive: true, force: true });
		}
	};

	/** Every session in the sessions folder by id: where its transcript is, by names. One listing serves a whole request. */
	const scan = async (): Promise<{ root: string | null; found: Map<string, Found[]> }> => {
		const found = new Map<string, Found[]>();
		let root: string;
		try {
			root = await fs.realpath(deps.sessionsDir);
		} catch (err) {
			if (missing(err)) return { root: null, found };
			throw err;
		}
		for (const project of await fs.readdir(root, { withFileTypes: true })) {
			const linked = project.isSymbolicLink();
			if (!project.isDirectory() && !linked) continue;
			let names: string[];
			try {
				names = await fs.readdir(path.join(root, project.name));
			} catch {
				continue;
			}
			for (const name of names) {
				const id = sessionIdOfName(name);
				if (id === null) continue;
				const list = found.get(id) ?? [];
				list.push({ projectDir: project.name, name, linked });
				found.set(id, list);
			}
		}
		return { root, found };
	};

	/** Is the session where omp keeps it, as plain files? The paths come from the listing's names under the resolved sessions folder, nothing else. */
	const inspect = async (
		sessionId: string,
		listing: { root: string | null; found: Map<string, Found[]> },
	): Promise<Inspected> => {
		if (!SAFE_ID_RE.test(sessionId)) return { ok: false, reason: "That is not a session id." };
		if (deps.isPersonal(sessionId))
			return { ok: false, reason: "The Personal agent's session can't be deleted here." };
		const matches = listing.found.get(sessionId) ?? [];
		if (listing.root === null || matches.length === 0)
			return { ok: false, reason: "This session was not found among the omp sessions on this computer." };
		if (matches.length > 1)
			return { ok: false, reason: "This session is in more than one folder, so nothing was deleted." };
		const [found] = matches as [Found];
		const unsafe = (why: string): Inspected => ({
			ok: false,
			reason: `${why} omp does not keep it that way, so nothing was deleted.`,
		});
		if (found.linked) return unsafe("Its project folder is a link.");
		const projectPath = path.join(listing.root, found.projectDir);
		const project = await lstatOrNull(projectPath);
		if (project === null || !project.isDirectory() || (await fs.realpath(projectPath)) !== projectPath)
			return unsafe("Its project folder is not a plain folder in the sessions folder.");
		for (const protectedDir of deps.protectedDirs()) {
			const real = await fs.realpath(protectedDir).catch(() => null);
			if (real !== null && (isInside(real, projectPath) || isInside(projectPath, real)))
				return { ok: false, reason: "The Personal agent's session can't be deleted here." };
		}
		const file = path.join(projectPath, found.name);
		const transcript = await lstatOrNull(file);
		if (transcript === null || !transcript.isFile()) return unsafe("Its transcript is not a plain file.");
		const sibling = file.slice(0, -".jsonl".length);
		const artifacts = await lstatOrNull(sibling);
		if (artifacts !== null && !artifacts.isDirectory()) return unsafe("Its artifacts folder is a link or a file.");
		return { ok: true, located: { projectPath, file, artifacts: artifacts === null ? null : sibling, found } };
	};

	/** What stops the running instances of a session from being ended by us; null when they all can be (or none runs). */
	const handStarted = async (instances: readonly LiveInstance[]): Promise<string | null> => {
		for (const instance of instances)
			if (!(await deps.startedHere(instance.instanceId))) return "It is running in a terminal. End it there first.";
		return null;
	};

	/** Wait until the ended session is no longer listed and nothing has its transcript open. */
	const gone = async (sessionId: string, file: string): Promise<boolean> => {
		const deadline = deps.now() + STOP_WAIT_MS;
		for (;;) {
			const left = (await deps.live()).filter(instance => instance.sessionId === sessionId);
			if (left.length === 0 && (await deps.holders(sessionId, file)) === 0) return true;
			if (deps.now() >= deadline) return false;
			await sleep(STOP_POLL_MS);
		}
	};

	const trashEntry = (trashId: string): string => path.join(deps.trashDir, trashId);

	const ensureTrash = async (): Promise<void> => {
		await fs.mkdir(deps.trashDir, { recursive: true, mode: 0o700 });
		await fs.chmod(deps.trashDir, 0o700);
	};

	/** Move `from` into the entry when it exists as a plain file or folder (never through a link); true when it moved. */
	const keep = async (from: string, to: string, kind: "file" | "folder"): Promise<boolean> => {
		const stat = await lstatOrNull(from);
		if (stat === null || (kind === "file" ? !stat.isFile() : !stat.isDirectory())) return false;
		await move(from, to);
		return true;
	};

	const deleteOne = async (
		sessionId: string,
		listing: { root: string | null; found: Map<string, Found[]> },
		wantWorktree: boolean,
	): Promise<{ result: SessionDeleteResult; tree: string | null }> => {
		const refused = (reason: string) => ({
			result: { sessionId, status: "refused", reason } satisfies SessionDeleteResult,
			tree: null,
		});
		const inspected = await inspect(sessionId, listing);
		if (!inspected.ok) return refused(inspected.reason);
		const { located } = inspected;

		const running = (await deps.live()).filter(instance => instance.sessionId === sessionId);
		const terminal = await handStarted(running);
		if (terminal !== null) return refused(terminal);
		for (const instance of running) {
			try {
				await deps.stop(instance.instanceId);
			} catch (err) {
				return refused(sentence(reasonOf(err)));
			}
		}
		if (running.length > 0 && !(await gone(sessionId, located.file)))
			return refused("It did not stop in time, so nothing was deleted.");
		if ((await deps.holders(sessionId, located.file)) > 0)
			return refused("Another omp has it open. End it there first.");

		// Read before anything is cleared: the worktree comes from the settle record, which is forgotten below.
		const tree = wantWorktree ? await deps.worktree(sessionId) : null;
		const now = deps.now();
		const trashId = `${now.toString(36)}-${crypto.randomBytes(5).toString("hex")}`;
		const entry = trashEntry(trashId);
		const watchFile = path.join(deps.prWatchDir, "watches", `${sessionId}.json`);
		const watchInbox = path.join(deps.prWatchDir, "inbox", sessionId);
		const manifest: Manifest = {
			v: 1,
			trashId,
			sessionId,
			deletedAt: now,
			projectDir: located.found.projectDir,
			name: located.found.name,
			artifacts: located.artifacts !== null,
			prWatch: { watch: false, inbox: false },
			org: deps.org.record(sessionId),
			hidden: deps.hidden.doc(sessionId),
			settle: deps.settle.record(sessionId),
		};

		await ensureTrash();
		await fs.mkdir(entry, { mode: 0o700 });
		// The manifest goes first, so files that reached the trash can always be put back.
		manifest.prWatch = {
			watch: (await lstatOrNull(watchFile))?.isFile() === true,
			inbox: (await lstatOrNull(watchInbox))?.isDirectory() === true,
		};
		const moved: { from: string; to: string }[] = [];
		const put = async (from: string, to: string, kind: "file" | "folder"): Promise<void> => {
			if (await keep(from, to, kind)) moved.push({ from, to });
		};
		try {
			await fs.writeFile(path.join(entry, MANIFEST), `${JSON.stringify(manifest, null, "\t")}\n`, { mode: 0o600 });
			await put(located.file, path.join(entry, TRANSCRIPT), "file");
			if (located.artifacts !== null) await put(located.artifacts, path.join(entry, ARTIFACTS), "folder");
			if (manifest.prWatch.watch) await put(watchFile, path.join(entry, WATCH_FILE), "file");
			if (manifest.prWatch.inbox) await put(watchInbox, path.join(entry, WATCH_INBOX), "folder");
		} catch (err) {
			// Put back what moved, newest first, and leave nothing in the trash.
			for (const step of moved.reverse()) await move(step.to, step.from).catch(deps.onError);
			await fs.rm(entry, { recursive: true, force: true }).catch(deps.onError);
			return refused(`${sentence(reasonOf(err))} Nothing was deleted.`);
		}

		// The files are in the trash: the deletion stands even if a record cannot be written.
		const guarded = async (work: () => Promise<void>): Promise<void> => {
			try {
				await work();
			} catch (err) {
				deps.onError(err);
			}
		};
		await guarded(() => deps.org.forget([sessionId]));
		await guarded(() => deps.hidden.forget(sessionId));
		await guarded(() => deps.settle.forget(sessionId));
		deps.forgetSearch(located.file);
		return { result: { sessionId, status: "deleted", trashId }, tree };
	};

	return {
		async plan(rawIds) {
			const ids = parseIds(rawIds);
			const listing = await scan();
			const live = await deps.live();
			const plans: SessionDeletePlan[] = [];
			for (const sessionId of ids) {
				const inspected = await inspect(sessionId, listing);
				if (!inspected.ok) {
					plans.push({ sessionId, refused: inspected.reason });
					continue;
				}
				const instances = live.filter(instance => instance.sessionId === sessionId);
				const terminal = await handStarted(instances);
				if (terminal !== null) {
					plans.push({ sessionId, refused: terminal });
					continue;
				}
				const worktree = await deps.worktree(sessionId);
				plans.push({
					sessionId,
					...(instances.length > 0 ? { running: true } : {}),
					...(worktree === null ? {} : { worktree }),
				});
			}
			return plans;
		},

		async delete(rawIds, rawRemove) {
			const ids = parseIds(rawIds);
			if (rawRemove !== undefined && typeof rawRemove !== "boolean") throw new Error("invalid request");
			const removeWorktree = rawRemove === true;
			const listing = await scan();
			const outcomes: { result: SessionDeleteResult; tree: string | null }[] = [];
			for (const sessionId of ids)
				outcomes.push(await deps.lock(sessionId, () => deleteOne(sessionId, listing, removeWorktree)));

			// Worktrees last: once every session of the request is gone, what is left in a tree is another session's.
			const byTree = new Map<string, number[]>();
			outcomes.forEach((outcome, index) => {
				if (outcome.tree !== null && outcome.result.status === "deleted")
					byTree.set(outcome.tree, [...(byTree.get(outcome.tree) ?? []), index]);
			});
			for (const [tree, indexes] of byTree) {
				let kept: string | null = null;
				if (deps.settle.sessionsIn(tree).length > 0) kept = "Another session also worked in this worktree.";
				else if (deps.settle.cleaning(tree)) kept = "A cleanup command is still running in it.";
				else {
					try {
						await deps.removeWorktree(tree);
					} catch (err) {
						kept = sentence(reasonOf(err));
					}
				}
				for (const index of indexes) {
					const { result } = outcomes[index]!;
					if (result.status !== "deleted") continue;
					outcomes[index] = {
						tree,
						result:
							kept === null
								? { ...result, worktree: "removed" }
								: {
										sessionId: result.sessionId,
										status: "worktreeKept",
										trashId: result.trashId,
										reason: kept,
									},
					};
				}
			}
			return outcomes.map(outcome => outcome.result);
		},

		async restore(rawTrashId) {
			if (typeof rawTrashId !== "string" || !SAFE_ID_RE.test(rawTrashId)) throw new Error("invalid trash id");
			const trashId = rawTrashId;
			const entry = trashEntry(trashId);
			const stat = await lstatOrNull(entry);
			if (stat === null || !stat.isDirectory()) throw new Error("That deleted session is no longer in the trash.");
			let manifest: Manifest | null = null;
			try {
				manifest = parseManifest(JSON.parse(await Bun.file(path.join(entry, MANIFEST)).text()), trashId);
			} catch {
				manifest = null;
			}
			if (manifest === null)
				throw new Error("The trash entry of that session is damaged, so it cannot be restored.");
			const restored = manifest;
			return await deps.lock(restored.sessionId, () =>
				deps.lock(TRASH_LOCK, async () => {
					const root = await fs.realpath(deps.sessionsDir);
					const projectPath = path.join(root, restored.projectDir);
					const project = await lstatOrNull(projectPath);
					if (project !== null && (!project.isDirectory() || (await fs.realpath(projectPath)) !== projectPath))
						throw new Error(
							"The folder this session was in is not a plain folder any more, so it was not restored.",
						);
					const file = path.join(projectPath, restored.name);
					const sibling = file.slice(0, -".jsonl".length);
					if ((await lstatOrNull(file)) !== null || (await lstatOrNull(sibling)) !== null)
						throw new Error("Something is already where this session was kept, so it was not restored.");
					if (project === null) await fs.mkdir(projectPath);
					const moved: { from: string; to: string }[] = [];
					const put = async (from: string, to: string): Promise<void> => {
						await move(from, to);
						moved.push({ from, to });
					};
					try {
						await put(path.join(entry, TRANSCRIPT), file);
						if (restored.artifacts) await put(path.join(entry, ARTIFACTS), sibling);
					} catch (err) {
						for (const step of moved.reverse()) await move(step.to, step.from).catch(deps.onError);
						throw new Error(`${sentence(reasonOf(err))} It was not restored.`);
					}
					// Pull request watches are only put back where nothing has taken their place.
					const watches: [string, string, boolean][] = [
						[
							path.join(entry, WATCH_FILE),
							path.join(deps.prWatchDir, "watches", `${restored.sessionId}.json`),
							restored.prWatch.watch,
						],
						[
							path.join(entry, WATCH_INBOX),
							path.join(deps.prWatchDir, "inbox", restored.sessionId),
							restored.prWatch.inbox,
						],
					];
					for (const [from, to, had] of watches) {
						if (!had || (await lstatOrNull(to)) !== null) continue;
						try {
							await fs.mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
							await move(from, to);
						} catch (err) {
							deps.onError(err);
						}
					}
					const records = async (work: () => Promise<void>): Promise<void> => {
						try {
							await work();
						} catch (err) {
							deps.onError(err);
						}
					};
					await records(() => deps.org.unforget({ [restored.sessionId]: restored.org }));
					if (restored.hidden !== null) {
						const marks = restored.hidden;
						await records(() => deps.hidden.restore(restored.sessionId, marks));
					}
					await records(() => deps.settle.restore(restored.sessionId, restored.settle));
					await fs.rm(entry, { recursive: true, force: true }).catch(deps.onError);
					return restored.sessionId;
				}),
			);
		},

		async purge() {
			return await deps.lock(TRASH_LOCK, async () => {
				let names: string[];
				try {
					names = await fs.readdir(deps.trashDir);
				} catch (err) {
					if (missing(err)) return 0;
					throw err;
				}
				const now = deps.now();
				let removed = 0;
				for (const name of names) {
					const entry = path.join(deps.trashDir, name);
					const stat = await lstatOrNull(entry);
					// Only the entries this module makes: a plain folder.
					if (stat === null || !stat.isDirectory()) continue;
					let deletedAt = stat.mtimeMs;
					try {
						const raw = JSON.parse(await Bun.file(path.join(entry, MANIFEST)).text()) as { deletedAt?: unknown };
						if (typeof raw.deletedAt === "number" && Number.isFinite(raw.deletedAt)) deletedAt = raw.deletedAt;
					} catch {
						// No readable manifest: the folder's own age decides.
					}
					if (now - deletedAt < TRASH_KEEP_MS) continue;
					await fs.rm(entry, { recursive: true, force: true });
					removed++;
				}
				return removed;
			});
		},
	};
}
