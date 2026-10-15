import { BLUEPRINT_EXCERPT_STEP, type BlueprintExcerptRef, type BlueprintRef } from "@oh-my-pi/pi-wire/blueprint";
import { ChevronsDown, ChevronsUp, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { ExportedExcerpt } from "./blueprint-model";
import { CodeBlock } from "./CodeBlock";
import type { WidenDirection } from "./excerpt-range";
import { linesLeft, widenRequest } from "./excerpt-range";

/** Reads one citation wider (the caller keeps what it gets, so the widening outlives this block); null when the code is gone. */
export type WidenExcerpt = (request: BlueprintExcerptRef) => Promise<ExportedExcerpt | null>;

function moreLabel(left: number): string {
	const count = Math.min(BLUEPRINT_EXCERPT_STEP, left);
	return `Show ${count} more ${count === 1 ? "line" : "lines"}`;
}

/**
 * A {@link CodeBlock} that can show the code around its excerpt: "Show 20 more lines" above and below, each gone once
 * that end of the file is on screen. Offered only when `widen` is given and the excerpt says how long its file is, so a
 * companion that cannot read ranges (an older one) shows the plain block. Shared by the quiz, the sparring partner,
 * the bake-off and the architecture map.
 */
export function ExpandableCode({
	reference,
	excerpt,
	highlight,
	compact = false,
	widen,
}: {
	reference: BlueprintRef;
	excerpt: ExportedExcerpt;
	highlight?: (excerpt: ExportedExcerpt) => Promise<string | undefined>;
	/** A window of a few lines, for a screen with no room beside the question; it offers no widening. */
	compact?: boolean;
	widen?: WidenExcerpt;
}): ReactNode {
	// The widened excerpt belongs to the one the caller passed: a new one from the caller (a reload) replaces it.
	const [wider, setWider] = useState<{ of: ExportedExcerpt; value: ExportedExcerpt } | null>(null);
	const [busy, setBusy] = useState<WidenDirection | null>(null);
	const [error, setError] = useState<string | null>(null);
	const frame = useRef<HTMLDivElement>(null);
	const keepFocus = useRef(false);
	const shown = wider !== null && wider.of === excerpt ? wider.value : excerpt;
	const offered = widen !== undefined && !compact;
	const up = offered ? linesLeft(shown, "up") : 0;
	const down = offered ? linesLeft(shown, "down") : 0;

	// A button that was pressed and is gone now (the end of the file is on screen) leaves the focus on the code.
	useEffect(() => {
		if (!keepFocus.current) return;
		keepFocus.current = false;
		if (frame.current !== null && !frame.current.contains(document.activeElement))
			frame.current.querySelector<HTMLElement>(".ar-code")?.focus();
	}, [shown]);

	const more = async (direction: WidenDirection): Promise<void> => {
		if (widen === undefined || busy !== null) return;
		keepFocus.current = frame.current?.contains(document.activeElement) ?? false;
		setBusy(direction);
		setError(null);
		try {
			const next = await widen(widenRequest(reference, shown, direction));
			if (next === null) {
				keepFocus.current = false;
				setError("The code is not available at that commit.");
			} else setWider({ of: excerpt, value: next });
		} catch (err) {
			keepFocus.current = false;
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	};

	const button = (direction: WidenDirection, left: number): ReactNode => (
		<button
			type="button"
			className="ar-btn ar-btn-small ar-btn-wide ar-code-more"
			aria-label={`${moreLabel(left)} ${direction === "up" ? "above" : "below"}`}
			aria-busy={busy === direction}
			onClick={() => void more(direction)}
		>
			{busy === direction ? (
				<LoaderCircle size={13} className="ar-spin" />
			) : direction === "up" ? (
				<ChevronsUp size={13} />
			) : (
				<ChevronsDown size={13} />
			)}
			{moreLabel(left)}
		</button>
	);

	return (
		<div ref={frame} className="ar-expand">
			{up > 0 && button("up", up)}
			<CodeBlock excerpt={shown} highlight={highlight} compact={compact} />
			{down > 0 && button("down", down)}
			{error !== null && (
				<p className="ar-code-more-error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}
