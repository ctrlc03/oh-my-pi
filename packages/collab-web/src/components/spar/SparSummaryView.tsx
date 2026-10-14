import type { Spar, SparRun } from "@oh-my-pi/pi-wire/spar";
import {
	ChevronDown,
	ChevronUp,
	CircleAlert,
	Copy,
	History,
	ListRestart,
	LoaderCircle,
	Play,
	Plus,
	Share2,
	Trophy,
} from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { fmtCost, relTime } from "../../lib/format";
import { copyText, shareText } from "../../lib/share";
import { QuizCode, type QuizCodeProps } from "../quiz/QuizCode";
import { Markdown } from "../transcript/Markdown";
import {
	kindLabel,
	objectionOf,
	outcomeText,
	refLabel,
	severityLabel,
	sparMarkdown,
	type SparSummaryModel,
	type SummaryItem,
} from "./spar-flow";

export interface SparSummaryViewProps {
	code: Pick<QuizCodeProps, "excerpts" | "cache" | "openInEditor">;
	spar: Spar;
	/** The run shown. */
	run: SparRun;
	summary: SparSummaryModel;
	/** Every run of the spar, newest first. */
	runs: readonly SparRun[];
	costUsd: number | undefined;
	/** The run that is being set up. */
	again: "all" | "unsettled" | null;
	error: string | null;
	/** Open a point of the run to read its exchange (or answer it when it is still open). */
	onReview(point: string): void;
	/** Go on with the first point of the run that is still open. */
	onContinue(): void;
	onAgain(only: "all" | "unsettled"): void;
	onSelectRun(id: string): void;
	/** Back to the form with the same subject; absent when there is none to offer. */
	onNewSpar: (() => void) | null;
	/** Compare several models' answers to what this spar challenged; absent when it cannot be done from here. */
	onBakeoff?(): void;
	onHistory(): void;
}

/** The result of a run: how much held, what is still open, what the partner would change, and what to do next. */
export function SparSummaryView({
	code,
	spar,
	run,
	summary,
	runs,
	costUsd,
	again,
	error,
	onReview,
	onContinue,
	onAgain,
	onSelectRun,
	onNewSpar,
	onBakeoff,
	onHistory,
}: SparSummaryViewProps): ReactNode {
	const busy = again !== null;
	const [shared, setShared] = useState<"copied" | "failed" | null>(null);
	const unfinished = summary.unfinished.length > 0;
	const againOnly = summary.unsettled > 0 ? "unsettled" : "all";

	return (
		<div className="sp-summary">
			<div className="sp-score" role="group" aria-label="Score">
				<span className="sp-score-percent">{summary.percentHeld}%</span>
				<div className="sp-score-side">
					<span className="sp-score-band">{summary.band}</span>
					<span className="sp-hint">
						Held {summary.held.length} of {summary.asked} {summary.asked === 1 ? "point" : "points"}
						{unfinished ? `, ${summary.unfinished.length} not answered yet` : ""}
					</span>
					{costUsd !== undefined && <span className="sp-hint">Spar cost so far {fmtCost(costUsd)}</span>}
				</div>
			</div>
			{error !== null && (
				<div className="sp-alert" role="alert">
					<CircleAlert size={15} aria-hidden="true" />
					<span>{error}</span>
				</div>
			)}
			<div className="sp-actions sp-actions-start">
				{unfinished ? (
					<button type="button" className="sh-btn sh-btn-primary" onClick={onContinue}>
						<Play size={14} /> Continue
					</button>
				) : (
					<button
						type="button"
						className="sh-btn sh-btn-primary"
						disabled={busy}
						onClick={() => onAgain(againOnly)}
					>
						{busy ? <LoaderCircle size={14} className="sh-spin" /> : <ListRestart size={14} />}{" "}
						{againOnly === "unsettled"
							? `Spar again on the open points (${summary.unsettled})`
							: "Spar again on all points"}
					</button>
				)}
				<button
					type="button"
					className="sh-btn"
					onClick={() => void copyText(sparMarkdown(spar, run)).then(ok => setShared(ok ? "copied" : "failed"))}
				>
					<Copy size={14} /> Copy as Markdown
				</button>
				{typeof navigator.share === "function" && (
					<button
						type="button"
						className="sh-btn"
						onClick={() =>
							void shareText(spar.title, sparMarkdown(spar, run)).then(result =>
								setShared(result === "copied" ? "copied" : result === "failed" ? "failed" : null),
							)
						}
					>
						<Share2 size={14} /> Share as Markdown
					</button>
				)}
				{onNewSpar !== null && (
					<button type="button" className="sh-btn" disabled={busy} onClick={onNewSpar}>
						<Plus size={14} /> New spar
					</button>
				)}
				{onBakeoff !== undefined && (
					<button type="button" className="sh-btn" disabled={busy} onClick={onBakeoff}>
						<Trophy size={14} /> Bake off this
					</button>
				)}
				<button type="button" className="sh-btn" onClick={onHistory}>
					<History size={14} /> All spars
				</button>
			</div>
			{shared !== null && (
				<p className="sp-note" role="status">
					{shared === "copied" ? "Copied to the clipboard." : "The browser would not copy it."}
				</p>
			)}
			<ItemList
				id="held"
				title="Held"
				empty="Nothing held yet."
				items={summary.held}
				code={code}
				onReview={onReview}
				detail="point"
			/>
			<ItemList
				id="open"
				title="Open risks"
				empty="No open risks."
				items={summary.open}
				code={code}
				onReview={onReview}
				detail="point"
			/>
			<ItemList
				id="suggested"
				title="Suggested changes"
				empty="No changes suggested."
				items={summary.suggested}
				code={code}
				onReview={onReview}
				detail="suggestion"
			/>
			{unfinished && (
				<ItemList
					id="unfinished"
					title="Not answered yet"
					empty=""
					items={summary.unfinished}
					code={code}
					onReview={onReview}
					detail="point"
				/>
			)}
			{spar.warnings.length > 0 && (
				<details className="sp-reminder">
					<summary>Notes from preparing this spar ({spar.warnings.length})</summary>
					<ul className="sp-notes">
						{spar.warnings.map(warning => (
							<li key={warning}>{warning}</li>
						))}
					</ul>
				</details>
			)}
			{runs.length > 1 && (
				<section className="sp-section" aria-labelledby="sp-runs">
					<h3 id="sp-runs" className="sp-heading">
						Runs
					</h3>
					<ul className="sp-runs">
						{runs.map((item, at) => (
							<li key={item.id}>
								<button
									type="button"
									className="sh-btn sp-run"
									aria-current={item.id === run.id ? "true" : undefined}
									onClick={() => onSelectRun(item.id)}
								>
									<span>Run {runs.length - at}</span>
									<span>
										{item.finishedAt === undefined ? "in progress" : `${item.result.percentHeld}% held`}
									</span>
									<span className="sp-hint">{relTime(item.startedAt)}</span>
								</button>
							</li>
						))}
					</ul>
				</section>
			)}
		</div>
	);
}

