import type { ReactNode } from "react";
import { useEffect } from "react";
import { createPortal } from "react-dom";

export interface SheetProps {
	/** Accessible dialog name. */
	label: string;
	/** Wider dropdown on desktop, for content such as diffs. */
	wide?: boolean;
	onClose(): void;
	children: ReactNode;
}

/**
 * Overlay panel: a bottom sheet on phones, a dropdown card under the header
 * elsewhere. Escape and the backdrop close it.
 */
export function Sheet({ label, wide, onClose, children }: SheetProps): ReactNode {
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	// Portaled: the glass header's backdrop-filter would otherwise become the
	// containing block for this fixed-position sheet.
	return createPortal(
		<>
			<div className="sh-sheet-backdrop" onClick={onClose} />
			<div className={wide ? "sh-sheet sh-sheet-wide" : "sh-sheet"} role="dialog" aria-label={label}>
				<div className="sh-sheet-grip" aria-hidden />
				{children}
			</div>
		</>,
		document.body,
	);
}
