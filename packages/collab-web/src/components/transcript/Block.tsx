import {
	Check,
	ChevronRight,
	Copy,
	Eye,
	EyeOff,
	FileText,
	FoldVertical,
	Reply,
	Send,
	Share2,
	SquareTerminal,
	X,
} from "lucide-react";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { type Block, hasOutput, type ToolMeta } from "../../lib/blocks";
import { fmtDuration } from "../../lib/format";
import type { HiddenSlot } from "../../lib/hidden-messages";
import { normalizeWs } from "../../tool-render/util";
import type { ToolHeadState } from "../../tool-render";
import { HiddenMarker } from "./HiddenMarker";

/** How long a button reads as done before it goes back. */
export const COPIED_MS = 1500;

export type CopyWhat = "command" | "output" | "both";

/** Hiding messages from the chat; only the transcripts of a session offer it. */
export interface BlockHideApi {
	/** Nothing in the block is still running, so it can be hidden. */
	can(id: string): boolean;
	/** The same for the prompt's whole exchange. */
	canExchange(id: string): boolean;
	/** The block is hidden and shown in place for now. */
	isHidden(id: string): boolean;
	hide(id: string): void;
	/** Hide the prompt and everything the agent did up to the next prompt. */
	hideExchange(id: string): void;
	unhide(id: string): void;
}

/** What a block's buttons do; the transcript supplies it over every block it renders. */
export interface BlockApi {
	copy(id: string, what: CopyWhat): Promise<boolean>;
	share(id: string): Promise<"shared" | "copied" | "failed">;
	send(id: string): void;
	/** Open the touch action sheet for the block. */
	openSheet(id: string): void;
	/** Absent where messages cannot be hidden. */
	hide?: BlockHideApi;
}

/** How the transcript shows hidden blocks: runs of them become one marker, or show dimmed once revealed. */
export interface HideView {
	/** Hidden blocks (by id) and where they sit in their run. */
	slots: ReadonlyMap<string, HiddenSlot>;
	/** The hidden block is shown in place (its run was shown, or all hidden messages are). */
	isRevealed(id: string): boolean;
	/** Show the run in place, or fold it back to its marker. */
	toggle(group: string): void;
	/** Unhide every block of the run. */
	unhideGroup(group: string): void;
}

/** A row whose blocks are all hidden: the blocks inside do not show a marker of their own. */
export const HiddenRowContext = createContext(false);

export interface BlocksContextValue {
	/** The blocks the transcript renders, by id; anything else (streaming text, queued prompts) has no actions. */
	blocks: ReadonlyMap<string, Block>;
	selected: ReadonlySet<string>;
	/** Blocks that were just copied: they flash. */
	copied: ReadonlySet<string>;
	/** Phone *Select* mode: every block shows a checkbox. */
	selectMode: boolean;
	canSend: boolean;
	api: BlockApi;
	/** Null where messages cannot be hidden. */
	hide: HideView | null;
}

export const BlocksContext = createContext<BlocksContextValue | null>(null);

/** A key that is "done" for COPIED_MS after `flash(key)`: confirmation on the button that was pressed. */
export function useFlash(): [string | null, (key: string) => void] {
	const [done, setDone] = useState<string | null>(null);
	const timer = useRef<number | undefined>(undefined);
	useEffect(() => () => window.clearTimeout(timer.current), []);
	const flash = (key: string): void => {
		setDone(key);
		window.clearTimeout(timer.current);
		timer.current = window.setTimeout(() => setDone(null), COPIED_MS);
	};
	return [done, flash];
}

function ActionButton({
	label,
	done,
	disabled,
	onClick,
	children,
}: {
	label: string;
	done: boolean;
	disabled?: boolean;
	onClick(): void;
	children: ReactNode;
}): ReactNode {
	return (
		<button
			type="button"
			className="tr-act"
			data-copied={done ? "" : undefined}
			aria-label={label}
			title={label}
			disabled={disabled}
			onClick={onClick}
		>
			{done ? <Check size={13} /> : children}
		</button>
	);
}

