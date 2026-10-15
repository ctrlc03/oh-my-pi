/**
 * What the companion keeps for high-stakes sessions (./companion-stakes): per session its mode and the states a quiz
 * has covered, and the companion-wide pass mark. One JSON file in the agent directory (0600, written atomically), so
 * the mode and the passes survive a restart. A file that cannot be read is treated as empty; the next write replaces it.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isPassMark, STAKES_DEFAULT_PASS_MARK } from "@oh-my-pi/pi-wire/stakes";
import { isRecord } from "../src/tool-render/util";

export const STAKES_FILE_VERSION = 1;

/** A state of a session's changes that a quiz covered (or that is the same patch as one that was). */
export interface Covered {
	/** The tree: the exact files. */
	tree: string;
	/** A commit with that tree, held under a private ref so the next quiz can start from it. */
	commit: string;
	/** The patch from the default branch's merge base to this state (`git patch-id --verbatim`); absent when it could not be computed. */
	diffId?: string;
	/** `pass`: a quiz was passed on it. `same-diff`: a later commit with the same patch (a rebase). */
	via: "pass" | "same-diff";
	at: number;
	quizId?: string;
	attempt?: string;
	points?: number;
	total?: number;
	/** The quiz covered only the changes since an earlier covered state. */
	delta?: boolean;
}

/** A quiz made for the diff that was needed at the time, so asking again opens it instead of writing another. */
export interface QuizBinding {
	quizId: string;
	headTree: string;
	baseCommit: string;
	delta: boolean;
	at: number;
}

export interface SessionStakes {
	on: boolean;
	/** The session's checkout (its folder's top level, symlinks resolved) and the primary checkout of its repository. */
	checkout: string;
	root: string;
	/** Who last changed the mode (a device name), and when. */
	by: string;
	at: number;
	/** Newest first. */
	covered: Covered[];
	quizzes: QuizBinding[];
}

export interface StakesFile {
	v: typeof STAKES_FILE_VERSION;
	/** Counts up with every published change of any state file. */
	rev: number;
	passMark: number;
	/** By session id; a session being started has a `pending:` id until its host is listed. */
	sessions: Record<string, SessionStakes>;
}

export function emptyStakesFile(): StakesFile {
	return { v: STAKES_FILE_VERSION, rev: 0, passMark: STAKES_DEFAULT_PASS_MARK, sessions: {} };
}

function readCovered(value: unknown): Covered | null {
	if (!isRecord(value) || typeof value.tree !== "string" || typeof value.commit !== "string") return null;
	if (value.via !== "pass" && value.via !== "same-diff") return null;
	if (typeof value.at !== "number") return null;
	return value as unknown as Covered;
}

function readBinding(value: unknown): QuizBinding | null {
	if (!isRecord(value) || typeof value.quizId !== "string" || typeof value.headTree !== "string") return null;
	if (typeof value.baseCommit !== "string" || typeof value.delta !== "boolean" || typeof value.at !== "number")
		return null;
	return value as unknown as QuizBinding;
}

function readSession(value: unknown): SessionStakes | null {
	if (!isRecord(value) || typeof value.on !== "boolean") return null;
	if (typeof value.checkout !== "string" || typeof value.root !== "string") return null;
	return {
		on: value.on,
		checkout: value.checkout,
		root: value.root,
		by: typeof value.by === "string" ? value.by : "",
		at: typeof value.at === "number" ? value.at : 0,
		covered: Array.isArray(value.covered)
			? value.covered.flatMap(entry => {
					const covered = readCovered(entry);
					return covered ? [covered] : [];
				})
			: [],
		quizzes: Array.isArray(value.quizzes)
			? value.quizzes.flatMap(entry => {
					const binding = readBinding(entry);
					return binding ? [binding] : [];
				})
			: [],
	};
}

/** The stored file, or an empty one when it is missing or unreadable; entries that do not parse are dropped. */
export async function loadStakesFile(file: string): Promise<StakesFile> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await Bun.file(file).text());
	} catch {
		return emptyStakesFile();
	}
	if (!isRecord(parsed) || parsed.v !== STAKES_FILE_VERSION) return emptyStakesFile();
	const sessions: Record<string, SessionStakes> = {};
	if (isRecord(parsed.sessions)) {
		for (const [id, value] of Object.entries(parsed.sessions)) {
			const session = readSession(value);
			if (session) sessions[id] = session;
		}
	}
	return {
		v: STAKES_FILE_VERSION,
		rev: typeof parsed.rev === "number" && Number.isSafeInteger(parsed.rev) ? parsed.rev : 0,
		passMark: isPassMark(parsed.passMark) ? parsed.passMark : STAKES_DEFAULT_PASS_MARK,
		sessions,
	};
}

export async function saveStakesFile(file: string, contents: StakesFile): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${process.pid}.tmp`;
	await fs.writeFile(temp, `${JSON.stringify(contents, null, "\t")}\n`, { mode: 0o600 });
	await fs.chmod(temp, 0o600);
	await fs.rename(temp, file);
}