interface ItemListProps {
	id: string;
	title: string;
	empty: string;
	items: readonly SummaryItem[];
	code: SparSummaryViewProps["code"];
	onReview(point: string): void;
	/** What an expanded item leads with: the objection, or the change the partner suggests. */
	detail: "point" | "suggestion";
}

function ItemList({ id, title, empty, items, code, onReview, detail }: ItemListProps): ReactNode {
	return (
		<section className="sp-section" aria-labelledby={`sp-${id}`}>
			<h3 id={`sp-${id}`} className="sp-heading">
				{title} ({items.length})
			</h3>
			{items.length === 0 ? (
				<p className="sp-note">{empty}</p>
			) : (
				<ul className="sp-items">
					{items.map(item => (
						<Item key={item.point.id} item={item} code={code} onReview={onReview} detail={detail} />
					))}
				</ul>
			)}
		</section>
	);
}

function Item({
	item,
	code,
	onReview,
	detail,
}: {
	item: SummaryItem;
	code: SparSummaryViewProps["code"];
	onReview(point: string): void;
	detail: ItemListProps["detail"];
}): ReactNode {
	const [open, setOpen] = useState(false);
	const { point, record } = item;
	const suggestion = detail === "suggestion" ? record.reveal : undefined;
	const refs = suggestion?.refs !== undefined && suggestion.refs.length > 0 ? suggestion.refs : point.refs;
	return (
		<li className="sp-item" data-tone={record.outcome?.kind}>
			<button type="button" className="sp-item-head" aria-expanded={open} onClick={() => setOpen(!open)}>
				<span className="sp-item-title">{point.title}</span>
				<span className="sp-item-meta">
					<span className="sp-chip">{kindLabel(point.kind)}</span>
					<span className="sp-chip" data-severity={point.severity}>
						{severityLabel(point.severity)}
					</span>
					{record.outcome !== undefined && <span className="sp-hint">{outcomeText(record.outcome)}</span>}
				</span>
				<span className="sp-item-refs">
					{refs.map(ref => (
						<code key={`${ref.path}:${ref.line}:${ref.side ?? ""}`} className="sp-ref-chip">
							{refLabel(ref)}
						</code>
					))}
				</span>
				<span className="sp-item-caret" aria-hidden="true">
					{open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
				</span>
			</button>
			{open && (
				<div className="sp-item-body">
					{suggestion?.suggestion !== undefined ? (
						<Markdown text={suggestion.suggestion} />
					) : (
						<p className="sp-turn-text">{objectionOf(point)}</p>
					)}
					{record.outcome?.note !== undefined && record.outcome.note !== "" && (
						<p className="sp-note">Your note: {record.outcome.note}</p>
					)}
					<QuizCode {...code} part={point.part} refs={refs} />
					<div className="sp-actions sp-actions-start">
						<button type="button" className="sh-btn sp-small" onClick={() => onReview(point.id)}>
							Open the point
						</button>
					</div>
				</div>
			)}
		</li>
	);
}