/**
 * The quiet buttons of a block, shown while it is hovered, focused or selected: copy (a tool also
 * copies its command or its output alone), send to the message box and share. `extra` adds the
 * prompt's own edit button.
 */
export function BlockActions({
	id,
	extra,
	floating,
}: {
	id: string;
	extra?: ReactNode;
	floating?: boolean;
}): ReactNode {
	const ctx = useContext(BlocksContext);
	const [done, flash] = useFlash();
	const block = ctx?.blocks.get(id);
	if (ctx === null || block === undefined) return extra ? <span className="tr-block-actions">{extra}</span> : null;
	const { api } = ctx;
	const copy = async (what: CopyWhat): Promise<void> => {
		if (await api.copy(id, what)) flash(what);
	};
	const share = async (): Promise<void> => {
		if ((await api.share(id)) === "copied") flash("share");
	};
	const isCall = block.kind === "tool" || block.kind === "run";
	const hide = api.hide;
	return (
		<span className={`tr-block-actions${floating ? " tr-block-actions--float" : ""}`} data-flash={done ?? undefined}>
			{isCall && (
				<ActionButton label="Copy command" done={done === "command"} onClick={() => void copy("command")}>
					<SquareTerminal size={13} />
				</ActionButton>
			)}
			{isCall && (
				<ActionButton
					label="Copy output"
					done={done === "output"}
					disabled={!hasOutput(block)}
					onClick={() => void copy("output")}
				>
					<FileText size={13} />
				</ActionButton>
			)}
			<ActionButton
				label={isCall ? "Copy command and output" : "Copy"}
				done={done === "both"}
				onClick={() => void copy("both")}
			>
				<Copy size={13} />
			</ActionButton>
			{isCall && ctx.canSend && (
				<ActionButton label="Send to agent" done={false} onClick={() => api.send(id)}>
					<Send size={13} />
				</ActionButton>
			)}
			{isCall && (
				<ActionButton label="Share" done={done === "share"} onClick={() => void share()}>
					<Share2 size={13} />
				</ActionButton>
			)}
			{hide !== undefined &&
				(hide.isHidden(id) ? (
					<ActionButton label="Unhide" done={false} onClick={() => hide.unhide(id)}>
						<Eye size={13} />
					</ActionButton>
				) : (
					<ActionButton label="Hide" done={false} disabled={!hide.can(id)} onClick={() => hide.hide(id)}>
						<EyeOff size={13} />
					</ActionButton>
				))}
			{hide !== undefined && block.kind === "prompt" && !hide.isHidden(id) && (
				<ActionButton
					label="Hide this exchange"
					done={false}
					disabled={!hide.canExchange(id)}
					onClick={() => hide.hideExchange(id)}
				>
					<FoldVertical size={13} />
				</ActionButton>
			)}
			{extra}
		</span>
	);
}

/**
 * The frame of one block: a clear edge, a gutter to click for selecting it (a checkbox in *Select* mode)
 * and its actions. A prompt carries its author as a header; a tool block's header comes from its card.
 * Selecting and the touch long-press are handled once, by delegation from the transcript root.
 */
