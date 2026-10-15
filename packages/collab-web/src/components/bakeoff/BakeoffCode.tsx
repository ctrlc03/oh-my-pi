import type { BlueprintExcerptRef, BlueprintRef } from "@oh-my-pi/pi-wire/blueprint";
import { ChevronDown, ChevronUp, ExternalLink, LoaderCircle, RefreshCw, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useRef, useState } from "react";
import { useRequest } from "../../lib/use-request";
import type { WidenExcerpt } from "../architecture/ExpandableCode";
import { ExpandableCode } from "../architecture/ExpandableCode";
import type { ExportedExcerpt } from "../architecture/blueprint-model";
import { refKey } from "../architecture/blueprint-model";
import { highlightExcerpt } from "../architecture/highlight-excerpt";
import type { ExcerptCache } from "../quiz/QuizCode";
import { useNarrow } from "../quiz/use-narrow";
import { Sheet } from "../shell/Sheet";
import "../architecture/architecture.css";

/** Reads the code around citations in an entry, in the order of `refs`; null for a ref it does not have. Keep it stable between renders. */
export type BakeoffExcerptReader = (entry: string, refs: BlueprintExcerptRef[]) => Promise<(ExportedExcerpt | null)[]>;

/** How the screen reads cited code: one reader and one cache for the whole bake-off. */
export interface BakeoffCodeAccess {
	excerpts: BakeoffExcerptReader;
	cache: ExcerptCache;
}

export interface BakeoffCodeProps {
	access: BakeoffCodeAccess;
	/** The entry (its label) whose code the citations are read in. */
	entry: string;
	refs: readonly BlueprintRef[];
	/** Opens a cited line of the checkout on screen; given only when that checkout holds this entry's code. */
	openInEditor?: (ref: BlueprintRef) => void;
}

function cacheKey(entry: string, ref: BlueprintRef): string {
	return `${entry}:${refKey(ref)}`;
}

/** The code each citation points at: path and line, then the code around it with the cited line banded. */
function ExcerptList({ access, entry, refs, openInEditor }: BakeoffCodeProps): ReactNode {
	const { excerpts, cache } = access;
	// The same citations under a new array (a result reloaded by a push) are not a new request.
	const identity = refs.map(refKey).join("\n");
	const held = useRef({ identity, list: [...refs] });
	if (held.current.identity !== identity) held.current = { identity, list: [...refs] };
	const list = held.current.list;
	const load = useCallback(async (): Promise<(ExportedExcerpt | null)[]> => {
		const missing = list.filter(ref => !cache.has(cacheKey(entry, ref)));
		if (missing.length > 0) {
			const got = await excerpts(entry, missing);
			missing.forEach((ref, at) => cache.set(cacheKey(entry, ref), got[at] ?? null));
		}
		return list.map(ref => cache.get(cacheKey(entry, ref)) ?? null);
	}, [excerpts, entry, list, cache]);
	const { state, reload } = useRequest(load);
	// A widened excerpt replaces the one read first, so it is still wide when the list is shown again.
	const widen = useCallback<WidenExcerpt>(
		async request => {
			const [found] = await excerpts(entry, [request]);
			if (found === undefined || found === null) return null;
			cache.set(cacheKey(entry, request), found);
			return found;
		},
		[excerpts, entry, cache],
	);
	return (
		<div className="bo-refs">
			{state.status === "error" && (
				<div className="bo-alert" role="alert">
					<span>{state.message}</span>
					<button type="button" className="sh-btn" onClick={reload}>
						<RefreshCw size={14} /> Retry
					</button>
				</div>
			)}
			{list.map((ref, at) => (
				<section key={refKey(ref)} className="bo-ref" aria-label={`${ref.path} line ${ref.line}`}>
					<div className="bo-ref-head">
						<span className="bo-ref-where">
							<code className="bo-ref-path">
								{ref.path}:{ref.line}
							</code>
							<code className="bo-ref-token">{ref.token}</code>
						</span>
						{openInEditor !== undefined && (
							<button type="button" className="sh-btn bo-small" onClick={() => openInEditor(ref)}>
								<ExternalLink size={13} /> Open in editor
							</button>
						)}
					</div>
					{state.status === "loading" && (
						<div className="bo-status">
							<LoaderCircle size={14} className="sh-spin" /> Reading the code…
						</div>
					)}
					{state.status === "ready" &&
						(state.value[at] === null || state.value[at] === undefined ? (
							<p className="bo-note">The code is not available in that entry.</p>
						) : (
							<ExpandableCode
								reference={ref}
								excerpt={state.value[at]}
								highlight={highlightExcerpt}
								widen={widen}
							/>
						))}
				</section>
			))}
		</div>
	);
}

/** Code that opens in a bottom sheet: what a tapped citation of the verdict shows. */
export function CodeSheet({
	title,
	onClose,
	...code
}: BakeoffCodeProps & { title: string; onClose(): void }): ReactNode {
	return (
		<Sheet label="cited code" size="wide" onClose={onClose}>
			<div className="sh-sheet-head bo-head">
				<span className="bo-head-title">{title}</span>
				<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="Close">
					<X size={16} />
				</button>
			</div>
			<div className="bo-code-sheet">
				<ExcerptList {...code} />
			</div>
		</Sheet>
	);
}

/** The code an entry's write-up cites, collapsed until asked for: inline beside the write-up, in a bottom sheet on a phone. */
export function CitedCode({ title, ...code }: BakeoffCodeProps & { title: string }): ReactNode {
	const narrow = useNarrow();
	const [open, setOpen] = useState(false);
	if (code.refs.length === 0) return null;
	return (
		<div className="bo-cited">
			<button
				type="button"
				className="sh-btn bo-code-toggle"
				aria-expanded={open}
				aria-haspopup={narrow ? "dialog" : undefined}
				onClick={() => setOpen(!open)}
			>
				{open && !narrow ? <ChevronUp size={14} /> : <ChevronDown size={14} />}{" "}
				{open && !narrow ? "Hide code" : `Show code (${code.refs.length})`}
			</button>
			{open && !narrow && <ExcerptList {...code} />}
			{open && narrow && <CodeSheet title={title} onClose={() => setOpen(false)} {...code} />}
		</div>
	);
}
