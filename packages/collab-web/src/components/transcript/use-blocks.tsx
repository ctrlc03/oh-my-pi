import type { MouseEvent, PointerEvent, ReactNode, RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
	type Block,
	type BlockSelection,
	blockCommand,
	blockOutput,
	blocksMarkdown,
	blocksQuote,
	blockTitle,
	extendTo,
	moveSelection,
	NO_SELECTION,
	pruneSelection,
	selectedBlocks,
	selectOnly,
	type ToolBlock,
	toggleBlock,
} from "../../lib/blocks";
import type { ActiveTool } from "../../lib/client";
import { messageText } from "../../lib/format";
import {
	type Axis,
	classifyAxis,
	edgeZone,
	haptic,
	isDoubleTap,
	resolveBlockSwipe,
	swipeProgress,
	type Tap,
} from "../../lib/gestures";
import { copyText, shareText } from "../../lib/share";
import { IS_MAC, shortcutFires } from "../../lib/shortcuts";
import { focusedPane } from "../../lib/use-split";
import { type BlockApi, type BlocksContextValue, COPIED_MS } from "./Block";
import { BlockSheet } from "./BlockSheet";
import { SelectionBar } from "./SelectionBar";

/** Held this long without moving, a touch opens the block's actions. */
export const LONG_PRESS_MS = 450;
/** The long press already owns the gesture: a context menu that follows it is swallowed for this long. */
const MENU_GRACE_MS = 1500;
/** How long after the finger lifts a stray click is still the long press's. */
const RELEASE_CLICK_MS = 350;
/** A swipe also swallows the click the browser may still send; for this long. */
const CLICK_GRACE_MS = 400;
/** The block follows the finger at most this share of its width. */
const MAX_PULL_RATIO = 0.45;
/** How long a released block takes to settle back (matches the CSS transition). */
const SNAP_MS = 200;

/** Elements a click or press on is theirs, not the block's. */
const INTERACTIVE = "button, a, input, textarea, select, summary, [role='button']";

const NO_HOVER_QUERY = "(hover: none)";

function subscribeNoHover(onChange: () => void): () => void {
	const list = matchMedia(NO_HOVER_QUERY);
	list.addEventListener("change", onChange);
	return () => list.removeEventListener("change", onChange);
}

/** No hover: a phone or tablet, where the actions live in the long-press sheet. */
function useNoHover(): boolean {
	return useSyncExternalStore(
		subscribeNoHover,
		() => matchMedia(NO_HOVER_QUERY).matches,
		() => false,
	);
}

/** Text the reader has selected in the page: then ⌘C copies that, not the blocks. */
function hasTextSelection(): boolean {
	const selection = window.getSelection();
	return selection !== null && !selection.isCollapsed && selection.toString() !== "";
}

/** After a long press opened the sheet: the click that follows the finger lifting is dropped, so it cannot land on the backdrop. */
function swallowReleaseClick(): void {
	const stop = (e: Event): void => {
		e.stopPropagation();
		e.preventDefault();
	};
	const done = (): void => {
		window.removeEventListener("click", stop, true);
		window.removeEventListener("pointerup", lifted, true);
		window.removeEventListener("pointercancel", lifted, true);
	};
	const lifted = (): void => void window.setTimeout(done, RELEASE_CLICK_MS);
	window.addEventListener("click", stop, true);
	window.addEventListener("pointerup", lifted, true);
	window.addEventListener("pointercancel", lifted, true);
}

/** A horizontally scrolling element between `target` and `block` (a wide table): its own drag, not a swipe. */
function inHorizontalScroller(target: Element, block: Element): boolean {
	for (let element: Element | null = target; element !== null && element !== block; element = element.parentElement) {
		if (element.scrollWidth <= element.clientWidth + 1) continue;
		const overflow = getComputedStyle(element).overflowX;
		if (overflow === "auto" || overflow === "scroll") return true;
	}
	return false;
}

