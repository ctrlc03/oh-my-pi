/**
 * The index of foreign agent sessions: `<config>/agent/collab-foreign.json`, mode 0600.
 *
 * Every host process writes its own row and the companion reads them all, so a write must never lose
 * another host's row: updates run under a lock (an `mkdir` that only one process wins) and land through a
 * temp file and a rename, so a reader sees the old file or the new one and never half of one. A row the
 * reader cannot make sense of is left out rather than failing the whole list.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentRef, SessionPermission } from "@oh-my-pi/pi-wire";
import type { HostFanout } from "../../src/lib/fanout";
import { isRecord } from "../../src/tool-render/util";

export interface ForeignIndexRow {
	/** Agent id: `claude`, `codex`, `cursor`, `grok`, `opencode`, or `custom:<slug>`. */
	agent: string;
	/** The vendor's own session id, the key of `session/load`; null until the agent created one. */
	nativeId: string | null;
	cwd: string;
	title: string | null;
	/** The vendor's model id in use. */
	model: string | null;
	createdAt: number;
	lastActive: number;
	permission: SessionPermission;
	worktree: boolean;
	adapterVersion: string | null;
	/** Cumulative cost of the session in USD, when the agent reports one. */
	costUsd?: number;
	fanout?: HostFanout;
}

export interface ForeignIndex {
	version: 1;
	sessions: Record<string, ForeignIndexRow>;
}

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 15;

export function foreignIndexPath(configDir: string): string {
	return path.join(configDir, "agent", "collab-foreign.json");
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function finiteOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseAgentRef(value: unknown): AgentRef | undefined {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") return undefined;
	return { id: value.id, name: value.name };
}

function parseFanout(value: unknown): HostFanout | undefined {
	if (!isRecord(value) || typeof value.group !== "string" || typeof value.model !== "string") return undefined;
	const agent = parseAgentRef(value.agent);
	return { group: value.group, model: value.model, ...(agent ? { agent } : {}) };
}

function parseRow(value: unknown): ForeignIndexRow | null {
	if (!isRecord(value) || typeof value.agent !== "string" || typeof value.cwd !== "string") return null;
	const fanout = parseFanout(value.fanout);
	const costUsd =
		typeof value.costUsd === "number" && Number.isFinite(value.costUsd) && value.costUsd >= 0
			? value.costUsd
			: undefined;
	return {
		agent: value.agent,
		nativeId: stringOrNull(value.nativeId),
		cwd: value.cwd,
		title: stringOrNull(value.title),
		model: stringOrNull(value.model),
		createdAt: finiteOr(value.createdAt, 0),
		lastActive: finiteOr(value.lastActive, 0),
		permission: value.permission === "full" ? "full" : "supervised",
		worktree: value.worktree === true,
		adapterVersion: stringOrNull(value.adapterVersion),
		...(costUsd === undefined ? {} : { costUsd }),
		...(fanout ? { fanout } : {}),
	};
}

/**
 * The index as it is on disk, or an empty one when there is no file. Throws when the file cannot be read
 * or is not an index: the companion refuses to act on a session whose row it cannot read.
 */
export async function readForeignIndexStrict(configDir: string): Promise<ForeignIndex> {
	const sessions: Record<string, ForeignIndexRow> = {};
	const file = Bun.file(foreignIndexPath(configDir));
	let text: string;
	try {
		text = await file.text();
	} catch (err) {
		if (isErrno(err, "ENOENT")) return { version: 1, sessions };
		throw err;
	}
	const parsed: unknown = JSON.parse(text);
	if (!isRecord(parsed) || !isRecord(parsed.sessions)) throw new Error("the foreign session index is not an index");
	for (const [id, value] of Object.entries(parsed.sessions)) {
		const row = parseRow(value);
		if (row !== null) sessions[id] = row;
	}
	return { version: 1, sessions };
}

/** The index as it is on disk; missing or unreadable is empty (a host keeps running without it). */
export async function readForeignIndex(configDir: string): Promise<ForeignIndex> {
	try {
		return await readForeignIndexStrict(configDir);
	} catch {
		return { version: 1, sessions: {} };
	}
}

function isErrno(err: unknown, code: string): boolean {
	return err instanceof Error && "code" in err && err.code === code;
}

interface LockOwner {
	pid: number;
	token: string;
}

function parseOwner(text: string): LockOwner | null {
	try {
		const value: unknown = JSON.parse(text);
		if (isRecord(value) && typeof value.pid === "number" && typeof value.token === "string") {
			return { pid: value.pid, token: value.token };
		}
	} catch {
		// being written, or damaged
	}
	return null;
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM: it exists, it is just not ours
		return !isErrno(err, "ESRCH");
	}
}

