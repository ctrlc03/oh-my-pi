import { Check, Copy, Send, X } from "lucide-react";
import type { ReactNode } from "react";
import { useFlash } from "./Block";

/** The bottom bar over a block selection: how many are picked, and what to do with them. */
export function SelectionBar({
	count,
	canSend,
	onCopy,
	onSend,
	onCancel,
}: {
	count: number;
	canSend: boolean;
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
			<button type="button" className="tr-selbar-btn" onClick={onCancel}>
				<X size={15} />
				Cancel
			</button>
		</div>
	);
}
