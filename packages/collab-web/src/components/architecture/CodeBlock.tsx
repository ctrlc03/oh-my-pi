import type { CSSProperties, ReactNode } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ExportedExcerpt } from "./blueprint-model";

/**
 * Lines of one excerpt with a gutter, the cited line banded, and the syntax colours when `highlight` can make them
 * (an exported excerpt carries its own). Shared by the architecture maps' code panel, the quiz, the sparring partner
 * and the bake-off. The box scrolls inside a maximum height and opens with the cited line in view; when lines are added
 * above it (a wider excerpt of the same code) what the reader was looking at stays in place.
 */
export function CodeBlock({
	excerpt,
	highlight,
	compact = false,
}: {
	excerpt: ExportedExcerpt;
	highlight?: (excerpt: ExportedExcerpt) => Promise<string | undefined>;
	/** A window of a few lines with the cited line in view, for a screen with no room beside the question. */
	compact?: boolean;
}): ReactNode {
	const frame = useRef<HTMLDivElement>(null);
	const [html, setHtml] = useState<{ lines: string; html: string } | null>(
		excerpt.html === undefined ? null : { lines: excerpt.lines.join("\n"), html: excerpt.html },
	);
	const text = useMemo(() => excerpt.lines.join("\n"), [excerpt.lines]);
	useEffect(() => {
		if (excerpt.html !== undefined) {
			setHtml({ lines: text, html: excerpt.html });
			return;
		}
		if (highlight === undefined) return;
		let live = true;
		highlight(excerpt).then(
			markup => {
				if (live && markup !== undefined) setHtml({ lines: text, html: markup });
			},
			// Offline or chunk missing: the code simply stays plain.
			() => {},
		);
		return () => {
			live = false;
		};
	}, [excerpt, highlight, text]);
	const gutter = useMemo(() => excerpt.lines.map((_, i) => excerpt.start + i).join("\n"), [excerpt]);
	const hit = excerpt.line - excerpt.start + 1;
	const identity = `${excerpt.side}:${excerpt.commit}:${excerpt.path}:${excerpt.line}`;
	const placed = useRef<{ identity: string; start: number; compact: boolean } | null>(null);
	useLayoutEffect(() => {
		const box = frame.current;
		if (box === null) return;
		const before = placed.current;
		placed.current = { identity, start: excerpt.start, compact };
		const row = Number.parseFloat(getComputedStyle(box).fontSize) * 1.5;
		if (compact) {
			// Two lines of context above the cited one: the window opens on it rather than on the top of the excerpt.
			box.scrollTop = Math.max(0, (hit - 3) * row);
			return;
		}
		const pad = Number.parseFloat(getComputedStyle(box.querySelector(".ar-code-text") ?? box).paddingTop);
		const top = pad + (hit - 1) * row;
		if (before !== null && before.identity === identity && !before.compact) {
			// The same code, wider. Lines added above push it down: keep the reader where they were and show some of the
			// new lines, but never at the cost of the cited line, which stays in view.
			const added = (before.start - excerpt.start) * row;
			if (added > 0) {
				const target = box.scrollTop + added - Math.min(added, box.clientHeight * 0.6);
				box.scrollTop = Math.max(target, top + 2 * row - box.clientHeight);
			}
			return;
		}
		// First sight: the cited line in view, in the middle of the box unless it is already near the top.
		box.scrollTop = top + row > box.clientHeight ? Math.max(0, top - (box.clientHeight - row) / 2) : 0;
	}, [compact, hit, identity, excerpt.start]);
	return (
		<div
			ref={frame}
			className={compact ? "ar-code ar-code-compact" : "ar-code"}
			role="figure"
			tabIndex={-1}
			aria-label={`Code around line ${excerpt.line} of ${excerpt.path}`}
		>
			<pre className="ar-code-gutter" aria-hidden>
				{gutter}
			</pre>
			<pre className="ar-code-text">
				{hit >= 1 && hit <= excerpt.lines.length && (
					<span className="ar-code-hit" style={{ "--hit-line": hit } as CSSProperties} aria-hidden />
				)}
				{html !== null && html.lines === text ? (
					<code className="ar-code-body" dangerouslySetInnerHTML={{ __html: html.html }} />
				) : (
					<code className="ar-code-body">{text}</code>
				)}
			</pre>
		</div>
	);
}
