import type { BlueprintRef } from "@oh-my-pi/pi-wire/blueprint";
import { ChevronDown, ChevronUp, ExternalLink, LoaderCircle, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useRef, useState } from "react";
import { useNarrow } from "./use-narrow";
import { useRequest } from "../../lib/use-request";
import { CodeBlock } from "../architecture/CodeBlock";
import type { ExportedExcerpt } from "../architecture/blueprint-model";
import { refKey } from "../architecture/blueprint-model";
import { highlightExcerpt } from "../architecture/highlight-excerpt";

/** Excerpts already read, by part and citation: going back to a question does not read its code again. */
export type ExcerptCache = Map<string, ExportedExcerpt | null>;

function cacheKey(part: number, ref: BlueprintRef): string {
	return `${part}:${refKey(ref)}`;
}

/** Reads the code around citations at a part's commit, in the order of `refs`; null for a ref the commit does not have. Keep it stable between renders. */
export type ExcerptReader = (part: number, refs: BlueprintRef[]) => Promise<(ExportedExcerpt | null)[]>;

export interface QuizCodeProps {
	excerpts: ExcerptReader;
	/** The part whose commit the citations are read at. */
	part: number;
	refs: readonly BlueprintRef[];
	cache: ExcerptCache;
	/** Opens a cited line of the current checkout in the editor; absent when it cannot be shown there. */
	openInEditor?: (ref: BlueprintRef) => void;
}

/** The code a question or its explanation cites: path and line, the code around it with the cited line banded. */
export function QuizCode({ excerpts, part, refs, cache, openInEditor }: QuizCodeProps): ReactNode {
	// The same citations under a new array (an attempt reloaded after an answer) are not a new request.
	const identity = refs.map(refKey).join("\n");
	const held = useRef({ identity, list: [...refs] });
	if (held.current.identity !== identity) held.current = { identity, list: [...refs] };
	const list = held.current.list;
	const load = useCallback(async (): Promise<(ExportedExcerpt | null)[]> => {
		const missing = list.filter(ref => !cache.has(cacheKey(part, ref)));
		if (missing.length > 0) {
			const got = await excerpts(part, missing);
			missing.forEach((ref, at) => cache.set(cacheKey(part, ref), got[at] ?? null));
		}
		return list.map(ref => cache.get(cacheKey(part, ref)) ?? null);
	}, [excerpts, part, list, cache]);
	const { state, reload } = useRequest(load);
	const narrow = useNarrow();
	const [open, setOpen] = useState(false);
	// Beside the question the code has room; under it, one short window until the reader asks for the rest.
	const compact = narrow && !open;
	const shown = compact ? list.slice(0, 1) : list;
	if (list.length === 0) return null;
	return (
		<div className="qz-refs">
			{state.status === "error" && (
				<div className="qz-alert" role="alert">
					{state.message}
					<button type="button" className="sh-btn" onClick={reload}>
						<RefreshCw size={14} /> Retry
					</button>
				</div>
			)}
			{shown.map((ref, at) => (
				<section key={refKey(ref)} className="qz-ref" aria-label={`${ref.path} line ${ref.line}`}>
					<div className="qz-ref-head">
						<span className="qz-ref-where">
							<code className="qz-ref-path">
								{ref.path}:{ref.line}
							</code>
							<code className="qz-ref-token">{ref.token}</code>
							{ref.side === "base" && <span className="qz-chip qz-chip-before">before</span>}
						</span>
						{openInEditor !== undefined && ref.side !== "base" && (
							<button type="button" className="sh-btn qz-small" onClick={() => openInEditor(ref)}>
								<ExternalLink size={13} /> Open in editor
							</button>
						)}
					</div>
					{state.status === "loading" && (
						<div className="qz-status">
							<LoaderCircle size={14} className="sh-spin" /> Reading the code…
						</div>
					)}
					{state.status === "ready" &&
						(state.value[at] === null || state.value[at] === undefined ? (
							<p className="qz-note">The code is not available at that commit.</p>
						) : (
							<CodeBlock excerpt={state.value[at]} highlight={highlightExcerpt} compact={compact} />
						))}
				</section>
			))}
			{narrow && (
				<button type="button" className="sh-btn qz-code-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
					{open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}{" "}
					{open ? "Show less code" : `Show code (${list.length})`}
				</button>
			)}
		</div>
	);
}
