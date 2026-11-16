import { CaseSensitive, ChevronDown, ChevronRight, LoaderCircle, Regex, WholeWord } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { useEffect, useMemo, useState } from "react";
import type { CompanionClient } from "../../../lib/companion";
import type { FileSearchMatch, FileSearchResult } from "../../../lib/repo-intel";
import { baseName } from "../file-tree";
import { type SearchForm } from "./explorer-state";
import { compileHighlighter, groupMatches, resultCounts, type Span, splitBySpans, windowLine } from "./search-model";

/** The query is sent this long after the last keystroke. */
export const SEARCH_DEBOUNCE_MS = 300;
/** Shortest query that is searched for. */
export const MIN_QUERY = 2;

type SearchState =
	| { status: "idle" }
	| { status: "loading"; previous: FileSearchResult | null }
	| { status: "error"; message: string }
	| { status: "done"; result: FileSearchResult };

export interface SearchViewProps {
	client: CompanionClient;
	instanceId: string;
	/** The companion answers `file-search`. */
	canSearch: boolean;
	form: SearchForm;
	onForm(form: SearchForm): void;
	inputRef: RefObject<HTMLInputElement | null>;
	onOpen(path: string, line: number, character: number): void;
}

/** Content search over the repository: options, a debounced query and the matches grouped by file. */
export function SearchView({
	client,
	instanceId,
	canSearch,
	form,
	onForm,
	inputRef,
	onOpen,
}: SearchViewProps): ReactNode {
	const [state, setState] = useState<SearchState>({ status: "idle" });
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
	const { query, caseSensitive, wholeWord, regex, glob } = form;

	const highlighter = useMemo(
		() => compileHighlighter({ query, regex, caseSensitive, wholeWord }),
		[query, regex, caseSensitive, wholeWord],
	);
	const invalid = highlighter !== null && !highlighter.ok ? highlighter.message : null;
	const searchable = canSearch && query.length >= MIN_QUERY && invalid === null;

	useEffect(() => {
		if (!searchable) {
			setState({ status: "idle" });
			return;
		}
		// A newer query (or leaving) drops this one's answer; the companion may still finish it.
		let stale = false;
		const timer = setTimeout(() => {
			setState(previous => ({
				status: "loading",
				previous:
					previous.status === "done" ? previous.result : previous.status === "loading" ? previous.previous : null,
			}));
			client
				.searchFiles(instanceId, { query, regex, caseSensitive, wholeWord, glob: glob.trim() || undefined })
				.then(
					result => {
						if (stale) return;
						setState({ status: "done", result });
						setCollapsed(new Set());
					},
					(err: unknown) => {
						if (!stale) setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
					},
				);
		}, SEARCH_DEBOUNCE_MS);
		return () => {
			stale = true;
			clearTimeout(timer);
		};
	}, [searchable, client, instanceId, query, regex, caseSensitive, wholeWord, glob]);

	const shown = state.status === "done" ? state.result : state.status === "loading" ? state.previous : null;
	const groups = useMemo(() => (shown === null ? [] : groupMatches(shown.matches)), [shown]);
	const toggleOption = (key: "caseSensitive" | "wholeWord" | "regex"): void => onForm({ ...form, [key]: !form[key] });
	const toggleGroup = (path: string): void =>
		setCollapsed(previous => {
			const next = new Set(previous);
			if (!next.delete(path)) next.add(path);
			return next;
		});

	return (
		<>
			<div className="sh-ex-search">
				<div className="sh-ex-query">
					<input
						ref={inputRef}
						type="text"
						className="sh-ex-input"
						value={query}
						onChange={event => onForm({ ...form, query: event.target.value })}
						placeholder="Search in files"
						aria-label="Search in files"
						aria-invalid={invalid !== null}
						spellCheck={false}
						autoComplete="off"
						autoCapitalize="off"
					/>
					<Toggle on={caseSensitive} label="Match case" onClick={() => toggleOption("caseSensitive")}>
						<CaseSensitive size={15} />
					</Toggle>
					<Toggle on={wholeWord} label="Match whole word" onClick={() => toggleOption("wholeWord")}>
						<WholeWord size={15} />
					</Toggle>
					<Toggle on={regex} label="Use regular expression" onClick={() => toggleOption("regex")}>
						<Regex size={15} />
					</Toggle>
				</div>
				<input
					type="text"
					className="sh-ex-input sh-ex-glob"
					value={glob}
					onChange={event => onForm({ ...form, glob: event.target.value })}
					placeholder="Files to include, e.g. src/**/*.ts"
					aria-label="Files to include"
					spellCheck={false}
					autoComplete="off"
					autoCapitalize="off"
				/>
			</div>
			<div className="sh-ex-scroll">
				{!canSearch ? (
					<div className="sh-ex-note">
						Searching file contents needs a newer companion. Update it on the computer that runs this session,
						then reload.
					</div>
				) : invalid !== null ? (
					<div className="sh-ex-note sh-ex-note-err" role="alert">
						{invalid}
					</div>
				) : query.length < MIN_QUERY ? (
					<div className="sh-ex-note">Type at least {MIN_QUERY} characters to search this repository.</div>
				) : state.status === "error" ? (
					<div className="sh-ex-note sh-ex-note-err" role="alert">
						{state.message}
					</div>
				) : (
					<>
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
													spans={
														highlighter !== null && highlighter.ok ? highlighter.spans(match.text) : []
													}
													onOpen={onOpen}
												/>
											))}
										</ul>
									)}
								</section>
							);
						})}
					</>
				)}
			</div>
		</>
	);
}

function Toggle({
	on,
	label,
	onClick,
	children,
}: {
	on: boolean;
	label: string;
	onClick(): void;
	children: ReactNode;
}): ReactNode {
	return (
		<button
			type="button"
			className="sh-ex-icon-btn sh-ex-toggle"
			aria-pressed={on}
			aria-label={label}
			title={label}
			onClick={onClick}
		>
			{children}
		</button>
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
