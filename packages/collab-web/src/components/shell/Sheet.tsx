import { PictureInPicture2 } from "lucide-react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from "react";
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BIG_SLOT, EDGES, paneSlot, styleDeclarations } from "../../lib/sheet-frame";
import { useSheetFrame } from "../../lib/use-sheet-frame";
import {
	type PaneKind,
	type Placement,
	PLACEABLE_QUERY,
	SheetPaneContext,
	setPanePlacement,
	type SheetPane,
	useRegisteredPane,
	useSheetPane,
	useSlot,
} from "../../lib/workspace";
import { layoutRect, layoutViewport } from "../../lib/zoom";
import { useMedia } from "../codemap/shared";
import "./sheet-frame.css";
import "./workspace.css";

export interface SheetProps {
	/** Accessible dialog name. */
	label: string;
	/** `wide`: wider dropdown on desktop, for content such as diffs. `full`: near-full-screen canvas with a definite height. `palette`: centered near the top on desktop, for the command palette. `settings`: a centered two-column panel on desktop, full screen on phones. */
	size?: "wide" | "full" | "palette" | "settings";
	/** The control that opened it: on desktop the sheet opens upward from it instead of under the header. */
	anchor?: DOMRect;
	/** A menu or a yes/no question rather than a pane: it stays where it opens and is not moved or resized. */
	fixed?: boolean;
	/** A pane the user can put somewhere else (a tab in the main area, beside the conversation, or floating): the kind that remembers where. Absent: always floating. */
	pane?: PaneKind;
	onClose(): void;
	children: ReactNode;
}

/** Width of an anchored sheet (`.sh-sheet-anchored`); keeps it inside the viewport. */
const ANCHORED_WIDTH = 320;

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
 * With a mouse, every pane can be moved and resized: the big ones (`full`, `wide`, `settings`) in one shared frame,
 * each regular one in a frame of its own (see `sheet-frame.ts`). Anchored popovers, the palette and `fixed` sheets stay put.
 *
 * A sheet with a `pane` can also be put in the main area (see `workspace.ts`): as a tab, or beside the conversation.
 * It is then a plain region in that slot: no backdrop, no handles, no size, and Escape leaves it open.
 *
 * The panel is one element made once for the life of the sheet; its content is portaled into it, so the content
 * (an editor, a terminal, state bound to its DOM) is never remounted. Where the panel is shown is a matter of
 * moving that element: into `document.body` when it floats, into the slot of its tab or the side pane otherwise,
 * with its class, role and style swapped to match. Only the backdrop and the handle layer, which exist while it
 * floats, are portaled to `body` on their own.
 */
