import type { QuizSummary } from "@oh-my-pi/pi-wire/quiz";
import {
	CircleCheck,
	Eye,
	GraduationCap,
	Laptop,
	LoaderCircle,
	Plus,
	RefreshCw,
	Trash2,
	TriangleAlert,
	X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CompanionClient } from "../../lib/companion";
import { type ComputerHandle, unavailableReason } from "../../lib/computers";
import { fmtCost, relTime } from "../../lib/format";
import { type ClientTarget, featureTargets, useStableTargets } from "../../lib/stable-targets";
import { useRequest } from "../../lib/use-request";
import { deleteQuiz, listQuizzes } from "./quiz-api";
import { folderName, groupByRepo, rowStatus } from "./quiz-flow";

export interface QuizListProps {
	computers: readonly ComputerHandle[];
	/** The computer of the session on screen; null from the start screen. */
	computerId: string | null;
	/** The session's folder: only its repository's quizzes (on its computer) are listed. Null lists every repository's. */
	cwd: string | null;
	/** Host of the session on screen (on `computerId`), so its own quiz-writing session is not offered as a link. */
	currentInstanceId: string | null;
	onOpen(computerId: string, quiz: QuizSummary): void;
	/** Start a new quiz of what is on screen; null when there is nothing to start one from (the start screen). */
	onNew: (() => void) | null;
	/** Join the omp session that is writing a running quiz. */
	onOpenHost(computerId: string, instanceId: string): Promise<void>;
	onClose(): void;
}

interface QuizEntry {
	target: ClientTarget;
	quiz: QuizSummary;
}

interface Listing {
	entries: QuizEntry[];
	failures: { target: ClientTarget; message: string }[];
}

/**
 * The quizzes of the repository (or of every repository) on every computer that writes them: how each stands,
 * with progress while one is being written. Each computer answers on its own: one that fails shows its own line.
 */
