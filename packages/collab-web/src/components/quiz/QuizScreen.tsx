import type { Quiz, QuizSummary } from "@oh-my-pi/pi-wire/quiz";
import { Eye, GraduationCap, LoaderCircle, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CompanionClient } from "../../lib/companion";
import { useRequest } from "../../lib/use-request";
import { QuizHeader } from "./QuizHeader";
import { QuizPlay, type QuizPlayProps } from "./QuizPlay";
import { deleteQuiz, getQuiz, listQuizzes } from "./quiz-api";

export interface QuizScreenProps {
	client: CompanionClient;
	id: string;
	/** The quiz's row when the list had it: shown at once while the current state is read. */
	hint?: QuizSummary;
	/** Host of the session on screen when it is on this quiz's computer, so its own quiz-writing session is not offered as a link. */
	currentInstanceId: string | null;
	onOpenHost(instanceId: string): Promise<void>;
	editor?: QuizPlayProps["editor"];
	session?: QuizPlayProps["session"];
	/** Start another quiz about the same subject; null when it cannot be done from here. */
	onNewQuiz: ((quiz: Quiz) => void) | null;
	onHistory(): void;
	onClose(): void;
}

/** The quiz's summary row, kept current by the companion's pushes while a quiz is being written or answered. */
function useSummary(
	client: CompanionClient,
	id: string,
	hint: QuizSummary | undefined,
): { summary: QuizSummary | null; missing: boolean; error: string | null; reload(): void } {
	const load = useCallback(async () => (await listQuizzes(client)).find(item => item.id === id) ?? null, [client, id]);
	const { state, reload } = useRequest(load);
	const kept = useRef<QuizSummary | null>(hint ?? null);
	if (state.status === "ready" && state.value !== null) kept.current = state.value;
	useEffect(() => client.onQuizChanged(changed => changed === id && reload()), [client, id, reload]);
	return {
		summary: kept.current,
		missing: state.status === "ready" && state.value === null,
		error: state.status === "error" ? state.message : null,
		reload,
	};
}

/** One quiz opened from the list or just started: being written, failed, or ready to take. */
export function QuizScreen({
	client,
	id,
	hint,
	currentInstanceId,
	onOpenHost,
	editor,
	session,
	onNewQuiz,
	onHistory,
	onClose,
}: QuizScreenProps): ReactNode {
	const { summary, missing, error, reload } = useSummary(client, id, hint);
	const header = <QuizHeader onHistory={onHistory} onClose={onClose} />;
	if (missing) {
		return (
			<>
				{header}
				<div className="qz-center">
					<p>This quiz no longer exists.</p>
					<button type="button" className="sh-btn" onClick={onHistory}>
						Back to the quizzes
					</button>
				</div>
			</>
		);
	}
	if (summary === null) {
		return (
			<>
				{header}
				{error === null ? (
					<div className="sh-companion-empty sh-file-status">
						<LoaderCircle size={14} className="sh-spin" /> Opening the quiz…
					</div>
				) : (
					<div className="qz-center">
						<div className="qz-alert" role="alert">
							{error}
						</div>
						<button type="button" className="sh-btn" onClick={reload}>
							<RefreshCw size={14} /> Retry
						</button>
					</div>
				)}
			</>
		);
	}
	if (summary.status !== "ready") {
		return (
			<>
				{header}
				<Writing
					client={client}
					summary={summary}
					watchable={summary.instanceId !== currentInstanceId}
					onOpenHost={onOpenHost}
					onGone={onHistory}
				/>
			</>
		);
	}
	return (
		<ReadyQuiz
			client={client}
			summary={summary}
			editor={editor}
			session={session}
			onNewQuiz={onNewQuiz}
			onHistory={onHistory}
			onClose={onClose}
		/>
	);
}

