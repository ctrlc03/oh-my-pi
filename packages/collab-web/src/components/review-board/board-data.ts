/**
 * Where the review board's data comes from: a PR stack and each PR's own diff from the companion, the branch review
 * (`git-review` plus one diff per file), a turn's or the session's files from the host's `turn-diff` /
 * `session-diff` answers, and the agent's notes per hunk.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GuestClient, GuestSnapshot } from "../../lib/client";
import type { CompanionClient, GitReview } from "../../lib/companion";
import type { BoardFile, HunkNote, PrOwnDiff, ReviewNotesReply, ReviewSubject, StackPr } from "../../lib/review-board";
import { diffVersion, reviewFileToBoard, turnFilesToBoard } from "../../lib/review-board-view";

export type Load<T> =
	| { status: "loading"; detail?: string }
	| { status: "error"; message: string }
	| { status: "ready"; value: T };

const LOADING: Load<never> = { status: "loading" };

/** A subject's files as the board shows them. */
export interface BoardSource {
	files: BoardFile[];
	/** The notes' cache identity: the PR head sha, or a hash of the diffs. */
	version: string;
	/** Things the board should say about the files (files that could not be read, a diff cut short). */
	notices: string[];
}

/** The companion the board asks, when this session has one. */
export interface BoardCompanion {
	client: CompanionClient;
	instanceId: string;
	/** The companion answers `pr-stack`, `pr-own-diff` and `review-notes` (`canReviewBoard`). */
	canBoard: boolean;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** How long a host may leave a `turn-diff` request unanswered before the board offers to ask again. */
const SILENT_MS = 8000;
/** Branch diffs read at once. */
const BRANCH_READS = 4;

export interface SessionSourceState {
	load: Load<BoardSource>;
	reload(): void;
}

/** The session's or one turn's changes, as the host answers `session-diff` / `turn-diff`. */
export function useSessionSource(
	client: GuestClient,
	snap: GuestSnapshot,
	subject: ReviewSubject,
	enabled: boolean,
): SessionSourceState {
	const entryId = subject.kind === "session" ? (subject.entryId ?? null) : null;
	const live = snap.phase === "live" && !snap.readOnly;
	const canDiff = live && Object.hasOwn(snap.features, "turn-diff");
	const [nonce, setNonce] = useState(0);
	const [silent, setSilent] = useState(false);
	const { working } = snap;
	const ask = useCallback(() => {
		if (!enabled || !canDiff) return;
		if (entryId === null) client.sendSessionCommand("session-diff");
		else client.sendSessionCommand("turn-diff", entryId);
	}, [client, enabled, canDiff, entryId]);
	// The latest turn's changes move while the agent works: ask again when it stops.
	useEffect(() => ask(), [ask, working, nonce]);
	const info = snap.turnDiff;
	const scope = entryId === null ? "session" : "turn";
	const answered = enabled && info !== null && info.scope === scope && info.entryId === entryId;
	useEffect(() => {
		setSilent(false);
		if (!enabled || !canDiff || answered) return;
		const timer = setTimeout(() => setSilent(true), SILENT_MS);
		return () => clearTimeout(timer);
	}, [enabled, canDiff, answered, entryId, nonce]);
	const files = answered ? (info?.files ?? null) : null;
	const reason = answered ? info?.reason : undefined;
	const omitted = answered ? (info?.omitted ?? 0) : 0;
	const load = useMemo<Load<BoardSource>>(() => {
		if (!canDiff) return { status: "error", message: "This host cannot read the session's changes from here." };
		if (!answered) {
			return silent ? { status: "error", message: "The host has not answered." } : LOADING;
		}
		if (files === null) return { status: "error", message: reason ?? "The host could not read the changes." };
		const board = turnFilesToBoard(files);
		return {
			status: "ready",
			value: {
				files: board,
				version: diffVersion(board),
				notices: omitted > 0 ? [`${omitted} more changed file${omitted === 1 ? "" : "s"} not listed.`] : [],
			},
		};
	}, [canDiff, answered, silent, files, reason, omitted]);
	return { load, reload: () => setNonce(n => n + 1) };
}

export interface BranchSourceState {
	load: Load<BoardSource & { review: GitReview }>;
	reload(): void;
}

/** The session's branch against its merge-base: the review's file list, then each file's diff. */
export function useBranchSource(companion: BoardCompanion | null, enabled: boolean): BranchSourceState {
	const [state, setState] = useState<Load<BoardSource & { review: GitReview }>>(LOADING);
	const [tick, setTick] = useState(0);
	const client = companion?.client;
	const instanceId = companion?.instanceId;
	useEffect(() => {
		if (!enabled) return;
		if (client === undefined || instanceId === undefined) {
			setState({ status: "error", message: "No companion host for this session, so the branch cannot be read." });
			return;
		}
		let stale = false;
		setState(LOADING);
		void (async () => {
			try {
				const review = await client.requestReview(instanceId);
				const diffs: BoardFile[] = [];
				const notices: string[] = [];
				let next = 0;
				const worker = async (): Promise<void> => {
					for (let i = next++; i < review.files.length; i = next++) {
						if (stale) return;
						const change = review.files[i]!;
						try {
							const { diff, truncated } = await client.requestReviewDiff(instanceId, change.path);
							diffs[i] = reviewFileToBoard(change, diff, truncated);
						} catch (error) {
							diffs[i] = reviewFileToBoard(change, "", false);
							notices.push(`${change.path}: ${message(error)}`);
						}
						if (!stale)
							setState({
								status: "loading",
								detail: `Reading diffs… ${diffs.filter(Boolean).length}/${review.files.length}`,
							});
					}
				};
				await Promise.all(Array.from({ length: Math.min(BRANCH_READS, review.files.length) }, worker));
				if (stale) return;
				setState({ status: "ready", value: { files: diffs, version: diffVersion(diffs), notices, review } });
			} catch (error) {
				if (!stale) setState({ status: "error", message: message(error) });
			}
		})();
		return () => {
			stale = true;
		};
	}, [client, instanceId, enabled, tick]);
	return { load: state, reload: () => setTick(n => n + 1) };
}

export interface PrSourceState {
	stack: Load<StackPr[]>;
	/** Each stack PR's own diff as far as it has been read (the current one first, then the rest). */
	diffs: Readonly<Record<number, Load<PrOwnDiff>>>;
	reload(): void;
}

/** The stack `root` belongs to and every PR's own changes; `current` is read first, the others in the background. */
export function usePrSource(
	companion: BoardCompanion | null,
	root: number | null,
	current: number | null,
	enabled: boolean,
): PrSourceState {
	const [stack, setStack] = useState<Load<StackPr[]>>(LOADING);
	const [diffs, setDiffs] = useState<Record<number, Load<PrOwnDiff>>>({});
	const [tick, setTick] = useState(0);
	const requested = useRef(new Map<number, Promise<void>>());
	const client = companion?.client;
	const instanceId = companion?.instanceId;
	const canBoard = companion?.canBoard === true;
	const live = enabled && root !== null && client !== undefined && instanceId !== undefined && canBoard;

	const ensure = useCallback(
		(number: number): Promise<void> => {
			const known = requested.current.get(number);
			if (known !== undefined) return known;
			if (client === undefined || instanceId === undefined) return Promise.resolve();
			setDiffs(prev => ({ ...prev, [number]: LOADING }));
			const run = client.requestPrOwnDiff(instanceId, number).then(
				value => setDiffs(prev => ({ ...prev, [number]: { status: "ready", value } })),
				(error: unknown) => setDiffs(prev => ({ ...prev, [number]: { status: "error", message: message(error) } })),
			);
			requested.current.set(number, run);
			return run;
		},
		[client, instanceId],
	);

	// A new stack or a reload starts over: nothing read before is trusted (`tick` is the reload trigger).
	useEffect(() => {
		requested.current = new Map();
		setDiffs({});
	}, [client, instanceId, root, tick]);

	useEffect(() => {
		if (!live || client === undefined || instanceId === undefined || root === null) return;
		let stale = false;
		setStack(LOADING);
		client.requestPrStack(instanceId, root).then(
			value => {
				if (!stale) setStack({ status: "ready", value });
			},
			(error: unknown) => {
				if (!stale) setStack({ status: "error", message: message(error) });
			},
		);
		return () => {
			stale = true;
		};
	}, [live, client, instanceId, root, tick]);

	useEffect(() => {
		if (live && current !== null) void ensure(current);
	}, [live, current, ensure, tick]);

	// The rest of the stack in the background, one at a time, so the chips can show their own +/- counts.
	useEffect(() => {
		if (!live || stack.status !== "ready" || current === null) return;
		let stale = false;
		void (async () => {
			await ensure(current);
			for (const pr of stack.value) {
				if (stale) return;
				await ensure(pr.number);
			}
		})();
		return () => {
			stale = true;
		};
	}, [live, stack, current, ensure, tick]);

	return { stack, diffs, reload: () => setTick(n => n + 1) };
}

export interface NotesState {
	/** `unavailable`: the companion cannot write notes; `idle`: nothing to ask about yet. */
	status: "unavailable" | "idle" | "loading" | "ready" | "error";
	notes: readonly HunkNote[];
	/** Hunks still without a (real) note after the latest reply: what one Explain writes. */
	unexplained: number;
	canGenerate: boolean;
	/** A model is writing notes for the hunks no session explains. */
	generating: boolean;
	error: string | null;
	explain(): void;
}

const EMPTY_NOTES: Omit<NotesState, "explain"> = {
	status: "idle",
	notes: [],
	unexplained: 0,
	canGenerate: false,
	generating: false,
	error: null,
};

function answered(reply: ReviewNotesReply): Omit<NotesState, "explain"> {
	return {
		status: "ready",
		notes: reply.notes,
		unexplained: reply.unexplained,
		canGenerate: reply.canGenerate,
		generating: false,
		error: null,
	};
}

/**
 * The agent's notes per hunk: asked for when the files are known (what the sessions wrote, no model call), and,
 * on `explain`, completed by a model for the hunks no session explains. Keyed by subject and version: a new head
 * or a changed diff asks again.
 */
export function useHunkNotes(
	companion: BoardCompanion | null,
	subject: ReviewSubject,
	source: BoardSource | null,
): NotesState {
	const client = companion?.client;
	const instanceId = companion?.instanceId;
	const canBoard = companion?.canBoard === true;
	const [state, setState] = useState<Omit<NotesState, "explain">>(EMPTY_NOTES);
	const subjectJson = JSON.stringify(subject);
	const files = source?.files;
	const version = source?.version;
	const query = useCallback(
		(generate: boolean) => {
			if (client === undefined || instanceId === undefined || files === undefined || version === undefined) {
				return Promise.reject(new Error("nothing to explain yet"));
			}
			return client.requestReviewNotes(instanceId, {
				subject: JSON.parse(subjectJson) as ReviewSubject,
				version,
				files: files.map(file => ({ path: file.path, diff: file.diff })),
				generate,
			});
		},
		[client, instanceId, files, version, subjectJson],
	);
	useEffect(() => {
		if (!canBoard) {
			setState({ ...EMPTY_NOTES, status: "unavailable" });
			return;
		}
		if (files === undefined) {
			setState(EMPTY_NOTES);
			return;
		}
		let stale = false;
		setState(prev => ({ ...prev, status: "loading", generating: false, error: null }));
		query(false).then(
			reply => {
				if (!stale) setState(answered(reply));
			},
			(error: unknown) => {
				if (!stale) setState({ ...EMPTY_NOTES, status: "error", error: message(error) });
			},
		);
		return () => {
			stale = true;
		};
	}, [canBoard, files, query]);
	const explain = useCallback(() => {
		setState(prev => ({ ...prev, generating: true, error: null }));
		query(true).then(
			reply => setState(answered(reply)),
			(error: unknown) => setState(prev => ({ ...prev, generating: false, error: message(error) })),
		);
	}, [query]);
	return { ...state, explain };
}
