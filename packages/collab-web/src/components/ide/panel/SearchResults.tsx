import { ChevronDown, ChevronRight, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import type { FileSearchMatch, FileSearchResult } from "../../../lib/repo-intel";
import { baseName } from "../file-tree";
import { groupMatches, resultCounts, type Span, splitBySpans, windowLine } from "../explorer/search-model";
import { type FileSearch, MIN_QUERY } from "../explorer/use-file-search";

export interface SearchResultsProps {
	search: FileSearch;
	/** The companion answers `file-search`. */
	canSearch: boolean;
	/** The explorer's query box. */
	query: string;
	onOpen(path: string, line: number, character: number): void;
}

/** The matches of the explorer's content search, grouped by file; a match opens its file at the line. */
export function SearchResults({ search, canSearch, query, onOpen }: SearchResultsProps): ReactNode {
	const { state, highlighter, invalid } = search;
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
	const shown: FileSearchResult | null =
		state.status === "done" ? state.result : state.status === "loading" ? state.previous : null;
	// Each answer lists its files open.
	useEffect(() => {
		if (state.status === "done") setCollapsed(new Set());
	}, [state]);
	const groups = useMemo(() => (shown === null ? [] : groupMatches(shown.matches)), [shown]);
	const toggleGroup = (path: string): void =>
		setCollapsed(previous => {
			const next = new Set(previous);
			if (!next.delete(path)) next.add(path);
			return next;
		});

	if (!canSearch) {
		return (
			<div className="sh-ex-note">
				Searching file contents needs a newer companion. Update it on the computer that runs this session, then
				reload.
			</div>
		);
	}
	if (invalid !== null) {
		return (
			<div className="sh-ex-note sh-ex-note-err" role="alert">
				{invalid}
			</div>
		);
	}
	if (query.length < MIN_QUERY) {
		return (
			<div className="sh-ex-note">
				Type at least {MIN_QUERY} characters in the explorer's Search view to search this repository.
			</div>
		);
	}
	if (state.status === "error") {
		return (
			<div className="sh-ex-note sh-ex-note-err" role="alert">
				{state.message}
			</div>
		);
	}
	return (
		<div className="sh-ex-scroll">
			<div className="sh-ex-counts-head" aria-live="polite">
				{shown === null ? (
					<>
						<LoaderCircle size={13} className="sh-spin" /> Searching…
					</>
				) : (
					<>
						{shown.matches.length === 0 && state.status === "done"
							? "No results"
							: resultCounts(shown.matches.length, shown.files)}
						{shown.limited && <span className="sh-ex-more"> · more not shown, narrow the search</span>}
						{state.status === "loading" && <LoaderCircle size={13} className="sh-spin" />}
					</>
				)}
			</div>
			{groups.map(group => {
				const shut = collapsed.has(group.path);
				return (
					<section key={group.path} className="sh-ex-group" aria-label={group.path}>
						<button
							type="button"
							className="sh-ex-row sh-ex-file-head"
							onClick={() => toggleGroup(group.path)}
							aria-expanded={!shut}
							title={group.path}
						>
							{shut ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
							<span className="sh-ex-name">{baseName(group.path)}</span>
							{group.path.includes("/") && (
								<span className="sh-ex-dir">{group.path.slice(0, group.path.lastIndexOf("/"))}</span>
							)}
							<span className="sh-ex-count">{group.items.length}</span>
						</button>
						{!shut && (
							<ul className="sh-ex-list">
								{group.items.map(match => (
									<MatchRow
										key={`${match.line}:${match.character ?? 0}`}
										match={match}
										spans={highlighter !== null && highlighter.ok ? highlighter.spans(match.text) : []}
										onOpen={onOpen}
									/>
								))}
							</ul>
						)}
					</section>
				);
			})}
		</div>
	);
}

function MatchRow({
	match,
	spans,
	onOpen,
}: {
	match: FileSearchMatch;
	spans: readonly Span[];
	onOpen(path: string, line: number, character: number): void;
}): ReactNode {
	const view = windowLine(match.text, spans);
	return (
		<li>
			<button
				type="button"
				className="sh-ex-row sh-ex-match"
				onClick={() => onOpen(match.path, match.line, match.character ?? spans[0]?.[0] ?? 0)}
				title={`${match.path}:${match.line}`}
			>
				<span className="sh-ex-line">{match.line}</span>
				<span className="sh-ex-text">
					{splitBySpans(view.text, view.spans).map((run, i) =>
						run.hit ? (
							<mark key={i} className="sh-ex-hit">
								{run.text}
							</mark>
						) : (
							<span key={i}>{run.text}</span>
						),
					)}
				</span>
			</button>
		</li>
	);
}
