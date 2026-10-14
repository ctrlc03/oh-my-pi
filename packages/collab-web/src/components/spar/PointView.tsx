import type { BlueprintRef } from "@oh-my-pi/pi-wire/blueprint";
import {
	SPAR_MAX_REPLY_CHARS,
	SPAR_MAX_ROUNDS,
	type SparPoint,
	type SparRecord,
	type SparTurn,
} from "@oh-my-pi/pi-wire/spar";
import {
	ArrowRight,
	ChevronDown,
	ChevronUp,
	CircleAlert,
	CircleCheck,
	CircleX,
	Flag,
	Handshake,
	ListChecks,
	LoaderCircle,
	Send,
} from "lucide-react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Markdown } from "../transcript/Markdown";
import { QuizCode, type QuizCodeProps } from "../quiz/QuizCode";
import { answerKeyAction } from "../quiz/quiz-flow";
import { canSendDefence, kindLabel, moveLabel, outcomeLook, outcomeText, roundsUsed, severityLabel } from "./spar-flow";

type CodeProps = Pick<QuizCodeProps, "excerpts" | "cache" | "openInEditor">;

/** What the point is waiting on while the partner or the companion works. */
export type PointPending = "reply" | "concede" | "accept";

export interface PointViewProps {
	code: CodeProps;
	point: SparPoint;
	/** "Point 2 of 6". */
	label: string;
	/** Points of the run that are closed, and the points it asks. */
	progress: { closed: number; total: number };
	record: SparRecord;
	/** The defence typed and not sent yet. */
	draft: string;
	onDraft(text: string): void;
	pending: PointPending | null;
	/** Why the last send or close failed; the draft stays. */
	error: string | null;
	onSend(text: string): void;
	onConcede(): void;
	onAccept(note: string): void;
	/** Looking back at a point from the summary rather than just closing it. */
	review: boolean;
	/** The button that moves on once the point is closed: the next point, or the summary. */
	next: { label: string; summary: boolean } | null;
	onNext(): void;
	onBackToSummary(): void;
}

/**
 * One point: where it is in the run, the partner's challenge, the code it cites and the exchange so far; while open the
 * defence box with its three ways out, once closed how it ended and what a strong defence would have said. On wide
 * screens the code sits beside the exchange.
 */