/**
 * Break the lock if its owner is gone: a dead owner pid, or (for a lock whose owner never wrote its record)
 * an age past `LOCK_STALE_MS`. The lock directory is renamed away first so only one waiter wins; if what was
 * moved turns out to belong to another owner than the one judged dead, it is put back.
 */
async function breakDeadLock(lock: string): Promise<void> {
	const ownerFile = path.join(lock, "owner");
	const text = await Bun.file(ownerFile)
		.text()
		.catch(() => null);
	const owner = text === null ? null : parseOwner(text);
	if (owner === null) {
		const held = await fs.stat(lock).catch(() => null);
		if (held === null || Date.now() - held.mtimeMs <= LOCK_STALE_MS) return;
	} else if (processAlive(owner.pid)) {
		return;
	}
	const moved = `${lock}.dead-${process.pid}-${crypto.randomUUID()}`;
	try {
		await fs.rename(lock, moved);
	} catch {
		return; // someone else broke it, or it was released
	}
	const movedText = await Bun.file(path.join(moved, "owner"))
		.text()
		.catch(() => null);
	const movedOwner = movedText === null ? null : parseOwner(movedText);
	if (movedOwner?.token !== owner?.token) {
		// A live owner took the lock between the judgement and the rename.
		await fs.rename(moved, lock).catch(() => fs.rm(moved, { recursive: true, force: true }));
		return;
	}
	await fs.rm(moved, { recursive: true, force: true });
}

async function withLock<T>(file: string, work: () => Promise<T>): Promise<T> {
	const lock = `${file}.lock`;
	const owner: LockOwner = { pid: process.pid, token: crypto.randomUUID() };
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			await fs.mkdir(lock, { mode: 0o700 });
			break;
		} catch (err) {
			if (!isErrno(err, "EEXIST")) throw err;
			await breakDeadLock(lock);
			if (Date.now() > deadline) throw new Error("the foreign session index is locked by another process");
			await Bun.sleep(LOCK_RETRY_MS);
		}
	}
	try {
		await fs.writeFile(path.join(lock, "owner"), JSON.stringify(owner), { mode: 0o600 });
		return await work();
	} finally {
		// Only our own lock: if it was broken and taken over, what stands there is someone else's.
		const text = await Bun.file(path.join(lock, "owner"))
			.text()
			.catch(() => null);
		if (text === null || parseOwner(text)?.token === owner.token) {
			await fs.rm(lock, { recursive: true, force: true });
		}
	}
}

/** Read, change and write the index as one step no other host can interleave with. */
export async function updateForeignIndex(
	configDir: string,
	change: (sessions: Record<string, ForeignIndexRow>) => void,
): Promise<void> {
	const file = foreignIndexPath(configDir);
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	await withLock(file, async () => {
		let index: ForeignIndex;
		try {
			index = await readForeignIndexStrict(configDir);
		} catch (err) {
			if (isErrno(err, "EACCES") || isErrno(err, "EPERM")) throw err;
			// Damaged: keep it for inspection and start again, so sessions can still register.
			await fs.rename(file, `${file}.damaged-${Date.now()}`).catch(() => undefined);
			index = { version: 1, sessions: {} };
		}
		change(index.sessions);
		const temp = `${file}.${process.pid}.tmp`;
		await fs.writeFile(temp, `${JSON.stringify(index, null, "\t")}\n`, { mode: 0o600 });
		await fs.rename(temp, file);
	});
}

/**
 * Add or change one session's row: `patch` fields replace the row's. When the row is gone (the index was
 * damaged or replaced), `whole` is put back with the patch on top; without it a missing row is an error.
 */
export function upsertForeignRow(
	configDir: string,
	sessionId: string,
	patch: ForeignIndexRow | Partial<ForeignIndexRow>,
	whole?: ForeignIndexRow,
): Promise<void> {
	return updateForeignIndex(configDir, sessions => {
		const merged = { ...(sessions[sessionId] ?? whole), ...patch };
		const checked = parseRow(merged);
		if (checked === null) throw new Error(`incomplete index row for ${sessionId}`);
		sessions[sessionId] = checked;
	});
}