/** A block as it copies now: a running call includes the output streamed so far. */
function liveBlock(block: Block, active: ReadonlyMap<string, ActiveTool>): Block {
	const overlay = (tool: ToolBlock): ToolBlock => {
		const running = active.get(tool.id);
		if (tool.result !== undefined || running === undefined) return tool;
		const partial = running.partialResult;
		return { ...tool, running: true, partial: typeof partial === "string" ? partial : messageText(partial) };
	};
	if (block.kind === "tool") return overlay(block);
	return block.kind === "run" ? { ...block, tools: block.tools.map(overlay) } : block;
}

/** The first block whose bottom edge is below the top of the transcript's view: where ⌘↓ starts without a selection. */
function firstBlockInView(root: HTMLElement): string | undefined {
	const top = root.getBoundingClientRect().top;
	for (const element of root.querySelectorAll("[data-block]")) {
		if (element.getBoundingClientRect().bottom > top + 4) return element.getAttribute("data-block") ?? undefined;
	}
	return undefined;
}

/** A touch on a block: tracked for the long press, a swipe, and a double tap. */
interface Touch {
	id: string;
	element: HTMLElement;
	x: number;
	y: number;
	t: number;
	width: number;
	axis: Axis;
	dx: number;
	/** The swipe passed its commit distance (so the haptic fires once). */
	armed: boolean;
	/** Nothing but a tap can come of this touch (it started on a control, an edge or a text selection). */
	tapOnly: boolean;
}

export interface UseBlocksArgs {
	/** The blocks the transcript renders, in order. */
	blocks: readonly Block[];
	rootRef: RefObject<HTMLDivElement | null>;
	/** Running tools: a block's copy includes the output so far. */
	active: ReadonlyMap<string, ActiveTool>;
	/** The agent drawer's transcript: no keyboard navigation (the main transcript owns it). */
	compact: boolean;
	onSendToAgent?: (text: string) => void;
	onEdit?: (entryId: string) => void;
}

export interface UseBlocks {
	context: BlocksContextValue;
	/** Handlers for the transcript root: selecting by click, the touch long press, swipes and the double tap. */
	rootProps: {
		onClick(e: MouseEvent<HTMLDivElement>): void;
		onPointerDown(e: PointerEvent<HTMLDivElement>): void;
		onPointerMove(e: PointerEvent<HTMLDivElement>): void;
		onPointerUp(e: PointerEvent<HTMLDivElement>): void;
		onPointerCancel(): void;
		onContextMenu(e: MouseEvent<HTMLDivElement>): void;
	};
	/** Call when the root scrolls: a scroll is not a press. */
	cancelPress(): void;
	/** Copy a block (as ⌘C would) and flash it as copied. */
	copyBlock(id: string): void;
	/** The touch sheet and the selection bar. */
	overlay: ReactNode;
}

/**
 * Selection and actions for the transcript's blocks: click and keyboard selection, ranges, ⌘C,
 * Esc, the touch long press with its sheet, swipes (right quotes, left copies), the double-tap
 * copy, and the phone's *Select* mode with its bottom bar.
 */
