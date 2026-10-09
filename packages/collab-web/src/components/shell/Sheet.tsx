import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export interface SheetProps {
	/** Accessible dialog name. */
	label: string;
	/** `wide`: wider dropdown on desktop, for content such as diffs. `full`: near-full-screen canvas with a definite height. */
	size?: "wide" | "full";
	onClose(): void;
	children: ReactNode;
}

/**
 * Overlay panel: a bottom sheet on phones, a dropdown card under the header
 * elsewhere. Escape and the backdrop close it; with sheets stacked (a file opened
 * from the changes list), Escape closes only the top one.
 */
export function Sheet({ label, size, onClose, children }: SheetProps): ReactNode {
	const panel = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key !== "Escape") return;
			const sheets = document.querySelectorAll(".sh-sheet");
			if (sheets[sheets.length - 1] === panel.current) onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);
	// Portaled: the glass header's backdrop-filter would otherwise become the
	// containing block for this fixed-position sheet.
	return createPortal(
		<>
			<div className="sh-sheet-backdrop" onClick={onClose} />
			<div ref={panel} className={size ? `sh-sheet sh-sheet-${size}` : "sh-sheet"} role="dialog" aria-label={label}>
				<div className="sh-sheet-grip" aria-hidden />
				{children}
			</div>
		</>,
		document.body,
	);
}
