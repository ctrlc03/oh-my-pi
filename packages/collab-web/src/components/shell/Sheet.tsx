import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export interface SheetProps {
	/** Accessible dialog name. */
	label: string;
	/** `wide`: wider dropdown on desktop, for content such as diffs. `full`: near-full-screen canvas with a definite height. `palette`: centered near the top on desktop, for the command palette. `settings`: a centered two-column panel on desktop, full screen on phones. */
	size?: "wide" | "full" | "palette" | "settings";
	/** The control that opened it: on desktop the sheet opens upward from it instead of under the header. */
	anchor?: DOMRect;
	onClose(): void;
	children: ReactNode;
}

/** Width of an anchored sheet (`.sh-sheet-anchored`); keeps it inside the viewport. */
const ANCHORED_WIDTH = 320;

function anchorStyle(rect: DOMRect): CSSProperties {
	const left = Math.max(12, Math.min(rect.left, window.innerWidth - ANCHORED_WIDTH - 12));
	return {
		"--anchor-left": `${left}px`,
		"--anchor-bottom": `${window.innerHeight - rect.top + 8}px`,
	} as CSSProperties;
}

/**
 * Overlay panel: a bottom sheet on phones, a dropdown card under the header
 * elsewhere (or above its `anchor`). Escape and the backdrop close it; with sheets
 * stacked (a file opened from the changes list), Escape closes only the top one.
 */
export function Sheet({ label, size, anchor, onClose, children }: SheetProps): ReactNode {
	const panel = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			// Escape an inner widget already handled (the editor closing its search panel) leaves the sheet open.
			if (e.key !== "Escape" || e.defaultPrevented) return;
			const sheets = document.querySelectorAll(".sh-sheet");
			if (sheets[sheets.length - 1] === panel.current) onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);
	const className = ["sh-sheet", size && `sh-sheet-${size}`, anchor && "sh-sheet-anchored"].filter(Boolean).join(" ");
	// Portaled: the glass header's backdrop-filter would otherwise become the
	// containing block for this fixed-position sheet.
	return createPortal(
		<>
			<div className="sh-sheet-backdrop" onClick={onClose} />
			<div ref={panel} className={className} style={anchor && anchorStyle(anchor)} role="dialog" aria-label={label}>
				<div className="sh-sheet-grip" aria-hidden />
				{children}
			</div>
		</>,
		document.body,
	);
}