export function useBlocks({ blocks, rootRef, active, compact, onSendToAgent, onEdit }: UseBlocksArgs): UseBlocks {
	const [selection, setSelection] = useState<BlockSelection>(NO_SELECTION);
	const [selectMode, setSelectMode] = useState(false);
	const [sheetId, setSheetId] = useState<string | null>(null);
	const [copied, setCopied] = useState<ReadonlySet<string>>(new Set());
	const noHover = useNoHover();

	const byId = useMemo(() => new Map(blocks.map(block => [block.id, block])), [blocks]);
	const latest = useRef({ blocks, byId, active, selection, selectMode, onSendToAgent });
	latest.current = { blocks, byId, active, selection, selectMode, onSendToAgent };

	// Blocks that leave the transcript (the view switched, the window trimmed) leave the selection.
	useEffect(() => {
		setSelection(current => pruneSelection(current, blocks));
		setSheetId(current => (current !== null && !blocks.some(block => block.id === current) ? null : current));
	}, [blocks]);

	const copiedTimer = useRef<number | undefined>(undefined);
	useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
	/** Blocks read as copied (a green edge) for a moment. */
	const markCopied = useCallback((ids: readonly string[]): void => {
		setCopied(new Set(ids));
		window.clearTimeout(copiedTimer.current);
		copiedTimer.current = window.setTimeout(() => setCopied(new Set()), COPIED_MS);
	}, []);

	const api = useMemo<BlockApi>(() => {
		const get = (id: string): Block | undefined => {
			const block = latest.current.byId.get(id);
			return block === undefined ? undefined : liveBlock(block, latest.current.active);
		};
		return {
			async copy(id, what) {
				const block = get(id);
				if (block === undefined) return false;
				const text =
					what === "command"
						? blockCommand(block)
						: what === "output"
							? blockOutput(block)
							: blocksMarkdown([block]);
				return copyText(text);
			},
			async share(id) {
				const block = get(id);
				return block === undefined ? "failed" : shareText(blockTitle(block), blocksMarkdown([block]));
			},
			send(id) {
				const block = get(id);
				if (block !== undefined) latest.current.onSendToAgent?.(blocksQuote([block]));
			},
			openSheet: setSheetId,
		};
	}, []);

	const copyBlock = useCallback(
		(id: string): void => {
			void api.copy(id, "both").then(ok => ok && markCopied([id]));
		},
		[api, markCopied],
	);

	const clear = useCallback((): void => {
		setSelection(NO_SELECTION);
		setSelectMode(false);
	}, []);

	// Selected blocks as they copy now, in transcript order.
	const chosen = useCallback((): Block[] => {
		const { blocks: order, selection: current, active: running } = latest.current;
		return selectedBlocks(current, order).map(block => liveBlock(block, running));
	}, []);

	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.isComposing || document.querySelector('[role="dialog"]') !== null) return;
			const { selection: current, selectMode: picking, blocks: order } = latest.current;
			if (shortcutFires("escape", e, e.target, IS_MAC)) {
				// Esc backs out of a selection before it stops the turn or closes anything else.
				if (current.ids.size === 0 && !picking) return;
				e.preventDefault();
				e.stopPropagation();
				clear();
				return;
			}
			if (shortcutFires("blockCopy", e, e.target, IS_MAC)) {
				if (current.ids.size === 0 || hasTextSelection()) return;
				e.preventDefault();
				void copyText(blocksMarkdown(chosen())).then(ok => ok && markCopied([...current.ids]));
				return;
			}
			const move = (
				[
					["blockPrev", -1, false],
					["blockNext", 1, false],
					["blockExtendPrev", -1, true],
					["blockExtendNext", 1, true],
				] as const
			).find(([id]) => shortcutFires(id, e, e.target, IS_MAC));
			const root = rootRef.current;
			if (move === undefined || root === null || compact) return;
			// Shortcuts act on the pane the reader last touched.
			if ((root.closest("[data-pane]")?.getAttribute("data-pane") ?? "main") !== focusedPane()) return;
			e.preventDefault();
			const next = moveSelection(current, order, move[1], move[2], firstBlockInView(root));
			setSelection(next);
			if (next.focus !== null) {
				root.querySelector(`[data-block="${CSS.escape(next.focus)}"]`)?.scrollIntoView({ block: "nearest" });
			}
		};
		// Capture: a selection takes Esc before the composer or the page's own handlers see it.
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [chosen, clear, compact, markCopied, rootRef]);

	// ---- touch: long press, swipe, double tap ----
	const touch = useRef<Touch | null>(null);
	const press = useRef<number | undefined>(undefined);
	const lastTap = useRef<(Tap & { id: string }) | null>(null);
	const menuAt = useRef(0);
	const swipedAt = useRef(0);
	const snapTimer = useRef<number | undefined>(undefined);

	const cancelPress = useCallback((): void => {
		window.clearTimeout(press.current);
		press.current = undefined;
	}, []);
	useEffect(() => cancelPress, [cancelPress]);
	useEffect(() => () => window.clearTimeout(snapTimer.current), []);

	/** Release the block: let it settle back, then drop the swipe styling. */
	const settle = (element: HTMLElement): void => {
		element.dataset.swipe = "snap";
		element.style.setProperty("--swipe-x", "0px");
		element.removeAttribute("data-swipe-armed");
		window.clearTimeout(snapTimer.current);
		snapTimer.current = window.setTimeout(() => {
			element.removeAttribute("data-swipe");
			element.style.removeProperty("--swipe-x");
			element.style.removeProperty("--swipe-progress");
		}, SNAP_MS);
	};

	const endTouch = (): void => {
		cancelPress();
		const held = touch.current;
		touch.current = null;
		if (held !== null && held.axis === "horizontal" && !held.tapOnly) settle(held.element);
	};

	const rootProps: UseBlocks["rootProps"] = {
		onClick(e) {
			if (Date.now() - swipedAt.current < CLICK_GRACE_MS) return;
			const target = e.target;
			if (!(target instanceof Element)) return;
			const element = target.closest("[data-block]");
			if (element === null || target.closest(INTERACTIVE) !== null) return;
			const id = element.getAttribute("data-block");
			const { selectMode: picking } = latest.current;
			// Only the gutter and header select; *Select* mode makes the whole block a target.
			if (id === null || (target.closest("[data-block-select]") === null && !picking)) return;
			if (hasTextSelection()) return;
			const { blocks: order } = latest.current;
			setSelection(current => {
				if (e.shiftKey) return extendTo(current, order, id);
				if (e.metaKey || e.ctrlKey || picking) return toggleBlock(current, id);
				return current.ids.size === 1 && current.ids.has(id) ? NO_SELECTION : selectOnly(id);
			});
			if (e.shiftKey) window.getSelection()?.removeAllRanges();
		},
		onPointerDown(e) {
			cancelPress();
			if (e.pointerType === "mouse" || !e.isPrimary) return;
			const target = e.target;
			if (!(target instanceof Element)) return;
			const element = target.closest<HTMLElement>("[data-block]");
			const id = element?.getAttribute("data-block");
			if (element === null || id === null || id === undefined) return;
			const picking = latest.current.selectMode;
			const onControl = target.closest(INTERACTIVE) !== null;
			touch.current = {
				id,
				element,
				x: e.clientX,
				y: e.clientY,
				t: e.timeStamp,
				width: element.getBoundingClientRect().width,
				axis: "pending",
				dx: 0,
				armed: false,
				// Edge swipes belong to the drawers; a wide table's own drag, and *Select* mode's taps, are not swipes.
				tapOnly:
					onControl ||
					picking ||
					edgeZone(e.clientX, window.innerWidth) !== null ||
					inHorizontalScroller(target, element),
			};
			if (onControl || picking) return;
			// Text that was already selected is being adjusted with its handles; a press then is not a request for actions.
			const hadSelection = hasTextSelection();
			press.current = window.setTimeout(() => {
				press.current = undefined;
				if (hadSelection) return;
				touch.current = null;
				menuAt.current = Date.now();
				// The browser may still send the click for the release that follows; the sheet's backdrop must not take it as a dismissal.
				swallowReleaseClick();
				window.getSelection()?.removeAllRanges();
				setSheetId(id);
			}, LONG_PRESS_MS);
		},
		onPointerMove(e) {
			const held = touch.current;
			if (held === null) return;
			const dx = e.clientX - held.x;
			const dy = e.clientY - held.y;
			if (held.axis === "pending") {
				const axis = classifyAxis(dx, dy);
				if (axis === "pending") return;
				held.axis = axis;
				cancelPress();
				// A vertical drag is a scroll; a drag over selected text moves the selection handles.
				if (axis === "vertical" || held.tapOnly || hasTextSelection()) {
					held.tapOnly = true;
					return;
				}
			}
			if (held.axis !== "horizontal" || held.tapOnly) return;
			// Swiping right quotes into the message box, which needs one to send to.
			if (dx > 0 && latest.current.onSendToAgent === undefined) return;
			const pull = Math.max(-held.width * MAX_PULL_RATIO, Math.min(held.width * MAX_PULL_RATIO, dx));
			const progress = swipeProgress(dx, held.width);
			window.clearTimeout(snapTimer.current);
			held.dx = dx;
			held.element.dataset.swipe = dx > 0 ? "send" : "copy";
			held.element.style.setProperty("--swipe-x", `${pull}px`);
			held.element.style.setProperty("--swipe-progress", String(progress));
			const armed = progress >= 1;
			if (armed !== held.armed) {
				held.armed = armed;
				if (armed) haptic(8);
			}
			if (armed) held.element.setAttribute("data-swipe-armed", "");
			else held.element.removeAttribute("data-swipe-armed");
		},
		onPointerUp(e) {
			const held = touch.current;
			endTouch();
			if (held === null) return;
			if (held.axis === "horizontal" && !held.tapOnly) {
				swipedAt.current = Date.now();
				const action = resolveBlockSwipe(held.dx, e.timeStamp - held.t, held.width);
				if (action === "send") {
					haptic();
					api.send(held.id);
				} else if (action === "copy") {
					haptic();
					copyBlock(held.id);
				}
				return;
			}
			// A tap that stayed put; the second of two on one block copies it. Single taps are never held back.
			if (held.axis !== "pending" || held.tapOnly || latest.current.selectMode) {
				lastTap.current = null;
				return;
			}
			const tap = { t: e.timeStamp, x: e.clientX, y: e.clientY, id: held.id };
			if (lastTap.current?.id === held.id && isDoubleTap(lastTap.current, tap)) {
				lastTap.current = null;
				window.getSelection()?.removeAllRanges();
				haptic();
				copyBlock(held.id);
			} else {
				lastTap.current = tap;
			}
		},
		onPointerCancel: endTouch,
		onContextMenu(e) {
			// The long press that opened the sheet must not also open the browser's own menu.
			if (Date.now() - menuAt.current < MENU_GRACE_MS) e.preventDefault();
		},
	};

	const context = useMemo<BlocksContextValue>(
		() => ({
			blocks: byId,
			selected: selection.ids,
			copied,
			selectMode,
			canSend: onSendToAgent !== undefined,
			api,
		}),
		[byId, selection.ids, copied, selectMode, onSendToAgent, api],
	);

	const sheetBlock = sheetId === null ? undefined : byId.get(sheetId);
	const chosenCount = selection.ids.size;
	const showBar = selectMode || (chosenCount > 0 && (noHover || chosenCount > 1));
	const overlay = (
		<>
			{sheetBlock !== undefined && (
				<BlockSheet
					block={sheetBlock}
					api={api}
					canSend={onSendToAgent !== undefined}
					onEdit={onEdit}
					onSelect={() => {
						setSelectMode(true);
						setSelection(selectOnly(sheetBlock.id));
					}}
					onClose={() => setSheetId(null)}
				/>
			)}
			{showBar &&
				createPortal(
					<SelectionBar
						count={chosenCount}
						canSend={onSendToAgent !== undefined}
						onCopy={() => copyText(blocksMarkdown(chosen()))}
						onSend={() => {
							onSendToAgent?.(blocksQuote(chosen()));
							clear();
						}}
						onCancel={clear}
					/>,
					document.body,
				)}
		</>
	);

	return { context, rootProps, cancelPress, copyBlock, overlay };
}
