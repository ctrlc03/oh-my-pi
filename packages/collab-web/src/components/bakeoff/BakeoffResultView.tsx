import type { Bakeoff, BakeoffEntry, BakeoffFinding, BakeoffResult } from "@oh-my-pi/pi-wire/bakeoff";
import { CircleAlert, Info, Trophy, TriangleAlert } from "lucide-react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { Markdown } from "../transcript/Markdown";
import { type BakeoffCodeAccess, CitedCode, CodeSheet } from "./BakeoffCode";
import { EntryCard, type EntryHandlers } from "./BakeoffEntries";
import {
	agreementSummary,
	citationRef,
	citationText,
	entryName,
	INELIGIBLE_NOTE,
	judgeRanking,
	mergedFlags,
	pairRows,
	parseVerdictCitations,
	percent,
	type RankRow,
	rankRows,
	rankText,
	resultNotes,
	reviewerRanking,
	scoreCell,
	scoreMetrics,
	type VerdictCitation,
	verdictCitations,
	verdictViews,
} from "./bakeoff-result-flow";

function entryOf(bakeoff: Bakeoff, label: string): BakeoffEntry | undefined {
	return bakeoff.entries.find(entry => entry.label === label);
}

/** `Entry A, Entry B, Entry C`, or with models shown, each with who made it. */
function orderText(bakeoff: Bakeoff, labels: readonly string[], reveal: boolean): string {
	return labels
		.map(label => {
			const entry = entryOf(bakeoff, label);
			return entry === undefined ? `Entry ${label}` : entryName(entry, reveal);
		})
		.join(", then ");
}

// ── the ranked list ──────────────────────────────────────────────────────────

function RankingList({
	bakeoff,
	rows,
	reveal,
	selected,
	onSelect,
}: {
	bakeoff: Bakeoff;
	rows: readonly RankRow[];
	reveal: boolean;
	selected: string | null;
	onSelect(label: string): void;
}): ReactNode {
	return (
		<ol className="bo-ranking" aria-label="Ranking">
			{rows.map(row => {
				const entry = entryOf(bakeoff, row.label);
				const name = entry === undefined ? `Entry ${row.label}` : entryName(entry, reveal);
				const flags = mergedFlags(row.flags, entry?.flags);
				return (
					<li key={row.label} className="bo-rank">
						<button
							type="button"
							className="bo-rank-btn"
							aria-current={selected === row.label ? "true" : undefined}
							aria-label={`${name}, rank ${rankText(row)}, ${row.percent} percent`}
							onClick={() => onSelect(row.label)}
						>
							<span className="bo-rank-num" aria-hidden="true">
								{rankText(row)}
							</span>
							<span className="bo-rank-main">
								<span className="bo-rank-line">
									<span className="bo-badge" aria-hidden="true">
										{row.label}
									</span>
									<span className="bo-rank-name">{name}</span>
									{row.taken && (
										<span className="bo-tag" data-kind="taken">
											<Trophy size={11} aria-hidden="true" /> Taken
										</span>
									)}
								</span>
								<span className="bo-bar-line">
									<span className="bo-bar" aria-hidden="true">
										<span className="bo-bar-fill" style={{ width: `${row.percent}%` }} />
									</span>
									<span className="bo-bar-text">{row.percent}%</span>
								</span>
								{row.reason !== null && <span className="bo-rank-reason">{row.reason}</span>}
								{(!row.eligible || flags.length > 0) && (
									<span className="bo-rank-tags">
										{!row.eligible && (
											<span className="bo-tag" data-kind="ineligible">
												<TriangleAlert size={11} aria-hidden="true" /> {INELIGIBLE_NOTE}
											</span>
										)}
										{flags.map(flag => (
											<span key={flag} className="bo-tag" data-kind="flag">
												{flag}
											</span>
										))}
									</span>
								)}
							</span>
						</button>
					</li>
				);
			})}
		</ol>
	);
}

// ── the verdict ──────────────────────────────────────────────────────────────

