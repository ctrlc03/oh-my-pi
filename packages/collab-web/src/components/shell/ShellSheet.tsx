import type { TerminalInfo } from "@oh-my-pi/pi-wire/terminal";
import { Columns2, LoaderCircle, Power, Rows2, X } from "lucide-react";
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode, RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CompanionClient } from "../../lib/companion";
import { shortcutKeys, useOverrides } from "../../lib/shortcuts";
import { readJson, writeJson } from "../../lib/storage";
import {
	type Area,
	type Divider,
	geometry,
	type LayoutNode,
	leafIds,
	neighbour,
	parseLayout,
	reconcile,
	removeLeaf,
	type SplitAxis,
	setRatio,
	splitLeaf,
} from "../../lib/terminal-layout";
import { PLACEABLE_QUERY } from "../../lib/workspace";
import { useMedia } from "../codemap/shared";
import { Sheet, SheetPlacementButton } from "./Sheet";
import { ShellPane, type ShellPaneHandle, type ShellShortcut } from "./ShellPane";
import "./terminal.css";

export interface ShellSheetProps {
	client: CompanionClient;
	/** The session whose folder the shells start in. */
	instanceId: string;
	onClose(): void;
}

/** What a terminal asks for before its pane has a size to report. */
const DEFAULT_SIZE = { cols: 80, rows: 24 };
const LAYOUT_KEY = "omp.collab.shell-layout";
/** Layouts kept, by computer and session; the oldest go first. */
const KEPT_LAYOUTS = 20;
/** A divider moves this much of the body per arrow key press (Shift: the larger step). */
const KEY_STEP = 0.02;
const KEY_STEP_SHIFT = 0.1;

function loadLayout(key: string): LayoutNode | null {
	const stored = readJson(LAYOUT_KEY);
	if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return null;
	return parseLayout((stored as Record<string, unknown>)[key]);
}

/** Remember the layout of this session on this device; the newest `KEPT_LAYOUTS` stay. */
function saveLayout(key: string, layout: LayoutNode | null): void {
	const stored = readJson(LAYOUT_KEY);
	const all: Record<string, unknown> =
		typeof stored === "object" && stored !== null && !Array.isArray(stored) ? { ...stored } : {};
	delete all[key];
	if (layout !== null) all[key] = layout;
	for (const old of Object.keys(all).slice(0, Math.max(0, Object.keys(all).length - KEPT_LAYOUTS))) delete all[old];
	writeJson(LAYOUT_KEY, all);
}

function areaStyle(area: Area): CSSProperties {
	return { left: `${area.x * 100}%`, top: `${area.y * 100}%`, width: `${area.w * 100}%`, height: `${area.h * 100}%` };
}

interface ShellDividerProps {
	divider: Divider;
	body: RefObject<HTMLDivElement | null>;
	onRatio(splitId: string, ratio: number): void;
}