function Writing({
	client,
	summary,
	watchable,
	onOpenHost,
	onGone,
}: {
	client: CompanionClient;
	summary: QuizSummary;
	watchable: boolean;
	onOpenHost(instanceId: string): Promise<void>;
	onGone(): void;
}): ReactNode {
	const [busy, setBusy] = useState<"delete" | "watch" | null>(null);
	const [confirming, setConfirming] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const failed = summary.status === "failed";
	const act = async (what: "delete" | "watch", action: () => Promise<void>): Promise<void> => {
		setBusy(what);
		setError(null);
		try {
			await action();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setBusy(null);
			setConfirming(false);
		}
	};
	return (
		<div className="qz-center qz-writing">
			<GraduationCap size={30} aria-hidden="true" />
			<h2 className="qz-form-title">{summary.subject}</h2>
			{failed ? (
				<div className="qz-alert" role="alert">
					<TriangleAlert size={15} aria-hidden="true" />
					<span>{summary.error ?? "The quiz could not be made."}</span>
				</div>
			) : (
				<>
					<p className="qz-progress" role="status">
						<LoaderCircle size={15} className="sh-spin" /> {summary.progress ?? "Starting"}
					</p>
					<p className="qz-muted">
						A read-only agent is writing the questions and checking each one against the code. This takes a few
						minutes; you can close this and come back, the quiz is in the list when it is ready.
					</p>
				</>
			)}
			{error !== null && (
				<div className="qz-alert" role="alert">
					{error}
				</div>
			)}
			<div className="qz-actions">
				{!failed && watchable && summary.instanceId !== undefined && (
					<button
						type="button"
						className="sh-btn"
						disabled={busy !== null}
						onClick={() =>
							summary.instanceId !== undefined && void act("watch", () => onOpenHost(summary.instanceId!))
						}
					>
						{busy === "watch" ? <LoaderCircle size={14} className="sh-spin" /> : <Eye size={14} />} Watch the
						agent
					</button>
				)}
				{confirming ? (
					<>
						<button
							type="button"
							className="sh-btn qz-danger"
							disabled={busy !== null}
							onClick={() =>
								void act("delete", async () => {
									await deleteQuiz(client, summary.id);
									onGone();
								})
							}
						>
							{busy === "delete" ? <LoaderCircle size={14} className="sh-spin" /> : <Trash2 size={14} />}{" "}
							{failed ? "Delete" : "Stop and delete"}
						</button>
						<button type="button" className="sh-btn" onClick={() => setConfirming(false)}>
							Keep
						</button>
					</>
				) : (
					<button type="button" className="sh-btn" disabled={busy !== null} onClick={() => setConfirming(true)}>
						<Trash2 size={14} /> {failed ? "Delete" : "Cancel and delete"}
					</button>
				)}
			</div>
		</div>
	);
}

function ReadyQuiz({
	client,
	summary,
	editor,
	session,
	onNewQuiz,
	onHistory,
	onClose,
}: {
	client: CompanionClient;
	summary: QuizSummary;
	editor?: QuizPlayProps["editor"];
	session?: QuizPlayProps["session"];
	onNewQuiz: ((quiz: Quiz) => void) | null;
	onHistory(): void;
	onClose(): void;
}): ReactNode {
	const load = useCallback(() => getQuiz(client, summary.id), [client, summary.id]);
	const { state, reload } = useRequest(load);
	if (state.status === "ready") {
		return (
			<QuizPlay
				client={client}
				quiz={state.value.quiz}
				attempts={state.value.attempts}
				stakes={state.value.stakes}
				costUsd={summary.costUsd}
				editor={editor}
				session={session}
				onNewQuiz={onNewQuiz}
				onHistory={onHistory}
				onClose={onClose}
			/>
		);
	}
	return (
		<>
			<QuizHeader onHistory={onHistory} onClose={onClose} />
			{state.status === "loading" ? (
				<div className="sh-companion-empty sh-file-status">
					<LoaderCircle size={14} className="sh-spin" /> Opening the quiz…
				</div>
			) : (
				<div className="qz-center">
					<div className="qz-alert" role="alert">
						{state.message}
					</div>
					<button type="button" className="sh-btn" onClick={reload}>
						<RefreshCw size={14} /> Retry
					</button>
				</div>
			)}
		</>
	);
}