/** The verdict as Markdown with each `A/path@line@token` in it made tappable: a tap opens the code it cites. */
function VerdictText({ text, onCite }: { text: string; onCite(citation: VerdictCitation): void }): ReactNode {
	const root = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		for (const node of root.current?.querySelectorAll<HTMLElement>("code") ?? []) {
			if (node.closest("pre") !== null) continue;
			const [segment] = parseVerdictCitations(`\`${node.textContent ?? ""}\``);
			if (segment?.kind !== "citation") continue;
			node.setAttribute("role", "button");
			node.tabIndex = 0;
			node.dataset.cite = "";
			node.dataset.label = segment.label;
			node.dataset.path = segment.path;
			node.dataset.line = String(segment.line);
			node.dataset.token = segment.token;
			node.setAttribute("aria-label", `Show code at ${segment.path} line ${segment.line} of entry ${segment.label}`);
		}
	}, [text]);
	const citationOf = (target: EventTarget): VerdictCitation | null => {
		const node = (target as Element).closest<HTMLElement>("code[data-cite]");
		if (node === null) return null;
		const { label, path, line, token } = node.dataset;
		return label === undefined || path === undefined || token === undefined
			? null
			: { label, path, line: Number(line), token };
	};
	const onClick = (event: MouseEvent<HTMLDivElement>): void => {
		const citation = citationOf(event.target);
		if (citation !== null) onCite(citation);
	};
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
		if (event.key !== "Enter" && event.key !== " ") return;
		const citation = citationOf(event.target);
		if (citation === null) return;
		event.preventDefault();
		onCite(citation);
	};
	return (
		// The wrapper only delegates: each citation inside it is its own focusable button.
		<div ref={root} className="bo-verdict-text" onClick={onClick} onKeyDown={onKeyDown} role="presentation">
			<Markdown text={text} />
		</div>
	);
}

function Verdict({
	bakeoff,
	result,
	reveal,
	code,
}: {
	bakeoff: Bakeoff;
	result: BakeoffResult;
	reveal: boolean;
	code: BakeoffCodeAccess;
}): ReactNode {
	const views = verdictViews(result);
	const [viewId, setViewId] = useState(views[0]!.id);
	const [cited, setCited] = useState<VerdictCitation | null>(null);
	const view = views.find(item => item.id === viewId) ?? views[0]!;
	const citations = verdictCitations(view.text);
	return (
		<section className="bo-section" aria-labelledby="bo-verdict-title">
			<h3 id="bo-verdict-title" className="bo-heading">
				What the reviewer found
			</h3>
			{views.length > 1 && (
				<div className="bo-switch" role="group" aria-label="Reviewer readings">
					{views.map(item => (
						<button
							key={item.id}
							type="button"
							className="sh-btn bo-switch-btn"
							aria-pressed={item.id === view.id}
							onClick={() => setViewId(item.id)}
						>
							{item.label}
						</button>
					))}
				</div>
			)}
			{view.ranking !== undefined && (
				<p className="bo-note">This reading put {orderText(bakeoff, view.ranking, reveal)}.</p>
			)}
			<VerdictText text={view.text} onCite={setCited} />
			{citations.length > 0 && (
				<details className="bo-more">
					<summary>Code the verdict cites ({citations.length})</summary>
					<ul className="bo-cites">
						{citations.map(citation => (
							<li key={`${citation.label}/${citation.path}@${citation.line}@${citation.token}`}>
								<button type="button" className="sh-btn bo-small" onClick={() => setCited(citation)}>
									<span className="bo-badge" aria-hidden="true">
										{citation.label}
									</span>
									<code>{citationText(citation)}</code>
								</button>
							</li>
						))}
					</ul>
				</details>
			)}
			{cited !== null && (
				<CodeSheet
					title={`Entry ${cited.label}: ${citationText(cited)}`}
					access={code}
					entry={cited.label}
					refs={[citationRef(cited)]}
					onClose={() => setCited(null)}
				/>
			)}
		</section>
	);
}

// ── scores and comparisons ───────────────────────────────────────────────────

