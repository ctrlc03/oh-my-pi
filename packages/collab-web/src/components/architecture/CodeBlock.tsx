import type { CSSProperties, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ExportedExcerpt } from "./blueprint-model";

/**
 * Lines of one excerpt with a gutter, the cited line banded, and the syntax colours when `highlight` can make them
 * (an exported excerpt carries its own). Shared by the architecture maps' code panel and the quiz.
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
	useEffect(() => {
		const box = frame.current;
		if (!compact || box === null) {
			if (box !== null) box.scrollTop = 0;
			return;
		}
		// Two lines of context above the cited one: the window opens on it rather than on the top of the excerpt.
		const row = Number.parseFloat(getComputedStyle(box).fontSize) * 1.5;
		box.scrollTop = Math.max(0, (hit - 3) * row);
	}, [compact, hit]);
	return (
		<div
			ref={frame}
			className={compact ? "ar-code ar-code-compact" : "ar-code"}
			role="figure"
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