export function Sheet({ label, size, anchor, fixed = false, pane, onClose, children }: SheetProps): ReactNode {
	const [element] = useState(() => document.createElement("div"));
	const panel = useRef<HTMLDivElement>(element);
	const placed = useSheetPane(pane);
	const placement = placed?.placement ?? "float";
	const docked = placement !== "float";
	useRegisteredPane(pane, label, onClose);
	const slot = useSlot(placement === "tab" ? (pane ?? null) : placement === "beside" ? "beside" : null);
	const big = size === "full" || size === "wide" || size === "settings";
	const movable = big || (size === undefined && !fixed);
	const framed = useMedia(PLACEABLE_QUERY) && movable && anchor === undefined && !docked;
	const frame = useSheetFrame(framed, panel, big ? BIG_SLOT : paneSlot(label));
	const { layer, syncLayer, onPanelPointerDown } = frame;

	const className = docked
		? "sh-sheet sh-sheet-docked"
		: ["sh-sheet", size && `sh-sheet-${size}`, anchor && "sh-sheet-anchored", framed && "sh-sheet-movable"]
				.filter(Boolean)
				.join(" ");
	// A docked panel whose slot is not there yet waits in the page, invisible, so its content can already take focus.
	const parked = docked && slot === null;
	const style = parked ? PARKED_STYLE : docked ? undefined : framed ? frame.style : anchor && anchorStyle(anchor);
	const styleKey = JSON.stringify(style ?? null);
	// The panel is put where it belongs and dressed for it. Moving it blurs what is focused inside (removing a node
	// does), so the focus is given back.
	const settle = (): void => {
		element.className = className;
		element.setAttribute("role", docked ? "region" : "dialog");
		element.setAttribute("aria-label", label);
		for (const [name, value] of [
			["data-sheet-pane", docked ? pane : undefined],
			["data-sheet-size", docked ? size : undefined],
		] as const) {
			if (value === undefined) element.removeAttribute(name);
			else element.setAttribute(name, value);
		}
		element.removeAttribute("style");
		for (const [name, value] of styleDeclarations(style ?? {})) element.style.setProperty(name, value);
		const parent = slot !== null && docked ? slot : document.body;
		if (element.parentNode !== parent) {
			const focused = element.contains(document.activeElement) ? document.activeElement : null;
			parent.append(element);
			if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
		}
		// Over the panel, at its own stacking: the handle layer follows its panel in the page.
		const handles = layer.current;
		if (
			parent === document.body &&
			handles !== null &&
			!(element.compareDocumentPosition(handles) & Node.DOCUMENT_POSITION_FOLLOWING)
		) {
			const focused = element.contains(document.activeElement) ? document.activeElement : null;
			document.body.insertBefore(element, handles);
			if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
		}
		syncLayer();
	};
	const settleRef = useRef(settle);
	settleRef.current = settle;
	// Before paint, and (through `PanelHome`, the first thing the panel holds) before its content's own layout
	// effects and `autoFocus`, which need the panel to be in the page.
	useLayoutEffect(settle, [element, className, styleKey, docked, slot, label, pane, size, layer, syncLayer, framed]);
	useLayoutEffect(() => () => element.remove(), [element]);

	useEffect(() => {
		if (!framed) return;
		element.addEventListener("pointerdown", onPanelPointerDown);
		return () => element.removeEventListener("pointerdown", onPanelPointerDown);
	}, [element, framed, onPanelPointerDown]);
	useEffect(() => {
		if (docked) return;
		const onKey = (e: KeyboardEvent): void => {
			// Escape an inner widget already handled (the editor closing its search panel) leaves the sheet open.
			if (e.key !== "Escape" || e.defaultPrevented) return;
			const sheets = document.querySelectorAll(".sh-sheet:not(.sh-sheet-docked)");
			if (sheets[sheets.length - 1] !== element) return;
			// Claimed: the sheet below, whose listener may run after this one's close has rendered, must not close too.
			e.preventDefault();
			onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [docked, element, onClose]);

	// Portaled: the glass header's backdrop-filter would otherwise become the
	// containing block for this fixed-position sheet.
	return (
		<>
			{!docked && createPortal(<div className="sh-sheet-backdrop" onClick={onClose} />, document.body)}
			{createPortal(
				<SheetPaneContext.Provider value={placed}>
					<PanelHome settle={settleRef} />
					<div className="sh-sheet-grip" aria-hidden />
					{children}
				</SheetPaneContext.Provider>,
				element,
			)}
			{framed &&
				createPortal(
					// Over the panel but not in it: the panel scrolls and clips, and the handles reach past its edge.
					<div ref={layer} className="sh-sheet-frame">
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
					</div>,
					document.body,
				)}
		</>
	);
}

/** Where a docked panel waits for its slot: in the page and focusable, but not seen or hit. */
const PARKED_STYLE: CSSProperties = { position: "fixed", opacity: 0, pointerEvents: "none" };

/** Puts the panel in the page when the sheet mounts. It is the panel's first child, so its layout effect runs before the rest of the content's. */
function PanelHome({ settle }: { settle: RefObject<() => void> }): ReactNode {
	useLayoutEffect(() => settle.current(), [settle]);
	return null;
}

const PLACEMENT_CHOICES: readonly { placement: Placement; label: string }[] = [
	{ placement: "tab", label: "Open as tab" },
	{ placement: "beside", label: "Open beside" },
	{ placement: "float", label: "Float on top" },
];

/** The ⧉ button for a header: where this pane opens (a tab, beside the conversation, floating on top). Absent wherever panes cannot be placed. */
export function SheetPlacementButton(): ReactNode {
	const placed = useContext(SheetPaneContext);
	const button = useRef<HTMLButtonElement>(null);
	const [menu, setMenu] = useState<DOMRect | null>(null);
	if (placed === null) return null;
	return (
		<>
			<button
				ref={button}
				type="button"
				className={menu === null ? "sh-btn sh-btn-icon" : "sh-btn sh-btn-icon sh-btn-on"}
				onClick={() => setMenu(button.current?.getBoundingClientRect() ?? null)}
				aria-haspopup="menu"
				aria-expanded={menu !== null}
				aria-label="Where this opens"
				title="Open as tab, beside, or floating"
			>
				<PictureInPicture2 size={16} />
			</button>
			{menu !== null && (
				<PlacementMenu
					anchor={menu}
					pane={placed}
					onClose={() => {
						setMenu(null);
						button.current?.focus();
					}}
				/>
			)}
		</>
	);
}

interface PlacementMenuProps {
	anchor: DOMRect;
	pane: SheetPane;
	onClose(): void;
}

function PlacementMenu({ anchor, pane, onClose }: PlacementMenuProps): ReactNode {
	const items = useRef<(HTMLButtonElement | null)[]>([]);
	const at = layoutRect(anchor);
	const room = layoutViewport();
	useEffect(() => {
		const start = PLACEMENT_CHOICES.findIndex(choice => choice.placement === pane.chosen);
		items.current[Math.max(0, start)]?.focus();
	}, [pane.chosen]);
	const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
		const focused = items.current.findIndex(item => item === document.activeElement);
		const count = PLACEMENT_CHOICES.length;
		const move = (to: number): void => {
			event.preventDefault();
			items.current[to]?.focus();
		};
		if (event.key === "Escape") {
			// Claimed: the sheet under the menu must stay open.
			event.preventDefault();
			event.stopPropagation();
			onClose();
		} else if (event.key === "ArrowDown") move((focused + 1) % count);
		else if (event.key === "ArrowUp") move((focused - 1 + count) % count);
		else if (event.key === "Home") move(0);
		else if (event.key === "End") move(count - 1);
		else if (event.key === "Tab") onClose();
	};
	return createPortal(
		<>
			<div className="sh-place-backdrop" onClick={onClose} />
			<div
				className="sh-place-menu"
				role="menu"
				aria-label="Where this opens"
				style={{ top: at.bottom + 4, right: Math.max(8, room.width - at.right) }}
				onKeyDown={onKeyDown}
			>
				{PLACEMENT_CHOICES.map((choice, i) => (
					<button
						key={choice.placement}
						ref={element => {
							items.current[i] = element;
						}}
						type="button"
						role="menuitemradio"
						aria-checked={pane.chosen === choice.placement}
						className="sh-place-item"
						tabIndex={-1}
						title={
							choice.placement === "beside" && !pane.besideRoom
								? "No room beside the conversation here: it opens as a tab"
								: undefined
						}
						onClick={() => {
							setPanePlacement(pane.kind, choice.placement);
							onClose();
						}}
					>
						<span className="sh-place-mark" aria-hidden />
						{choice.label}
					</button>
				))}
			</div>
		</>,
		document.body,
	);
}