/** The line between two terminals: dragged with a pointer or finger, or moved with the arrow keys. */
function ShellDivider({ divider, body, onRatio }: ShellDividerProps): ReactNode {
	const row = divider.axis === "row";
	const { area, ratio } = divider;
	const dragging = useRef<number | null>(null);
	const style: CSSProperties = row
		? { left: `${(area.x + area.w * ratio) * 100}%`, top: `${area.y * 100}%`, height: `${area.h * 100}%` }
		: { top: `${(area.y + area.h * ratio) * 100}%`, left: `${area.x * 100}%`, width: `${area.w * 100}%` };

	/** The pointer's place in the split as a share of it. Both lengths are viewport pixels, so a zoomed page does not skew it. */
	const moveTo = (event: PointerEvent<HTMLElement>): void => {
		const rect = body.current?.getBoundingClientRect();
		if (rect === undefined) return;
		const total = row ? rect.width : rect.height;
		if (total === 0) return;
		const at = ((row ? event.clientX - rect.left : event.clientY - rect.top) / total - (row ? area.x : area.y)) /
			(row ? area.w : area.h);
		onRatio(divider.id, at);
	};
	const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		const step = event.shiftKey ? KEY_STEP_SHIFT : KEY_STEP;
		const less = row ? "ArrowLeft" : "ArrowUp";
		const more = row ? "ArrowRight" : "ArrowDown";
		if (event.key === less) onRatio(divider.id, ratio - step);
		else if (event.key === more) onRatio(divider.id, ratio + step);
		else if (event.key === "Enter") onRatio(divider.id, 0.5);
		else return;
		event.preventDefault();
	};
	return (
		<div
			role="separator"
			aria-orientation={row ? "vertical" : "horizontal"}
			aria-label="Resize the terminals"
			aria-valuenow={Math.round(ratio * 100)}
			aria-valuemin={0}
			aria-valuemax={100}
			tabIndex={0}
			className="sh-shell-divider"
			data-axis={divider.axis}
			style={style}
			onPointerDown={event => {
				if (event.pointerType === "mouse" && event.button !== 0) return;
				event.preventDefault();
				event.currentTarget.setPointerCapture(event.pointerId);
				dragging.current = event.pointerId;
				event.currentTarget.setAttribute("data-dragging", "");
			}}
			onPointerMove={event => {
				if (dragging.current === event.pointerId) moveTo(event);
			}}
			onPointerUp={event => {
				if (dragging.current !== event.pointerId) return;
				dragging.current = null;
				event.currentTarget.removeAttribute("data-dragging");
			}}
			onPointerCancel={event => {
				dragging.current = null;
				event.currentTarget.removeAttribute("data-dragging");
			}}
			onKeyDown={onKeyDown}
		/>
	);
}

/** Keys a phone's on-screen keyboard lacks: sent to the focused terminal without taking the keyboard away. */
const KEY_ROW: readonly { label: string; text: string; aria: string }[] = [
	{ label: "Esc", text: "\x1b", aria: "Escape" },
	{ label: "Tab", text: "\t", aria: "Tab" },
	{ label: "|", text: "|", aria: "Pipe" },
	{ label: "/", text: "/", aria: "Slash" },
	{ label: "-", text: "-", aria: "Dash" },
	{ label: "~", text: "~", aria: "Tilde" },
];
const ARROWS: readonly { label: string; letter: "A" | "B" | "C" | "D"; aria: string }[] = [
	{ label: "←", letter: "D", aria: "Left arrow" },
	{ label: "↓", letter: "B", aria: "Down arrow" },
	{ label: "↑", letter: "A", aria: "Up arrow" },
	{ label: "→", letter: "C", aria: "Right arrow" },
];

interface ShellKeysProps {
	ctrl: boolean;
	onCtrl(): void;
	onText(text: string): void;
	onArrow(letter: "A" | "B" | "C" | "D"): void;
}

function ShellKeys({ ctrl, onCtrl, onText, onArrow }: ShellKeysProps): ReactNode {
	return (
		// A press must not move the focus off the terminal: the on-screen keyboard would close.
		<div className="sh-shell-keys" role="toolbar" aria-label="Terminal keys" onPointerDown={event => event.preventDefault()}>
			{KEY_ROW.slice(0, 2).map(key => (
				<button key={key.label} type="button" className="sh-btn" aria-label={key.aria} onClick={() => onText(key.text)}>
					{key.label}
				</button>
			))}
			<button type="button" className="sh-btn" aria-pressed={ctrl} aria-label="Control, for the next key" onClick={onCtrl}>
				Ctrl
			</button>
			{ARROWS.map(key => (
				<button key={key.label} type="button" className="sh-btn" aria-label={key.aria} onClick={() => onArrow(key.letter)}>
					{key.label}
				</button>
			))}
			{KEY_ROW.slice(2).map(key => (
				<button key={key.label} type="button" className="sh-btn" aria-label={key.aria} onClick={() => onText(key.text)}>
					{key.label}
				</button>
			))}
		</div>
	);
}

type Status = { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string };

/**
 * An interactive terminal on the computer: a real shell in the session's folder, split into as many terminals as the
 * user likes. The sheet keeps the terminals' layout (kept per session on this device); the shells themselves live on
 * the computer, so closing the sheet or reloading the page finds them again with their recent output.
 */
