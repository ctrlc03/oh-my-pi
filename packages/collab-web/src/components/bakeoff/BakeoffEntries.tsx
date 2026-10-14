import type { Bakeoff, BakeoffEntry, BakeoffWriteup } from "@oh-my-pi/pi-wire/bakeoff";
import type { BlueprintRef } from "@oh-my-pi/pi-wire/blueprint";
import { Check, CircleAlert, Clock, ExternalLink, LoaderCircle, Square } from "lucide-react";
import type { ReactNode } from "react";
import { useId } from "react";
import { Markdown } from "../transcript/Markdown";
import { type BakeoffCodeAccess, CitedCode } from "./BakeoffCode";
import {
	canStopEntry,
	diagramMarkdown,
	type EntryTone,
	entryCostText,
	entryName,
	entryOrigin,
	entryStatusTone,
	entryStatusWord,
	factItems,
	mergedFlags,
	metricLabel,
} from "./bakeoff-result-flow";

/** What an entry card can do; the screen owns the requests and which entry they are busy on. */
export interface EntryHandlers {
	/** The entry being stopped. */
	stopping: string | null;
	/** Stop one entry; absent once the run is over. */
	onStop?(label: string): void;
	/** The entry whose session is being opened. */
	opening: string | null;
	onOpenSession?(entry: BakeoffEntry): void;
	/** Open a cited line of the checkout on screen, for an entry whose code that checkout holds. */
	openInEditor?(entry: BakeoffEntry, ref: BlueprintRef): void;
}

export interface EntryCardProps extends EntryHandlers {
	bakeoff: Bakeoff;
	entry: BakeoffEntry;
	reveal: boolean;
	code: BakeoffCodeAccess;
	/** Show the whole write-up and the facts; otherwise the card is a status with the write-up one tap away. */
	detail: boolean;
	/** Markers of the result (rank, taken), shown beside the status. */
	markers?: ReactNode;
	/** Flags the ranking adds to the entry's own. */
	extraFlags?: readonly string[];
	children?: ReactNode;
}

function StatusIcon({ tone }: { tone: EntryTone }): ReactNode {
	if (tone === "busy") return <LoaderCircle size={13} className="sh-spin" aria-hidden="true" />;
	if (tone === "ok") return <Check size={13} aria-hidden="true" />;
	if (tone === "err") return <CircleAlert size={13} aria-hidden="true" />;
	return <Clock size={13} aria-hidden="true" />;
}

/** The write-up of an entry: summary, approach, diagram, trade-offs, risks, migration, evidence per metric, cited code. */
export function Writeup({
	bakeoff,
	entry,
	writeup,
	code,
	openInEditor,
}: {
	bakeoff: Bakeoff;
	entry: BakeoffEntry;
	writeup: BakeoffWriteup;
	code: BakeoffCodeAccess;
	openInEditor?: EntryHandlers["openInEditor"];
}): ReactNode {
	const evidence = Object.entries(writeup.metrics);
	return (
		<div className="bo-wu">
			<p className="bo-wu-summary">{writeup.summary}</p>
			<section className="bo-wu-part" aria-label="Approach">
				<h4 className="bo-heading">Approach</h4>
				<Markdown text={writeup.approach} />
			</section>
			{writeup.diagram !== undefined && writeup.diagram.trim() !== "" && (
				<section className="bo-wu-part" aria-label="Diagram">
					<h4 className="bo-heading">Diagram</h4>
					<Markdown text={diagramMarkdown(writeup.diagram)} />
				</section>
			)}
			{writeup.tradeoffs.length > 0 && (
				<section className="bo-wu-part" aria-label="Trade-offs">
					<h4 className="bo-heading">What it gives up</h4>
					<ul className="bo-list">
						{writeup.tradeoffs.map(item => (
							<li key={item}>{item}</li>
						))}
					</ul>
				</section>
			)}
			{writeup.risks.length > 0 && (
				<section className="bo-wu-part" aria-label="Risks">
					<h4 className="bo-heading">What could go wrong</h4>
					<ul className="bo-list">
						{writeup.risks.map(item => (
							<li key={item}>{item}</li>
						))}
					</ul>
				</section>
			)}
			{writeup.migration.trim() !== "" && (
				<section className="bo-wu-part" aria-label="Migration">
					<h4 className="bo-heading">What changes for what exists</h4>
					<p className="bo-text">{writeup.migration}</p>
				</section>
			)}
			{evidence.length > 0 && (
				<section className="bo-wu-part" aria-label="Evidence per metric">
					<h4 className="bo-heading">On each thing that matters</h4>
					<dl className="bo-evidence">
						{evidence.map(([id, line]) => (
							<div key={id} className="bo-evidence-item">
								<dt>{metricLabel(bakeoff.metrics, id)}</dt>
								<dd>{line}</dd>
							</div>
						))}
					</dl>
				</section>
			)}
			<CitedCode
				title={`Code cited by ${entryName(entry, false)}`}
				access={code}
				entry={entry.label}
				refs={writeup.refs}
				openInEditor={openInEditor === undefined ? undefined : ref => openInEditor(entry, ref)}
			/>
		</div>
	);
}

