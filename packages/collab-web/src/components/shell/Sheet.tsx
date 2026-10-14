import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { EDGES } from "../../lib/sheet-frame";
import { useSheetFrame } from "../../lib/use-sheet-frame";
import { layoutRect, layoutViewport } from "../../lib/zoom";
import { useMedia, WIDE_QUERY } from "../codemap/shared";
import "./sheet-frame.css";

export interface SheetProps {
	/** Accessible dialog name. */
	label: string;
	/** `wide`: wider dropdown on desktop, for content such as diffs. `full`: near-full-screen canvas with a definite height. `palette`: centered near the top on desktop, for the command palette. `settings`: a centered two-column panel on desktop, full screen on phones. */
	size?: "wide" | "full" | "palette" | "settings";
	/** The control that opened it: on desktop the sheet opens upward from it instead of under the header. */
	anchor?: DOMRect;
	/** Names the sheet's saved place and size (default `label`); only where one label stands for pages that should not share a frame. */
	frameKey?: string;
	onClose(): void;
	children: ReactNode;
}

/** Width of an anchored sheet (`.sh-sheet-anchored`); keeps it inside the viewport. */
const ANCHORED_WIDTH = 320;

/**
 * Where the big sheets float and can be moved and resized: a mouse or trackpad as the main pointer, and the wide
 * layout (the one where the sessions sidebar and the agents rail dock, so there is room to move a 420px sheet about).
 * Phones, tablets and touch screens keep the sheets as they were.
 */
const FRAMED_QUERY = `(pointer: fine) and ${WIDE_QUERY}`;

function anchorStyle(rect: DOMRect): CSSProperties {
	const at = layoutRect(rect);
	const room = layoutViewport();
	const left = Math.max(12, Math.min(at.left, room.width - ANCHORED_WIDTH - 12));
	return {
		"--anchor-left": `${left}px`,
		"--anchor-bottom": `${room.height - at.top + 8}px`,
	} as CSSProperties;
}

/**
 * Overlay panel: a bottom sheet on phones, a dropdown card under the header
 * elsewhere (or above its `anchor`). Escape and the backdrop close it; with sheets
 * stacked (a file opened from the changes list), Escape closes only the top one.
 * The big ones (`full`, `wide`, `settings`) can be moved and resized with a mouse; see `use-sheet-frame.ts`.
 */
export function Sheet({ label, size, anchor, frameKey, onClose, children }: SheetProps): ReactNode {
	const panel = useRef<HTMLDivElement>(null);
	const big = size === "full" || size === "wide" || size === "settings";
	const framed = useMedia(FRAMED_QUERY) && big && anchor === undefined;
	const frame = useSheetFrame(frameKey ?? label, framed, panel);
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			// Escape an inner widget already handled (the editor closing its search panel) leaves the sheet open.
			if (e.key !== "Escape" || e.defaultPrevented) return;
			const sheets = document.querySelectorAll(".sh-sheet");
			if (sheets[sheets.length - 1] !== panel.current) return;
			// Claimed: the sheet below, whose listener may run after this one's close has rendered, must not close too.
			e.preventDefault();
			onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);
	const className = [
		"sh-sheet",
		size && `sh-sheet-${size}`,
		anchor && "sh-sheet-anchored",
		framed && "sh-sheet-movable",
	]
		.filter(Boolean)
		.join(" ");
	// Portaled: the glass header's backdrop-filter would otherwise become the
	// containing block for this fixed-position sheet.
	return createPortal(
		<>
			<div className="sh-sheet-backdrop" onClick={onClose} />
			<div
				ref={panel}
				className={className}
				style={framed ? frame.style : anchor && anchorStyle(anchor)}
				role="dialog"
				aria-label={label}
				onPointerDown={framed ? frame.onPanelPointerDown : undefined}
			>
				<div className="sh-sheet-grip" aria-hidden />
				{children}
			</div>
			{framed && (
				// Over the panel but not in it: the panel scrolls and clips, and the handles reach past its edge.
				<div ref={frame.layer} className="sh-sheet-frame">
					{EDGES.map(edge => (
						<div
							key={edge}
							className="sh-sheet-edge"
							data-edge={edge}
							aria-hidden
							onPointerDown={event => frame.grab(event, edge)}
						/>
					))}
					<button
						type="button"
						className="sh-sheet-move"
						aria-label="Move or resize the window"
						onPointerDown={event => frame.grab(event, "move")}
						onKeyDown={frame.onHandleKeyDown}
					/>
				</div>
			)}
		</>,
		document.body,
	);
}
