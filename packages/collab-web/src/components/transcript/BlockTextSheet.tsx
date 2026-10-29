import { Check, Copy, X } from "lucide-react";
import type { ReactNode } from "react";
import type { Block } from "../../lib/blocks";
import { haptic } from "../../lib/gestures";
import { Sheet } from "../shell/Sheet";
import { type BlockApi, useFlash } from "./Block";
import { Markdown } from "./Markdown";

/** What the sheet calls a block: a prompt its author, a reply "Reply", a tool call its name. */
function blockLabel(block: Block): string {
	switch (block.kind) {
		case "prompt":
			return block.author;
		case "reply":
			return "Reply";
		case "tool":
			return block.name;
		case "run":
			return `${block.tools.length} tool call${block.tools.length === 1 ? "" : "s"}`;
	}
}

/**
 * A block's whole text in a near-full-screen reader, in a column a comfortable width to read; opened by
 * *Read in full* (the block's hover button, or the touch long-press sheet). `text` is what *Copy* copies,
 * Markdown for every kind of block (a tool call is its fenced command and output), rendered as the
 * transcript renders Markdown. The OS's own selection works here, which the transcript's long press
 * otherwise pre-empts on touch screens.
 *
 * `data-native-select` keeps the transcript's gestures and the tooltip layer's press-and-hold out of it.
 */
export function BlockTextSheet({
	block,
	text,
	api,
	onClose,
}: {
	block: Block;
	text: string;
	api: BlockApi;
	onClose(): void;
}): ReactNode {
	const [done, flash] = useFlash();
	const copyAll = async (): Promise<void> => {
		if (!(await api.copy(block.id, "both"))) return;
		haptic();
		flash("all");
	};
	return (
		<Sheet label="Read in full" size="full" onClose={onClose}>
			<div className="tr-textsheet" data-native-select>
				<div className="sh-sheet-head">
					<div className="sh-sheet-title">{blockLabel(block)}</div>
					<span className="sh-sheet-head-actions">
						<button type="button" className="sh-btn" onClick={() => void copyAll()}>
							{done === "all" ? <Check size={15} /> : <Copy size={15} />}
							{done === "all" ? "Copied" : "Copy all"}
						</button>
						<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="Close">
							<X size={16} />
						</button>
					</span>
				</div>
				<div className="tr-textsheet-body">
					<div className="tr-textsheet-col">
						<Markdown text={text} />
					</div>
				</div>
			</div>
		</Sheet>
	);
}
