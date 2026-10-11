import { Check, CheckSquare, Copy, FileDiff, FileText, Pencil, Send, Share2, SquareTerminal } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { type Block, blockTitle, hasOutput } from "../../lib/blocks";
import { Sheet } from "../shell/Sheet";
import { type BlockApi, type CopyWhat, useFlash } from "./Block";

/** How long a copy stays on screen as "done" before the sheet closes behind it. */
const CLOSE_AFTER_COPY_MS = 700;

function SheetRow({
	icon,
	label,
	done,
	disabled,
	onClick,
}: {
	icon: ReactNode;
	label: string;
	done?: boolean;
	disabled?: boolean;
	onClick(): void;
}): ReactNode {
	return (
		<button type="button" className="tr-sheet-row" disabled={disabled} onClick={onClick}>
			{done ? <Check size={16} /> : icon}
			{done ? "Copied" : label}
		</button>
	);
}

/**
 * A block's actions on a touch screen, opened by a long press: the copies, send to the message box,
 * share, edit (a prompt), and *Select*, which starts the phone's multi-select mode on this block.
 */
export function BlockSheet({
	block,
	api,
	canSend,
	onEdit,
	onChanges,
	onSelect,
	onClose,
}: {
	block: Block;
	api: BlockApi;
	canSend: boolean;
	onEdit?: (entryId: string) => void;
	onChanges?: (entryId: string) => void;
	onSelect(): void;
	onClose(): void;
}): ReactNode {
	const [done, flash] = useFlash();
	const closeTimer = useRef<number | undefined>(undefined);
	useEffect(() => () => window.clearTimeout(closeTimer.current), []);
	const isCall = block.kind === "tool" || block.kind === "run";
	const copy = async (what: CopyWhat): Promise<void> => {
		if (!(await api.copy(block.id, what))) return;
		flash(what);
		closeTimer.current = window.setTimeout(onClose, CLOSE_AFTER_COPY_MS);
	};
	const act = (run: () => void): void => {
		onClose();
		run();
	};
	return (
		<Sheet label="Block actions" onClose={onClose}>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title tr-sheet-title">{blockTitle(block)}</div>
			</div>
			<div className="tr-sheet-list">
				{isCall && (
					<SheetRow
						icon={<SquareTerminal size={16} />}
						label="Copy command"
						done={done === "command"}
						onClick={() => void copy("command")}
					/>
				)}
				{isCall && (
					<SheetRow
						icon={<FileText size={16} />}
						label="Copy output"
						done={done === "output"}
						disabled={!hasOutput(block)}
						onClick={() => void copy("output")}
					/>
				)}
				<SheetRow
					icon={<Copy size={16} />}
					label={isCall ? "Copy command and output" : "Copy"}
					done={done === "both"}
					onClick={() => void copy("both")}
				/>
				{canSend && (
					<SheetRow
						icon={<Send size={16} />}
						label="Send to agent"
						onClick={() => act(() => api.send(block.id))}
					/>
				)}
				<SheetRow
					icon={<Share2 size={16} />}
					label="Share"
					onClick={() =>
						act(() => {
							void api.share(block.id);
						})
					}
				/>
				{block.kind === "prompt" && block.editable && onEdit !== undefined && (
					<SheetRow
						icon={<Pencil size={16} />}
						label="Edit and resend"
						onClick={() => act(() => onEdit(block.entryId))}
					/>
				)}
				{block.kind === "prompt" && block.editable && onChanges !== undefined && (
					<SheetRow
						icon={<FileDiff size={16} />}
						label="Changes in this turn"
						onClick={() => act(() => onChanges(block.entryId))}
					/>
				)}
				<SheetRow icon={<CheckSquare size={16} />} label="Select" onClick={() => act(onSelect)} />
			</div>
		</Sheet>
	);
}
