import { useEffect, useMemo, useState } from "react";
import type { CompanionClient } from "../../../lib/companion";
import type { FileSearchResult } from "../../../lib/repo-intel";
import type { SearchForm } from "./explorer-state";
import { compileHighlighter, type Highlighter } from "./search-model";

/** The query is sent this long after the last keystroke. */
export const SEARCH_DEBOUNCE_MS = 300;
/** Shortest query that is searched for. */
export const MIN_QUERY = 2;

export type SearchState =
	| { status: "idle" }
	| { status: "loading"; previous: FileSearchResult | null }
	| { status: "error"; message: string }
	| { status: "done"; result: FileSearchResult };

export interface FileSearch {
	state: SearchState;
	/** For the form's options; null for an empty query. */
	highlighter: Highlighter | null;
	/** Why the query cannot be searched (an invalid regular expression), else null. */
	invalid: string | null;
	/** Searches sent so far: a change brings the Search results tab forward. */
	runs: number;
}

/**
 * The explorer's content search: a debounced query for the form's options. The form is in the explorer, the
 * results in the editor's bottom panel, so the sheet runs this and hands each its half.
 */
export function useFileSearch(
	client: CompanionClient,
	instanceId: string,
	canSearch: boolean,
	form: SearchForm,
): FileSearch {
	const [state, setState] = useState<SearchState>({ status: "idle" });
	const [runs, setRuns] = useState(0);
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
			setRuns(count => count + 1);
			setState(previous => ({
				status: "loading",
				previous:
					previous.status === "done" ? previous.result : previous.status === "loading" ? previous.previous : null,
			}));
			client
				.searchFiles(instanceId, { query, regex, caseSensitive, wholeWord, glob: glob.trim() || undefined })
				.then(
					result => {
						if (!stale) setState({ status: "done", result });
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

	return { state, highlighter, invalid, runs };
}
