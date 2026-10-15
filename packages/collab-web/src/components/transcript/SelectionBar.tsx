import { Check, Copy, Eye, EyeOff, Send, X } from "lucide-react";
import type { ReactNode } from "react";
import { useFlash } from "./Block";

/** The bottom bar over a block selection: how many are picked, and what to do with them. */
export function SelectionBar({
	count,
	canSend,
	hide,
	onCopy,
	onSend,
	onCancel,
}: {
	count: number;
	canSend: boolean;
	/**
	 * Hiding the picked messages: `hideCount` of them can be hidden now, `unhideCount` are hidden and shown in place.
	 * Absent where messages cannot be hidden.
	 */
	hide?: { hideCount: number; unhideCount: number; onHide(): void; onUnhide(): void };
	onCopy(): Promise<boolean>;
	onSend(): void;
	onCancel(): void;
}): ReactNode {
	const [done, flash] = useFlash();
	return (
		<div className="tr-selbar" role="toolbar" aria-label="Selected blocks">
			<span className="tr-selbar-count">{count === 0 ? "Pick blocks" : `${count} selected`}</span>
			<button
				type="button"
				className="tr-selbar-btn"
				disabled={count === 0}
				onClick={() => {
					void onCopy().then(ok => ok && flash("copy"));
				}}
			>
				{done === "copy" ? <Check size={15} /> : <Copy size={15} />}
				{done === "copy" ? "Copied" : "Copy"}
			</button>
			{canSend && (
				<button type="button" className="tr-selbar-btn" disabled={count === 0} onClick={onSend}>
					<Send size={15} />
					Send to agent
				</button>
			)}
			{hide !== undefined && hide.hideCount > 0 && (
				<button type="button" className="tr-selbar-btn" onClick={hide.onHide}>
					<EyeOff size={15} />
					{`Hide ${hide.hideCount} message${hide.hideCount === 1 ? "" : "s"}`}
				</button>
			)}
			{hide !== undefined && hide.unhideCount > 0 && (
				<button type="button" className="tr-selbar-btn" onClick={hide.onUnhide}>
					<Eye size={15} />
					{`Unhide ${hide.unhideCount} message${hide.unhideCount === 1 ? "" : "s"}`}
				</button>
			)}
			<button type="button" className="tr-selbar-btn" onClick={onCancel}>
				<X size={15} />
				Cancel
			</button>
		</div>
	);
}
