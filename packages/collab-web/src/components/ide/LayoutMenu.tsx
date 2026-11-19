import { Check, ChevronDown, RotateCcw, Settings } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { EditorLayout, LayoutToggle } from "../../lib/editor-layout";

const ITEMS: { id: LayoutToggle; label: string }[] = [
	{ id: "rail", label: "Activity rail" },
	{ id: "tabs", label: "Tab strip" },
	{ id: "minimap", label: "Minimap" },
	{ id: "lineNumbers", label: "Line numbers" },
	{ id: "status", label: "Status bar" },
	{ id: "attribution", label: "Agent-written lines" },
];

/** What the header has no room for in a narrow editor: its buttons become plain items at the top of the menu. */
export interface MenuAction {
	id: string;
	label: string;
	/** Shown in the check column. */
	icon: ReactNode;
	/** A key chord to show beside the label. */
	hint?: string;
	disabled?: boolean;
	/** Stay open after it runs (the font size steps). */
	keepOpen?: boolean;
	onSelect(): void;
}

export interface LayoutMenuProps {
	layout: EditorLayout;
	/** Whether the minimap is showing now (the layout leaves it to the pane's width until the user chooses). */
	minimapOn: boolean;
	/** The engine has a minimap (Monaco); the item is left out otherwise. */
	hasMinimap: boolean;
	/** The paired computer can say which lines agents wrote; the item is left out otherwise. */
	hasAttribution: boolean;
	/** The header's buttons that do not fit, as items above the toggles. */
	actions: readonly MenuAction[];
	/** Something with its own behaviour (the download button) that does not fit; shown with the actions. */
	extra: ReactNode;
	onToggle(id: LayoutToggle, on: boolean): void;
	onReset(): void;
}

const FOCUSABLE = '[role^="menuitem"]:not(:disabled), .sh-ide-layout-extra button:not(:disabled)';

/**
 * The header's ⚙ Layout ▾ menu: the buttons a narrow editor has no room for, checkable items for the editor's chrome,
 * and Reset layout.
 */
export function LayoutMenu({
	layout,
	minimapOn,
	hasMinimap,
	hasAttribution,
	actions,
	extra,
	onToggle,
	onReset,
}: LayoutMenuProps): ReactNode {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	const menu = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const away = (event: PointerEvent): void => {
			if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
		};
		document.addEventListener("pointerdown", away);
		menu.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
		return () => document.removeEventListener("pointerdown", away);
	}, [open]);

	const items = (): HTMLElement[] => [...(menu.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
	const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
		if (event.key === "Escape") {
			// Closes the menu and nothing else: the sheet stays open.
			event.preventDefault();
			event.stopPropagation();
			setOpen(false);
			button.current?.focus();
		} else if (event.key === "Tab") {
			setOpen(false);
		} else if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
			const list = items();
			const at = list.findIndex(element => element === document.activeElement);
			const last = list.length - 1;
			let next = at;
			if (event.key === "Home") next = 0;
			else if (event.key === "End") next = last;
			else if (event.key === "ArrowDown") next = at >= last ? 0 : at + 1;
			else next = at <= 0 ? last : at - 1;
			list[next]?.focus();
			event.preventDefault();
		}
	};

	const checked = (id: LayoutToggle): boolean => (id === "minimap" ? minimapOn : layout[id]);
	const hasActions = actions.length > 0 || extra !== null;
	return (
		<div ref={root} className="sh-ide-layout" onKeyDown={open ? onKeyDown : undefined}>
			<button
				ref={button}
				type="button"
				className={open ? "sh-btn sh-ide-layout-btn sh-btn-on" : "sh-btn sh-ide-layout-btn"}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label="Layout"
				title="Layout"
				onClick={() => setOpen(current => !current)}
			>
				<Settings size={14} />
				<span className="sh-ide-layout-label">Layout</span>
				<ChevronDown size={12} />
			</button>
			{open && (
				<div ref={menu} className="sh-ide-layout-menu" role="menu" aria-label="Layout">
					{actions.map(action => (
						<button
							key={action.id}
							type="button"
							role="menuitem"
							className="sh-ide-layout-item"
							disabled={action.disabled}
							onClick={() => {
								action.onSelect();
								if (action.keepOpen !== true) setOpen(false);
							}}
						>
							<span className="sh-ide-layout-check" aria-hidden="true">
								{action.icon}
							</span>
							<span className="sh-ide-layout-name">{action.label}</span>
							{action.hint !== undefined && <span className="sh-ide-layout-hint">{action.hint}</span>}
						</button>
					))}
					{extra !== null && <div className="sh-ide-layout-extra">{extra}</div>}
					{hasActions && <div className="sh-ide-layout-sep" role="separator" />}
					{ITEMS.filter(
						item => (item.id !== "minimap" || hasMinimap) && (item.id !== "attribution" || hasAttribution),
					).map(item => (
						<button
							key={item.id}
							type="button"
							role="menuitemcheckbox"
							aria-checked={checked(item.id)}
							className="sh-ide-layout-item"
							onClick={() => onToggle(item.id, !checked(item.id))}
						>
							<span className="sh-ide-layout-check" aria-hidden="true">
								{checked(item.id) && <Check size={14} />}
							</span>
							{item.label}
						</button>
					))}
					<div className="sh-ide-layout-sep" role="separator" />
					<button
						type="button"
						role="menuitem"
						className="sh-ide-layout-item"
						onClick={() => {
							onReset();
							setOpen(false);
						}}
					>
						<span className="sh-ide-layout-check" aria-hidden="true">
							<RotateCcw size={13} />
						</span>
						Reset layout
					</button>
				</div>
			)}
		</div>
	);
}