export function BlockShell({
	id,
	kind,
	label,
	title,
	extra,
	children,
}: {
	/** The block's id; null for content not in the session yet, which has a frame but no selection or actions. */
	id: string | null;
	kind: Block["kind"];
	/** Author line of a prompt. */
	label?: ReactNode;
	title?: string;
	/** Further buttons beside the copy button (the prompt's edit). */
	extra?: ReactNode;
	children: ReactNode;
}): ReactNode {
	const ctx = useContext(BlocksContext);
	const inHiddenRow = useContext(HiddenRowContext);
	const known = id !== null && ctx !== null && ctx.blocks.has(id);
	const selected = known && ctx.selected.has(id);
	const slot = id === null ? undefined : ctx?.hide?.slots.get(id);
	const hide = ctx?.hide ?? null;
	const revealed = id !== null && hide !== null && hide.isRevealed(id);
	if (slot !== undefined && !revealed) {
		return slot.start && !inHiddenRow && hide !== null ? (
			<HiddenMarker slot={slot} revealed={false} hide={hide} />
		) : null;
	}
	const marker =
		slot?.start === true && !inHiddenRow && hide !== null ? <HiddenMarker slot={slot} revealed hide={hide} /> : null;
	return (
		<>
			{marker}
			<div
				className={`tr-block tr-block--${kind}`}
				data-block={known ? id : undefined}
				data-hidden={slot !== undefined ? "" : undefined}
				data-kind={kind}
				data-selected={selected ? "" : undefined}
				data-copied={known && ctx.copied.has(id) ? "" : undefined}
				data-select-mode={known && ctx.selectMode ? "" : undefined}
			>
				<div className="tr-block-gutter" data-block-select aria-hidden={!known || undefined}>
					{known && (
						<span className="tr-block-check" role="checkbox" aria-checked={selected} aria-label="Select block">
							{selected && <Check size={11} strokeWidth={3} />}
						</span>
					)}
				</div>
				<div className="tr-block-main">
					{label !== undefined && (
						<div className="tr-block-head tr-block-head--label" data-block-select title={title}>
							<span className="tr-block-author">{label}</span>
							{known && <BlockActions id={id} extra={extra} />}
						</div>
					)}
					{children}
				</div>
				{known && label === undefined && kind !== "tool" && <BlockActions id={id} floating />}
				{known && ctx.canSend && (
					<span className="tr-block-reveal tr-block-reveal--send" aria-hidden>
						<Reply size={16} />
					</span>
				)}
				{known && (
					<span className="tr-block-reveal tr-block-reveal--copy" aria-hidden>
						<Copy size={16} />
					</span>
				)}
			</div>
		</>
	);
}

/** The header of a tool block: expand toggle, status mark, the command or `name summary`, exit code, wall time and actions. */
export function ToolBlockHead({ id, state, meta }: { id: string; state: ToolHeadState; meta: ToolMeta }): ReactNode {
	const failed = meta.failed || state.status === "err";
	return (
		<div className="tr-block-head tr-block-head--tool" data-block-select>
			<button
				type="button"
				className="tr-block-toggle"
				aria-expanded={state.open}
				aria-label={state.open ? "Collapse" : "Expand"}
				onClick={state.toggle}
			>
				<ChevronRight size={13} className={`tr-chev${state.open ? " tr-chev--open" : ""}`} />
			</button>
			{state.status === "run" ? (
				<span className="tv-spin" role="img" aria-label="Running" />
			) : state.status === "pending" ? (
				<span className="tr-mark tr-mark--pending" role="img" aria-label="No result yet" />
			) : failed ? (
				<X size={13} className="tr-mark tr-mark--err" role="img" aria-label="Failed" />
			) : (
				<Check size={13} className="tr-mark tr-mark--ok" role="img" aria-label="Succeeded" />
			)}
			<span className="tr-block-label" title={meta.command ?? state.intent}>
				{meta.command !== null ? (
					<>
						<span className="tr-block-prompt">$</span>
						<span className="tr-block-cmd">{normalizeWs(meta.command) || "…"}</span>
					</>
				) : (
					<>
						<span className="tr-block-name">{state.name}</span>
						<span className="tr-block-sum">{state.summary}</span>
					</>
				)}
			</span>
			{failed && meta.exitCode !== null && <span className="tr-block-exit">exit {meta.exitCode}</span>}
			{meta.durationMs !== null && <span className="tr-block-time">{fmtDuration(meta.durationMs)}</span>}
			<BlockActions id={id} />
		</div>
	);
}