export function ShellSheet({ client, instanceId, onClose }: ShellSheetProps): ReactNode {
	const snap = useSyncExternalStore(
		useCallback(listener => client.subscribe(listener), [client]),
		useCallback(() => client.getSnapshot(), [client]),
	);
	const live = snap.phase === "live";
	const phone = !useMedia(PLACEABLE_QUERY);
	useOverrides();
	const storeKey = `${client.computerId}:${instanceId}`;

	const [layout, setLayout] = useState<LayoutNode | null>(null);
	const [infos, setInfos] = useState<Record<string, TerminalInfo>>({});
	const [focus, setFocus] = useState<string | null>(null);
	const [status, setStatus] = useState<Status>({ kind: "loading" });
	const [notice, setNotice] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const [ctrl, setCtrl] = useState(false);
	const ctrlArmed = useRef(false);
	const handles = useRef(new Map<string, ShellPaneHandle>());
	const body = useRef<HTMLDivElement>(null);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	// The terminals that exist, put into the layout this device remembers; a session with none gets its first.
	useEffect(() => {
		let stale = false;
		setStatus({ kind: "loading" });
		void (async () => {
			try {
				const alive = await client.terminalList(instanceId);
				let tree = reconcile(loadLayout(storeKey), alive.map(terminal => terminal.id));
				const known = Object.fromEntries(alive.map(terminal => [terminal.id, terminal]));
				if (tree === null) {
					const first = await client.terminalOpen(instanceId, DEFAULT_SIZE.cols, DEFAULT_SIZE.rows);
					// Opening attaches this connection to the shell; with nobody left to show it, the attachment would
					// keep it from ever being reaped as an orphan. Detached, it ends on its own unless another run lists it.
					if (stale) client.terminalDetach(first.id);
					known[first.id] = first;
					tree = { kind: "leaf", id: first.id };
				}
				if (stale) return;
				setInfos(known);
				setLayout(tree);
				setFocus(current => (current !== null && leafIds(tree).includes(current) ? current : leafIds(tree)[0]!));
				setStatus({ kind: "ready" });
			} catch (err) {
				if (!stale) setStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
			}
		})();
		return () => {
			stale = true;
		};
	}, [client, instanceId, storeKey, attempt]);

	useEffect(() => {
		if (status.kind === "ready") saveLayout(storeKey, layout);
	}, [layout, status.kind, storeKey]);

	const register = useCallback((id: string, handle: ShellPaneHandle | null) => {
		if (handle === null) handles.current.delete(id);
		else handles.current.set(id, handle);
	}, []);
	const takeCtrl = useCallback((): boolean => {
		const armed = ctrlArmed.current;
		if (armed) {
			ctrlArmed.current = false;
			setCtrl(false);
		}
		return armed;
	}, []);
	const toggleCtrl = (): void => {
		ctrlArmed.current = !ctrlArmed.current;
		setCtrl(ctrlArmed.current);
		if (focus !== null) handles.current.get(focus)?.focus();
	};

	/** A new shell beside (or under) the focused one, in the same folder. */
	const split = async (axis: SplitAxis): Promise<void> => {
		if (focus === null || busy) return;
		setBusy(true);
		setNotice(null);
		try {
			const size = handles.current.get(focus)?.size() ?? DEFAULT_SIZE;
			const added = await client.terminalOpen(instanceId, size.cols, size.rows);
			if (!mounted.current) {
				// The sheet closed while the shell started: no pane will ever attach to it, so let go of it (see above).
				client.terminalDetach(added.id);
				return;
			}
			setInfos(known => ({ ...known, [added.id]: added }));
			setLayout(tree => (tree === null ? { kind: "leaf", id: added.id } : splitLeaf(tree, focus, axis, added.id)));
			setFocus(added.id);
		} catch (err) {
			setNotice(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	/** End a terminal's shell and give its room to its neighbour; the last one takes the sheet with it. */
	const closePane = (id: string): void => {
		if (layout === null) return;
		client.terminalClose(id).catch(() => {
			// Gone already (its shell ended and it timed out): nothing is left to end.
		});
		const next = removeLeaf(layout, id);
		if (next === null) {
			onClose();
			return;
		}
		if (focus === id) setFocus(neighbour(layout, id, 1) ?? leafIds(next)[0] ?? null);
		setLayout(next);
	};

	const moveFocus = (delta: 1 | -1): void => {
		if (layout === null || focus === null) return;
		const next = neighbour(layout, focus, delta);
		if (next === null) return;
		setFocus(next);
		handles.current.get(next)?.focus();
	};

	const onShortcut = (shortcut: ShellShortcut): void => {
		if (shortcut === "shellSplitRight") void split("row");
		else if (shortcut === "shellSplitDown") void split("column");
		else if (shortcut === "shellClosePane") {
			if (focus !== null) closePane(focus);
		} else moveFocus(shortcut === "shellNextPane" ? 1 : -1);
	};

	const shape = useMemo(() => (layout === null ? null : geometry(layout)), [layout]);
	const panes = layout === null ? 0 : leafIds(layout).length;
	const focused = focus === null ? undefined : infos[focus];

	return (
		<Sheet label="shell" size="full" pane="shell" onClose={onClose}>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title">
					Terminal
					{focused !== undefined && (
						<div className="sh-term-head-sub">
							{focused.shell} · {focused.cwd}
						</div>
					)}
				</div>
				<span className="sh-file-actions">
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={() => void split("row")}
						disabled={focus === null || busy}
						aria-label="Split to the right"
						title={`Split to the right (${shortcutKeys("shellSplitRight")})`}
					>
						<Columns2 size={15} />
					</button>
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={() => void split("column")}
						disabled={focus === null || busy}
						aria-label="Split downward"
						title={`Split downward (${shortcutKeys("shellSplitDown")})`}
					>
						<Rows2 size={15} />
					</button>
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={() => focus !== null && closePane(focus)}
						disabled={focus === null}
						aria-label="End this terminal"
						title={`End this terminal's shell (${shortcutKeys("shellClosePane")})`}
					>
						<Power size={15} />
					</button>
					<SheetPlacementButton />
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={onClose}
						aria-label="Close"
						title="Hide the terminal: its shells keep running for a while"
					>
						<X size={16} />
					</button>
				</span>
			</div>
			{notice !== null && <div className="sh-connect-error">{notice}</div>}
			{status.kind === "loading" && (
				<div className="sh-companion-empty sh-file-status">
					<LoaderCircle size={14} className="sh-spin" /> Opening a shell…
				</div>
			)}
			{status.kind === "error" && (
				<div className="sh-tree-error">
					<div className="sh-connect-error">{status.message}</div>
					<button type="button" className="sh-btn" onClick={() => setAttempt(n => n + 1)}>
						Try again
					</button>
				</div>
			)}
			{status.kind === "ready" && shape !== null && (
				<div ref={body} className="sh-shell-body">
					{shape.panes.map(pane => (
						<ShellPane
							key={pane.id}
							client={client}
							id={pane.id}
							style={areaStyle(pane.area)}
							focused={pane.id === focus}
							live={live}
							showClose={panes > 1}
							onFocus={setFocus}
							onClose={closePane}
							onShortcut={onShortcut}
							register={register}
							takeCtrl={takeCtrl}
						/>
					))}
					{shape.dividers.map(divider => (
						<ShellDivider
							key={divider.id}
							divider={divider}
							body={body}
							onRatio={(splitId, ratio) => setLayout(tree => (tree === null ? tree : setRatio(tree, splitId, ratio)))}
						/>
					))}
				</div>
			)}
			{phone && status.kind === "ready" && (
				<ShellKeys
					ctrl={ctrl}
					onCtrl={toggleCtrl}
					onText={text => focus !== null && handles.current.get(focus)?.send(text)}
					onArrow={letter => focus !== null && handles.current.get(focus)?.cursorKey(letter)}
				/>
			)}
		</Sheet>
	);
}