/** One entry: its label, how far it is, what it cost, what was measured, and, once there is one, its write-up. */
export function EntryCard({
	bakeoff,
	entry,
	reveal,
	code,
	detail,
	markers,
	extraFlags,
	children,
	stopping,
	onStop,
	opening,
	onOpenSession,
	openInEditor,
}: EntryCardProps): ReactNode {
	const titleId = useId();
	const tone = entryStatusTone(entry.status);
	const origin = entryOrigin(entry, reveal);
	const cost = entryCostText(entry);
	const flags = mergedFlags(entry.flags, extraFlags);
	const facts = entry.facts === undefined ? [] : factItems(entry.facts);
	const stoppable = onStop !== undefined && canStopEntry(entry);
	const writeup =
		entry.writeup === undefined ? null : (
			<Writeup bakeoff={bakeoff} entry={entry} writeup={entry.writeup} code={code} openInEditor={openInEditor} />
		);
	return (
		<article className="bo-card" data-status={entry.status} aria-labelledby={titleId}>
			<header className="bo-card-head">
				<span className="bo-badge" aria-hidden="true">
					{entry.label}
				</span>
				<div className="bo-card-title">
					<h3 id={titleId} className="bo-card-name">
						{entryName(entry, false)}
					</h3>
					{origin !== null && <span className="bo-origin">{origin}</span>}
				</div>
				<span className="bo-status-pill" data-tone={tone}>
					<StatusIcon tone={tone} /> {entryStatusWord(entry.status)}
				</span>
			</header>
			{markers !== undefined && <div className="bo-markers">{markers}</div>}
			{entry.error !== undefined && (
				<div className="bo-alert" role="alert">
					<CircleAlert size={15} aria-hidden="true" />
					<span>{entry.error}</span>
				</div>
			)}
			{(cost !== null || flags.length > 0 || (reveal && entry.branch !== undefined)) && (
				<div className="bo-meta">
					{cost !== null && <span className="bo-cost">Spent {cost}</span>}
					{reveal && entry.branch !== undefined && <code className="bo-branch">{entry.branch}</code>}
					{flags.map(flag => (
						<span key={flag} className="bo-tag" data-kind="flag">
							{flag}
						</span>
					))}
				</div>
			)}
			{facts.length > 0 && (
				<ul className="bo-facts" aria-label="Measured facts">
					{facts.map(item => (
						<li key={item.key} className="bo-fact" data-tone={item.tone}>
							{item.text}
						</li>
					))}
				</ul>
			)}
			{writeup !== null &&
				(detail ? (
					writeup
				) : (
					<details className="bo-more">
						<summary>Read the write-up</summary>
						{writeup}
					</details>
				))}
			{(onOpenSession !== undefined && entry.instanceId !== undefined) || stoppable ? (
				<div className="bo-card-actions">
					{onOpenSession !== undefined && entry.instanceId !== undefined && (
						<button
							type="button"
							className="sh-btn"
							disabled={opening !== null}
							onClick={() => onOpenSession(entry)}
						>
							{opening === entry.label ? (
								<LoaderCircle size={14} className="sh-spin" />
							) : (
								<ExternalLink size={14} />
							)}{" "}
							Open session
						</button>
					)}
					{stoppable && (
						<button
							type="button"
							className="sh-btn bo-danger"
							disabled={stopping !== null}
							onClick={() => onStop(entry.label)}
						>
							{stopping === entry.label ? <LoaderCircle size={14} className="sh-spin" /> : <Square size={14} />}{" "}
							Stop
						</button>
					)}
				</div>
			) : null}
			{children}
		</article>
	);
}

/** Every entry as a card: stacked on a phone, in a grid beside each other where there is room. */
export function EntryGrid({
	bakeoff,
	reveal,
	code,
	detail,
	...handlers
}: EntryHandlers & { bakeoff: Bakeoff; reveal: boolean; code: BakeoffCodeAccess; detail: boolean }): ReactNode {
	const entries = [...bakeoff.entries].sort((a, b) => a.label.localeCompare(b.label));
	return (
		<ul className="bo-grid" aria-label="Entries">
			{entries.map(entry => (
				<li key={entry.label} className="bo-grid-item">
					<EntryCard bakeoff={bakeoff} entry={entry} reveal={reveal} code={code} detail={detail} {...handlers} />
				</li>
			))}
		</ul>
	);
}
