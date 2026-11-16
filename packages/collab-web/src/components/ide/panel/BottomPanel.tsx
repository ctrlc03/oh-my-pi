import { ChevronDown, ChevronUp } from "lucide-react";
import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import {
	clampPanelHeight,
	PANEL_DEFAULT,
	PANEL_KEY_STEP,
	PANEL_KEY_STEP_SHIFT,
	PANEL_MIN,
	panelMaxHeight,
} from "../../../lib/editor-layout";
import { toLayout } from "../../../lib/zoom";

export type PanelTab = "problems" | "references" | "search";

const TABS: { id: PanelTab; label: string }[] = [
	{ id: "problems", label: "Problems" },
	{ id: "references", label: "References" },
	{ id: "search", label: "Search results" },
];

export interface BottomPanelProps {
	tab: PanelTab;
	onTab(tab: PanelTab): void;
	open: boolean;
	onOpenChange(open: boolean): void;
	/** Saved height in pixels; limited to the editor column when shown. */
	height: number;
	onHeight(px: number): void;
	/** A count shown on each tab; null for none. */
	counts: Record<PanelTab, number | null>;
	/** The active tab's content. */
	children: ReactNode;
}

/**
 * The editor's bottom panel, under the code: Problems, References and Search results as tabs. Its top edge is a
 * separator the pointer or arrow keys move (at least 80px, at most 70% of the editor column); it collapses to its
 * tab row with the chevron or Escape.
 */
export function BottomPanel({
	tab,
	onTab,
	open,
	onOpenChange,
	height,
	onHeight,
	counts,
	children,
}: BottomPanelProps): ReactNode {
	const root = useRef<HTMLElement>(null);
	const drag = useRef<{ pointerId: number; startY: number; startHeight: number; height: number } | null>(null);
	/** The editor column's height, which the panel's maximum is a share of. 0 until measured. */
	const [column, setColumn] = useState(0);
	useEffect(() => {
		const parent = root.current?.parentElement;
		if (parent === null || parent === undefined) return;
		const observer = new ResizeObserver(() => setColumn(parent.clientHeight));
		observer.observe(parent);
		setColumn(parent.clientHeight);
		return () => observer.disconnect();
	}, []);

	const limit = (px: number): number => clampPanelHeight(px, column || root.current?.parentElement?.clientHeight || 0);
	const shown = column === 0 ? Math.max(PANEL_MIN, height) : limit(height);
	const paint = (px: number): void => root.current?.style.setProperty("height", `${px}px`);
	const commit = (px: number): void => {
		const next = limit(px);
		paint(next);
		onHeight(next);
	};
	const onResizeDown = (event: PointerEvent<HTMLElement>): void => {
		if (event.pointerType === "mouse" && event.button !== 0) return;
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		drag.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: shown, height: shown };
		event.currentTarget.setAttribute("data-dragging", "");
	};
	const onResizeMove = (event: PointerEvent<HTMLElement>): void => {
		const current = drag.current;
		if (current === null || current.pointerId !== event.pointerId) return;
		// Dragging the top edge up makes the panel taller.
		current.height = limit(current.startHeight - toLayout(event.clientY - current.startY));
		paint(current.height);
	};
	const onResizeEnd = (event: PointerEvent<HTMLElement>): void => {
		const current = drag.current;
		if (current === null || current.pointerId !== event.pointerId) return;
		drag.current = null;
		event.currentTarget.removeAttribute("data-dragging");
		commit(current.height);
	};
	const onResizeKey = (event: KeyboardEvent<HTMLElement>): void => {
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		const step = event.shiftKey ? PANEL_KEY_STEP_SHIFT : PANEL_KEY_STEP;
		if (event.key === "ArrowUp") commit(shown + step);
		else if (event.key === "ArrowDown") commit(shown - step);
		else if (event.key === "Home") commit(PANEL_MIN);
		else if (event.key === "End") commit(Number.MAX_SAFE_INTEGER);
		else if (event.key === "Enter") commit(PANEL_DEFAULT);
		else return;
		event.preventDefault();
	};
	// Escape closes the panel and nothing else: the sheet stays open.
	const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
		if (event.key !== "Escape" || !open || event.defaultPrevented) return;
		event.preventDefault();
		event.stopPropagation();
		onOpenChange(false);
	};

	const select = (next: PanelTab): void => {
		onTab(next);
		onOpenChange(true);
	};
	return (
		<section
			ref={root}
			className="sh-ide-panel"
			data-open={open ? "true" : "false"}
			style={open ? { height: shown } : undefined}
			aria-label="Panel"
			onKeyDown={onKeyDown}
		>
			{open && (
				<div
					role="separator"
					aria-orientation="horizontal"
					aria-label="Panel height"
					aria-valuemin={PANEL_MIN}
					aria-valuemax={column === 0 ? undefined : panelMaxHeight(column)}
					aria-valuenow={shown}
					tabIndex={0}
					className="sh-ide-panel-resize"
					onPointerDown={onResizeDown}
					onPointerMove={onResizeMove}
					onPointerUp={onResizeEnd}
					onPointerCancel={onResizeEnd}
					onKeyDown={onResizeKey}
					onDoubleClick={() => commit(PANEL_DEFAULT)}
				/>
			)}
			<div className="sh-ide-panel-head">
				<div className="sh-ide-panel-tabs" role="tablist" aria-label="Panel">
					{TABS.map(({ id, label }) => (
						<button
							key={id}
							type="button"
							role="tab"
							id={`sh-ide-panel-tab-${id}`}
							aria-selected={open && tab === id}
							aria-controls="sh-ide-panel-body"
							className="sh-ide-panel-tab"
							onClick={() => select(id)}
						>
							{label}
							{counts[id] !== null && <span className="sh-ide-panel-count">{counts[id]}</span>}
						</button>
					))}
				</div>
				<button
					type="button"
					className="sh-btn sh-btn-icon sh-ide-panel-toggle"
					onClick={() => onOpenChange(!open)}
					aria-expanded={open}
					aria-label={open ? "Collapse the panel" : "Expand the panel"}
					title={open ? "Collapse the panel (Esc)" : "Expand the panel"}
				>
					{open ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
				</button>
			</div>
			{open && (
				<div
					id="sh-ide-panel-body"
					className="sh-ide-panel-body"
					role="tabpanel"
					aria-labelledby={`sh-ide-panel-tab-${tab}`}
				>
					{children}
				</div>
			)}
		</section>
	);
}