export function QuizList({
	computers,
	computerId,
	cwd,
	currentInstanceId,
	onOpen,
	onNew,
	onOpenHost,
	onClose,
}: QuizListProps): ReactNode {
	const several = computers.length > 1;
	const targets = useStableTargets(featureTargets(computers, "quiz"));
	const away = computers.flatMap(computer => {
		const reason = unavailableReason(computer, "quiz");
		return reason === null ? [] : [{ computer, reason }];
	});
	const load = useCallback(async (): Promise<Listing> => {
		const answers = await Promise.allSettled(
			// The session's folder narrows its own computer's quizzes; another computer has its own checkouts.
			targets.map(target => listQuizzes(target.client, target.id === computerId ? (cwd ?? undefined) : undefined)),
		);
		const entries: QuizEntry[] = [];
		const failures: Listing["failures"] = [];
		answers.forEach((answer, at) => {
			const target = targets[at]!;
			if (answer.status === "fulfilled") for (const quiz of answer.value) entries.push({ target, quiz });
			else
				failures.push({
					target,
					message: answer.reason instanceof Error ? answer.reason.message : String(answer.reason),
				});
		});
		entries.sort((a, b) => b.quiz.createdAt - a.quiz.createdAt);
		return { entries, failures };
	}, [targets, computerId, cwd]);
	const { state, reload } = useRequest(load);
	// Keep the list on screen (dimmed) while a push refreshes it.
	const shown = useRef<Listing | null>(null);
	if (state.status === "ready") shown.current = state.value;
	const listing = shown.current;
	useEffect(() => {
		const stops = targets.map(target => target.client.onQuizChanged(() => reload()));
		return () => {
			for (const stop of stops) stop();
		};
	}, [targets, reload]);
	const loading = state.status === "loading";
	const groups = listing === null ? [] : groupEntries(listing.entries);
	const headed = cwd === null || groups.length > 1;

	return (
		<>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title">
					Quizzes
					{cwd !== null && <span className="qz-repo">{folderName(cwd)}</span>}
				</div>
				<span className="sh-sheet-head-actions">
					{onNew !== null && (
						<button type="button" className="sh-btn sh-btn-primary" onClick={onNew}>
							<Plus size={14} /> New quiz
						</button>
					)}
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={reload}
						disabled={loading}
						aria-label="Reload the quizzes"
					>
						<RefreshCw size={15} className={loading ? "sh-spin" : undefined} />
					</button>
					<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="Close">
						<X size={16} />
					</button>
				</span>
			</div>
			{away.map(({ computer, reason }) => (
				<div key={computer.id} className="qz-away">
					<span className="sh-dot" aria-hidden="true" /> {several ? `${computer.name}: ${reason}` : reason}
				</div>
			))}
			{listing?.failures.map(failure => (
				<div key={failure.target.id} className="sh-tree-error">
					<div className="sh-connect-error">
						{several ? `${failure.target.name}: ${failure.message}` : failure.message}
					</div>
					<button type="button" className="sh-btn" onClick={reload}>
						<RefreshCw size={14} /> Retry
					</button>
				</div>
			))}
			<div className="qz-scroll">
				{listing === null ? (
					loading && (
						<div className="sh-companion-empty sh-file-status">
							<LoaderCircle size={14} className="sh-spin" /> Loading the quizzes…
						</div>
					)
				) : listing.entries.length === 0 ? (
					listing.failures.length === 0 &&
					targets.length > 0 && (
						<div className="qz-empty">
							<GraduationCap size={28} aria-hidden="true" />
							<p>No quizzes yet{cwd !== null ? " for this repository" : ""}.</p>
							<p className="qz-muted">
								A quiz asks questions about code that changed (a session's work or a pull request), each tied to
								the code it is about, then tells you what to revisit.
							</p>
							{onNew !== null ? (
								<button type="button" className="sh-btn sh-btn-primary" onClick={onNew}>
									<Plus size={14} /> Make the first quiz
								</button>
							) : (
								<p className="qz-muted">
									Start one from a session (⋯ → Quiz me on these changes) or from a pull request in the GitHub
									sheet.
								</p>
							)}
						</div>
					)
				) : (
					<div className={loading ? "sh-stats-stale" : undefined}>
						{groups.map(group => (
							<section key={group.key} className="qz-group">
								{headed && (
									<h3 className="qz-group-name">
										{group.name}
										{several && (
											<span className="qz-group-computer">
												<Laptop size={11} aria-hidden="true" /> {group.computerName}
											</span>
										)}
									</h3>
								)}
								<ul className="qz-quizzes">
									{group.entries.map(({ target, quiz }) => (
										<QuizRow
											key={`${target.id}:${quiz.id}`}
											quiz={quiz}
											client={target.client}
											canWatch={
												quiz.instanceId !== undefined &&
												!(target.id === computerId && quiz.instanceId === currentInstanceId)
											}
											onOpen={() => onOpen(target.id, quiz)}
											onOpenHost={instanceId => onOpenHost(target.id, instanceId)}
											onChanged={reload}
										/>
									))}
								</ul>
							</section>
						))}
					</div>
				)}
			</div>
		</>
	);
}

interface Group {
	key: string;
	name: string;
	computerName: string;
	entries: QuizEntry[];
}

/** The listing's quizzes per computer and repository, the group with the newest quiz first. */
function groupEntries(entries: readonly QuizEntry[]): Group[] {
	const targets = [...new Map(entries.map(entry => [entry.target.id, entry.target])).values()];
	return targets
		.flatMap(target =>
			groupByRepo(entries.filter(entry => entry.target.id === target.id).map(entry => entry.quiz)).map(group => ({
				key: `${target.id}:${group.repoRoot}`,
				name: group.name,
				computerName: target.name,
				entries: group.quizzes.map(quiz => ({ target, quiz })),
			})),
		)
		.sort((a, b) => b.entries[0]!.quiz.createdAt - a.entries[0]!.quiz.createdAt);
}

interface QuizRowProps {
	quiz: QuizSummary;
	client: CompanionClient;
	canWatch: boolean;
	onOpen(): void;
	onOpenHost(instanceId: string): Promise<void>;
	onChanged(): void;
}

function QuizRow({ quiz, client, canWatch, onOpen, onOpenHost, onChanged }: QuizRowProps): ReactNode {
	const [busy, setBusy] = useState<"delete" | "watch" | null>(null);
	const [confirming, setConfirming] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const status = rowStatus(quiz);
	const failed = quiz.status === "failed";

	const run = async (what: "delete" | "watch", action: () => Promise<void>): Promise<void> => {
		setBusy(what);
		setError(null);
		try {
			await action();
			onChanged();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
			setConfirming(false);
		}
	};

	return (
		<li className="qz-quiz" data-status={quiz.status}>
			<button
				type="button"
				className="qz-quiz-main"
				onClick={onOpen}
				disabled={failed}
				aria-label={failed ? undefined : `Open ${quiz.subject}`}
			>
				<span className="qz-quiz-title">{quiz.subject}</span>
				{quiz.title !== quiz.subject && <span className="qz-quiz-sub">{quiz.title}</span>}
				<span className="qz-quiz-meta">
					<span className="qz-tag" data-kind={status.kind}>
						{status.kind === "score" && <CircleCheck size={11} aria-hidden="true" />}
						{status.text}
					</span>
					{quiz.questionCount !== undefined && (
						<span>
							{quiz.questionCount} {quiz.questionCount === 1 ? "question" : "questions"}
							{quiz.partCount !== undefined && quiz.partCount > 1 ? ` in ${quiz.partCount} parts` : ""}
						</span>
					)}
					{quiz.attemptCount !== undefined && quiz.attemptCount > 1 && <span>{quiz.attemptCount} attempts</span>}
					<span>{relTime(quiz.createdAt)}</span>
					{quiz.costUsd !== undefined && <span>{fmtCost(quiz.costUsd)}</span>}
				</span>
				{quiz.status === "running" && (
					<span className="qz-quiz-progress" role="status">
						<LoaderCircle size={13} className="sh-spin" /> {quiz.progress ?? "Starting"}
					</span>
				)}
				{failed && (
					<span className="qz-quiz-failed">
						<TriangleAlert size={13} /> {quiz.error ?? "The quiz could not be made."}
					</span>
				)}
			</button>
			<span className="qz-quiz-actions">
				{quiz.status === "running" && canWatch && quiz.instanceId !== undefined && (
					<button
						type="button"
						className="sh-btn"
						disabled={busy !== null}
						onClick={() => quiz.instanceId !== undefined && void run("watch", () => onOpenHost(quiz.instanceId!))}
					>
						{busy === "watch" ? <LoaderCircle size={14} className="sh-spin" /> : <Eye size={14} />} Watch
					</button>
				)}
				{confirming ? (
					<>
						<button
							type="button"
							className="sh-btn qz-danger"
							disabled={busy !== null}
							onClick={() => void run("delete", () => deleteQuiz(client, quiz.id))}
						>
							{busy === "delete" ? <LoaderCircle size={14} className="sh-spin" /> : <Trash2 size={14} />}{" "}
							{quiz.status === "running" ? "Stop and delete" : "Delete"}
						</button>
						<button type="button" className="sh-btn" onClick={() => setConfirming(false)}>
							Keep
						</button>
					</>
				) : (
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={() => setConfirming(true)}
						aria-label={`Delete ${quiz.subject}`}
					>
						<Trash2 size={15} />
					</button>
				)}
			</span>
			{error !== null && (
				<span className="qz-quiz-error" role="alert">
					{error}
				</span>
			)}
		</li>
	);
}