export function PointView({
	code,
	point,
	label,
	progress,
	record,
	draft,
	onDraft,
	pending,
	error,
	onSend,
	onConcede,
	onAccept,
	review,
	next,
	onNext,
	onBackToSummary,
}: PointViewProps): ReactNode {
	const closed = record.outcome !== undefined;
	const tail = useRef<HTMLDivElement>(null);
	const seen = useRef({ turns: record.turns.length, closed });
	useEffect(() => {
		// A new turn or the outcome is brought into view; arriving at the point moves nothing.
		const before = seen.current;
		seen.current = { turns: record.turns.length, closed };
		if (before.turns !== record.turns.length || before.closed !== closed) {
			tail.current?.scrollIntoView({ block: "nearest" });
		}
	}, [record.turns.length, closed]);

	return (
		<div className="sp-point">
			<div className="sp-phead">
				<div className="sp-crumbs">
					<span>{label}</span>
					<span className="sp-chip">{kindLabel(point.kind)}</span>
					<span className="sp-chip" data-severity={point.severity}>
						{severityLabel(point.severity)}
					</span>
				</div>
				<h2 className="sp-point-title">{point.title}</h2>
				<div
					className="sp-bar"
					role="progressbar"
					aria-label="Points settled"
					aria-valuemin={0}
					aria-valuemax={progress.total}
					aria-valuenow={progress.closed}
				>
					<span
						className="sp-bar-fill"
						style={{
							width: `${progress.total === 0 ? 0 : Math.round((progress.closed / progress.total) * 100)}%`,
						}}
					/>
				</div>
			</div>
			<div className="sp-split">
				<div className="sp-challenge-area">
					<div className="sp-challenge">
						<Markdown text={point.challenge} />
					</div>
				</div>
				<div className="sp-code-area">
					<h3 className="sp-heading">{point.refs.length === 1 ? "The code" : "The code this is about"}</h3>
					<QuizCode {...code} part={point.part} refs={point.refs} />
				</div>
				<div className="sp-answer-area">
					{record.turns.length > 0 && <Thread code={code} part={point.part} turns={record.turns} />}
					<div ref={tail}>
						{record.outcome === undefined ? (
							<DefenceBox
								key={point.id}
								record={record}
								draft={draft}
								onDraft={onDraft}
								pending={pending}
								error={error}
								onSend={onSend}
								onConcede={onConcede}
								onAccept={onAccept}
							/>
						) : (
							<OutcomeBox
								code={code}
								part={point.part}
								record={record}
								outcome={record.outcome}
								review={review}
								next={next}
								onNext={onNext}
								onBackToSummary={onBackToSummary}
							/>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

function Thread({ code, part, turns }: { code: CodeProps; part: number; turns: readonly SparTurn[] }): ReactNode {
	return (
		<ol className="sp-thread" aria-label="The exchange">
			{turns.map(turn => (
				<li key={`${turn.at}:${turn.by}`} className="sp-turn" data-by={turn.by}>
					<div className="sp-turn-head">
						<span className="sp-turn-who">{turn.by === "you" ? "You" : "Partner"}</span>
						{turn.move !== undefined && (
							<span className="sp-move" data-move={turn.move}>
								{moveLabel(turn.move)}
							</span>
						)}
					</div>
					{turn.by === "you" ? (
						<p className="sp-turn-text">{turn.text}</p>
					) : (
						<div className="sp-turn-text">
							<Markdown text={turn.text} />
						</div>
					)}
					{turn.checked !== undefined && turn.checked.length > 0 && (
						<details className="sp-checked">
							<summary>What the partner checked ({turn.checked.length})</summary>
							<ul>
								{turn.checked.map(item => (
									<li key={item.claim} data-holds={item.holds}>
										{item.holds ? (
											<CircleCheck size={13} aria-hidden="true" />
										) : (
											<CircleX size={13} aria-hidden="true" />
										)}
										<span>
											{item.claim}
											<span className="sp-hint">
												{" "}
												{item.holds ? "The code agrees." : "The code does not agree."}
											</span>
										</span>
									</li>
								))}
							</ul>
						</details>
					)}
					{turn.refs !== undefined && turn.refs.length > 0 && (
						<RefsToggle code={code} part={part} refs={turn.refs} />
					)}
				</li>
			))}
		</ol>
	);
}

/** The code a turn or a suggestion cites, read only once it is asked for. */
function RefsToggle({ code, part, refs }: { code: CodeProps; part: number; refs: readonly BlueprintRef[] }): ReactNode {
	const [open, setOpen] = useState(false);
	return (
		<div className="sp-refs">
			<button type="button" className="sh-btn sp-small" aria-expanded={open} onClick={() => setOpen(!open)}>
				{open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}{" "}
				{open ? "Hide the code" : `Show the code (${refs.length})`}
			</button>
			{open && <QuizCode {...code} part={part} refs={refs} />}
		</div>
	);
}

function DefenceBox({
	record,
	draft,
	onDraft,
	pending,
	error,
	onSend,
	onConcede,
	onAccept,
}: Pick<
	PointViewProps,
	"record" | "draft" | "onDraft" | "pending" | "error" | "onSend" | "onConcede" | "onAccept"
>): ReactNode {
	const area = useRef<HTMLTextAreaElement>(null);
	const composing = useRef(false);
	const [accepting, setAccepting] = useState(false);
	const [note, setNote] = useState("");
	// Primary input is a finger: the return key breaks the line, and the Send button is in reach.
	const touch = typeof matchMedia === "function" && matchMedia("(hover: none) and (pointer: coarse)").matches;
	const busy = pending !== null;
	const ready = canSendDefence(draft, SPAR_MAX_REPLY_CHARS);
	const round = Math.min(roundsUsed(record) + 1, SPAR_MAX_ROUNDS);
	useEffect(() => {
		// A finger would bring up the keyboard over the code: only a keyboard user lands in the box.
		if (!touch) area.current?.focus();
	}, [touch]);

	const send = (): void => {
		if (!ready || busy) return;
		onSend(draft);
	};
	const submit = (e: FormEvent): void => {
		e.preventDefault();
		send();
	};
	const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		const action = answerKeyAction({
			key: e.key,
			shiftKey: e.shiftKey,
			ctrlKey: e.ctrlKey,
			metaKey: e.metaKey,
			composing: e.nativeEvent.isComposing || composing.current,
			touch,
		});
		if (e.key === "Enter" && action === "submit") {
			e.preventDefault();
			send();
		}
	};
	return (
		<form className="sp-defence" onSubmit={submit} aria-busy={pending === "reply"}>
			<div className="sp-field">
				<div className="sp-field-head">
					<label className="sp-label" htmlFor="sp-defence-text">
						Your defence
					</label>
					<span className="sp-hint">
						Round {round} of {SPAR_MAX_ROUNDS}
					</span>
				</div>
				<textarea
					id="sp-defence-text"
					ref={area}
					className="sh-input sp-textarea"
					rows={5}
					maxLength={SPAR_MAX_REPLY_CHARS}
					value={draft}
					readOnly={busy}
					placeholder="Say why this holds, and cite the code if you can (path:line)"
					onChange={e => onDraft(e.target.value)}
					onKeyDown={onKey}
					onCompositionStart={() => {
						composing.current = true;
					}}
					onCompositionEnd={() => {
						// WebKit sends the confirming Enter after `compositionend`.
						setTimeout(() => {
							composing.current = false;
						}, 0);
					}}
				/>
				<div className="sp-field-foot">
					<span className="sp-hint">{touch ? "" : "Enter sends · Shift+Enter adds a line"}</span>
					{draft.length > SPAR_MAX_REPLY_CHARS * 0.8 && (
						<span className="sp-hint">
							{draft.length} / {SPAR_MAX_REPLY_CHARS}
						</span>
					)}
				</div>
			</div>
			{error !== null && (
				<div className="sp-alert" role="alert">
					<CircleAlert size={15} aria-hidden="true" />
					<span>{error}</span>
				</div>
			)}
			{accepting ? (
				<div className="sp-accept">
					<input
						className="sh-input"
						type="text"
						aria-label="Note for the summary"
						placeholder="Note for the summary (optional)"
						value={note}
						disabled={busy}
						onChange={e => setNote(e.target.value)}
					/>
					<div className="sp-actions">
						<button type="button" className="sh-btn" disabled={busy} onClick={() => setAccepting(false)}>
							Cancel
						</button>
						<button
							type="button"
							className="sh-btn sh-btn-primary"
							disabled={busy}
							onClick={() => onAccept(note)}
						>
							{pending === "accept" ? <LoaderCircle size={14} className="sh-spin" /> : <Flag size={14} />} Accept
							the risk
						</button>
					</div>
				</div>
			) : (
				<div className="sp-actions">
					<button type="button" className="sh-btn" disabled={busy} onClick={onConcede}>
						{pending === "concede" ? <LoaderCircle size={14} className="sh-spin" /> : <Handshake size={14} />}{" "}
						Concede
					</button>
					<button type="button" className="sh-btn" disabled={busy} onClick={() => setAccepting(true)}>
						<Flag size={14} /> Accept the risk
					</button>
					<button type="submit" className="sh-btn sh-btn-primary" disabled={!ready || busy}>
						{pending === "reply" ? <LoaderCircle size={14} className="sh-spin" /> : <Send size={14} />}{" "}
						{pending === "reply" ? "Partner is replying…" : error === null ? "Send defence" : "Try again"}
					</button>
				</div>
			)}
		</form>
	);
}

const TONE_ICON = { held: CircleCheck, partly: CircleAlert, lost: CircleX, open: Flag } as const;

function OutcomeBox({
	code,
	part,
	record,
	outcome,
	review,
	next,
	onNext,
	onBackToSummary,
}: {
	code: CodeProps;
	part: number;
	record: SparRecord;
	outcome: NonNullable<SparRecord["outcome"]>;
	review: boolean;
	next: PointViewProps["next"];
	onNext(): void;
	onBackToSummary(): void;
}): ReactNode {
	const look = outcomeLook(outcome.kind);
	const Icon = TONE_ICON[look.tone];
	const advance = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		// Straight after closing, focus goes to the way on; looking back from the summary moves nothing.
		if (!review) advance.current?.focus({ preventScroll: true });
	}, [review]);
	const { reveal } = record;
	return (
		<div className="sp-outcome" data-tone={look.tone} role="status">
			<div className="sp-outcome-head">
				<span className="sp-badge">
					<Icon size={16} aria-hidden="true" /> {look.label}
				</span>
				<span className="sp-hint">{outcomeText(outcome)}</span>
			</div>
			{outcome.note !== undefined && outcome.note !== "" && (
				<div className="sp-given">
					<div className="sp-label">Your note</div>
					<p className="sp-turn-text">{outcome.note}</p>
				</div>
			)}
			{reveal !== undefined && (
				<div className="sp-reveal">
					<h3 className="sp-heading">What a strong defence says</h3>
					<Markdown text={reveal.strongestDefence} />
					{reveal.suggestion !== undefined && (
						<>
							<h3 className="sp-heading">What the partner would change</h3>
							<Markdown text={reveal.suggestion} />
							{reveal.refs !== undefined && reveal.refs.length > 0 && (
								<RefsToggle code={code} part={part} refs={reveal.refs} />
							)}
						</>
					)}
				</div>
			)}
			<div className="sp-actions">
				{review ? (
					<button type="button" className="sh-btn sh-btn-primary" onClick={onBackToSummary}>
						<ListChecks size={14} /> Back to the summary
					</button>
				) : (
					next !== null && (
						<button ref={advance} type="button" className="sh-btn sh-btn-primary" onClick={onNext}>
							{next.label} {next.summary ? <ListChecks size={14} /> : <ArrowRight size={14} />}
						</button>
					)
				)}
			</div>
		</div>
	);
}