function ScoreTable({
	bakeoff,
	result,
	labels,
}: {
	bakeoff: Bakeoff;
	result: BakeoffResult;
	labels: readonly string[];
}): ReactNode {
	const metrics = scoreMetrics(result, bakeoff.metrics);
	if (metrics.length === 0 || Object.keys(result.scores).length === 0) return null;
	return (
		<section className="bo-section" aria-labelledby="bo-scores-title">
			<h3 id="bo-scores-title" className="bo-heading">
				Scores for each thing that matters
			</h3>
			<div className="bo-table-wrap">
				<table className="bo-table">
					<thead>
						<tr>
							<th scope="col">Matters</th>
							{labels.map(label => (
								<th key={label} scope="col">
									Entry {label}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{metrics.map(metric => (
							<tr key={metric.id}>
								<th scope="row">{metric.label}</th>
								{labels.map(label => {
									const cell = scoreCell(result.scores[label]?.[metric.id]);
									return (
										<td key={label}>
											{cell.combined === null && cell.parts.length === 0 ? (
												<span className="bo-faint">{"\u2013"}</span>
											) : (
												<>
													<span className="bo-score-main">{cell.combined ?? ""}</span>
													{cell.measured && (
														<span className="bo-tag" data-kind="measured">
															measured
														</span>
													)}
													<span className="bo-score-parts">
														{cell.parts
															.filter(part => part.kind !== "measured")
															.map(
																part =>
																	`${part.kind === "reviewer" ? "Reviewer" : "Judge"} ${part.text}`,
															)
															.join(" · ")}
													</span>
												</>
											)}
										</td>
									);
								})}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</section>
	);
}

function PairTable({ bakeoff, result }: { bakeoff: Bakeoff; result: BakeoffResult }): ReactNode {
	const rows = pairRows(result.pairwise ?? [], bakeoff.metrics);
	if (rows.length === 0) return null;
	return (
		<details className="bo-more bo-section">
			<summary>How the second opinion compared the entries ({rows.length})</summary>
			<div className="bo-table-wrap">
				<table className="bo-table">
					<thead>
						<tr>
							<th scope="col">Pair</th>
							<th scope="col">Matters</th>
							<th scope="col">Better</th>
						</tr>
					</thead>
					<tbody>
						{rows.map(row => (
							<tr key={row.key}>
								<td>{row.pair}</td>
								<td>{row.metric}</td>
								<td>{row.outcome}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</details>
	);
}

// ── the overview ─────────────────────────────────────────────────────────────

export interface ResultOverviewProps extends EntryHandlers {
	bakeoff: Bakeoff;
	result: BakeoffResult;
	reveal: boolean;
	code: BakeoffCodeAccess;
	/** The entry whose detail is on screen. */
	selected: string | null;
	onSelect(label: string): void;
}

/** The verdict at a glance: whether the reviewer and judge agree, the ranked list, the reviewer's text, the scores. */
export function ResultOverview({
	bakeoff,
	result,
	reveal,
	code,
	selected,
	onSelect,
	...handlers
}: ResultOverviewProps): ReactNode {
	const rows = rankRows(result);
	const agreement = agreementSummary(result);
	const notes = resultNotes(result);
	const split = agreement.kind === "split";
	const reviewer = split ? reviewerRanking(result, bakeoff.metrics) : null;
	const judge = split ? judgeRanking(result, bakeoff.metrics) : null;
	const unranked = bakeoff.entries.filter(entry => !result.ranking.some(item => item.label === entry.label));
	return (
		<div className="bo-overview">
			<div className="bo-banner" data-tone={agreement.tone}>
				<span className="bo-agree" data-tone={agreement.tone}>
					{agreement.text}
				</span>
				{agreement.note !== null && <span className="bo-banner-note">{agreement.note}</span>}
			</div>
			{split && (reviewer !== null || judge !== null) && (
				<ul className="bo-orders" aria-label="Both rankings">
					{reviewer !== null && <li>The reviewer put {orderText(bakeoff, reviewer, reveal)}.</li>}
					{judge !== null && <li>The second opinion put {orderText(bakeoff, judge, reveal)}.</li>}
				</ul>
			)}
			{notes.map(note => (
				<div key={note.key} className="bo-notice" data-tone={note.tone} role="note">
					{note.tone === "warn" ? (
						<TriangleAlert size={15} aria-hidden="true" />
					) : (
						<Info size={15} aria-hidden="true" />
					)}
					<span>{note.text}</span>
				</div>
			))}
			<RankingList bakeoff={bakeoff} rows={rows} reveal={reveal} selected={selected} onSelect={onSelect} />
			{unranked.length > 0 && (
				<section className="bo-section" aria-labelledby="bo-unranked-title">
					<h3 id="bo-unranked-title" className="bo-heading">
						Not ranked
					</h3>
					<ul className="bo-grid">
						{unranked.map(entry => (
							<li key={entry.label} className="bo-grid-item">
								<EntryCard
									bakeoff={bakeoff}
									entry={entry}
									reveal={reveal}
									code={code}
									detail={false}
									{...handlers}
									onStop={undefined}
								/>
							</li>
						))}
					</ul>
				</section>
			)}
			<Verdict bakeoff={bakeoff} result={result} reveal={reveal} code={code} />
			{result.unsure.length > 0 && (
				<section className="bo-section" aria-labelledby="bo-unsure-title">
					<h3 id="bo-unsure-title" className="bo-heading">
						What the reviewer could not tell
					</h3>
					<ul className="bo-list">
						{result.unsure.map(item => (
							<li key={item}>{item}</li>
						))}
					</ul>
				</section>
			)}
			<ScoreTable bakeoff={bakeoff} result={result} labels={rows.map(row => row.label)} />
			<PairTable bakeoff={bakeoff} result={result} />
			{bakeoff.warnings.length > 0 && (
				<details className="bo-more bo-section">
					<summary>Notes from this run ({bakeoff.warnings.length})</summary>
					<ul className="bo-list">
						{bakeoff.warnings.map(warning => (
							<li key={warning}>{warning}</li>
						))}
					</ul>
				</details>
			)}
		</div>
	);
}

// ── one entry of the result ──────────────────────────────────────────────────

function Findings({
	kind,
	findings,
	entry,
	code,
}: {
	kind: BakeoffFinding["kind"];
	findings: readonly BakeoffFinding[];
	entry: BakeoffEntry;
	code: BakeoffCodeAccess;
}): ReactNode {
	if (findings.length === 0) return null;
	const title = kind === "strength" ? "Strengths" : "Weaknesses";
	return (
		<section className="bo-section" aria-label={title}>
			<h4 className="bo-heading" data-kind={kind}>
				{title}
			</h4>
			<ul className="bo-findings">
				{findings.map(finding => (
					<li key={finding.text} className="bo-finding" data-verified={finding.verified}>
						<span>{finding.text}</span>
						{!finding.verified && (
							<span className="bo-unchecked">
								<CircleAlert size={12} aria-hidden="true" /> not checked against code
							</span>
						)}
						{finding.refs !== undefined && finding.refs.length > 0 && (
							<CitedCode
								title={`Code cited for ${entryName(entry, false)}`}
								access={code}
								entry={entry.label}
								refs={finding.refs}
							/>
						)}
					</li>
				))}
			</ul>
		</section>
	);
}

export interface EntryDetailProps extends EntryHandlers {
	bakeoff: Bakeoff;
	result: BakeoffResult;
	entry: BakeoffEntry;
	reveal: boolean;
	code: BakeoffCodeAccess;
	/** The things to do with this entry (take, copy, map, spar). */
	children?: ReactNode;
}

/** An entry's card in the result: where it ranks, why, the reviewer's strengths and weaknesses with code, and what to do with it. */
export function EntryDetail({
	bakeoff,
	result,
	entry,
	reveal,
	code,
	children,
	...handlers
}: EntryDetailProps): ReactNode {
	const ranked = result.ranking.find(item => item.label === entry.label);
	const row = rankRows(result).find(item => item.label === entry.label);
	const mine = result.findings.filter(finding => finding.label === entry.label);
	return (
		<EntryCard
			bakeoff={bakeoff}
			entry={entry}
			reveal={reveal}
			code={code}
			detail
			extraFlags={ranked?.flags}
			markers={
				row === undefined ? undefined : (
					<>
						<span className="bo-tag" data-kind="rank">
							Rank {rankText(row)} · {percent(row.score)}%
						</span>
						{row.taken && (
							<span className="bo-tag" data-kind="taken">
								<Trophy size={11} aria-hidden="true" /> Taken
							</span>
						)}
						{!row.eligible && (
							<span className="bo-tag" data-kind="ineligible">
								<TriangleAlert size={11} aria-hidden="true" /> {INELIGIBLE_NOTE}
							</span>
						)}
					</>
				)
			}
			{...handlers}
			onStop={undefined}
		>
			{ranked !== undefined && ranked.reasons.length > 0 && (
				<section className="bo-section" aria-label="Why it ranks here">
					<h4 className="bo-heading">Why it ranks here</h4>
					<ul className="bo-list">
						{ranked.reasons.map(reason => (
							<li key={reason}>{reason}</li>
						))}
					</ul>
				</section>
			)}
			<Findings kind="strength" findings={mine.filter(item => item.kind === "strength")} entry={entry} code={code} />
			<Findings kind="weakness" findings={mine.filter(item => item.kind === "weakness")} entry={entry} code={code} />
			{children}
		</EntryCard>
	);
}
