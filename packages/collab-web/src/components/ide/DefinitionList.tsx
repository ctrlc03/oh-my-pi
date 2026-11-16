import { LoaderCircle, X } from "lucide-react";
import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import { useRef } from "react";
import { clampDefsSize, DEFS_KEY_STEP, DEFS_KEY_STEP_SHIFT, type DefsSize } from "../../lib/editor-layout";
import { toLayout } from "../../lib/zoom";

/** One answer of the definition list: where it goes, or why it cannot be opened. */
export interface DefinitionRow {
	key: string;
	label: string;
	where: string;
	signature?: string;
	/** Root-relative; null: outside the repository, listed but not openable. */
	open: { path: string; line: number; character?: number } | null;
}

export interface DefinitionState {
	word: string;
	/** null while looking. */
	rows: DefinitionRow[] | null;
	error?: string;
	/** Where the rows came from, for the empty message. */
	source: "language server" | "code map";
}

export interface DefinitionListProps {
	definition: DefinitionState;
	/** The saved size; null: the popup sizes itself to its rows. */
	size: DefsSize | null;
	onSize(size: DefsSize | null): void;
	onPick(row: DefinitionRow): void;
	onClose(): void;
}

/**
 * The definitions of a name, floating over the code at its bottom right. Its top left corner resizes it (the pointer, or
 * the arrow keys on the handle) within the editor area; the size is remembered.
 */
export function DefinitionList({ definition, size, onSize, onPick, onClose }: DefinitionListProps): ReactNode {
	const { word, rows, error, source } = definition;
	const root = useRef<HTMLDivElement>(null);
	const drag = useRef<{ pointerId: number; x: number; y: number; start: DefsSize; size: DefsSize } | null>(null);

	const current = (): DefsSize | null =>
		root.current === null ? null : { width: root.current.offsetWidth, height: root.current.offsetHeight };
	/** `next` held to the area the popup floats over (its positioned parent). */
	const limit = (next: DefsSize): DefsSize => {
		const area = root.current?.offsetParent;
		return area instanceof HTMLElement
			? clampDefsSize(next, { width: area.clientWidth, height: area.clientHeight })
			: next;
	};
	const paint = (next: DefsSize): void => {
		root.current?.style.setProperty("width", `${next.width}px`);
		root.current?.style.setProperty("height", `${next.height}px`);
	};
	const commit = (next: DefsSize): void => {
		const limited = limit(next);
		paint(limited);
		onSize(limited);
	};

	/** Back to sizing itself to the rows. */
	const reset = (): void => {
		root.current?.style.removeProperty("width");
		root.current?.style.removeProperty("height");
		onSize(null);
	};

	const onGripDown = (event: PointerEvent<HTMLElement>): void => {
		const start = current();
		if (start === null || (event.pointerType === "mouse" && event.button !== 0)) return;
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, start, size: start };
		event.currentTarget.setAttribute("data-dragging", "");
	};
	const onGripMove = (event: PointerEvent<HTMLElement>): void => {
		const state = drag.current;
		if (state === null || state.pointerId !== event.pointerId) return;
		// The popup is anchored at the bottom right: dragging its top left corner up and left grows it.
		state.size = limit({
			width: state.start.width - toLayout(event.clientX - state.x),
			height: state.start.height - toLayout(event.clientY - state.y),
		});
		paint(state.size);
	};
	const onGripEnd = (event: PointerEvent<HTMLElement>): void => {
		const state = drag.current;
		if (state === null || state.pointerId !== event.pointerId) return;
		drag.current = null;
		event.currentTarget.removeAttribute("data-dragging");
		commit(state.size);
	};
	const onGripKey = (event: KeyboardEvent<HTMLElement>): void => {
		const now = current();
		if (now === null || event.ctrlKey || event.metaKey || event.altKey) return;
		const step = event.shiftKey ? DEFS_KEY_STEP_SHIFT : DEFS_KEY_STEP;
		if (event.key === "ArrowLeft") commit({ ...now, width: now.width + step });
		else if (event.key === "ArrowRight") commit({ ...now, width: now.width - step });
		else if (event.key === "ArrowUp") commit({ ...now, height: now.height + step });
		else if (event.key === "ArrowDown") commit({ ...now, height: now.height - step });
		else if (event.key === "Enter" || event.key === "Home") reset();
		else return;
		event.preventDefault();
	};

	return (
		<div
			ref={root}
			className="sh-ide-defs"
			role="dialog"
			aria-label={`Definitions of ${word}`}
			data-sized={size === null ? undefined : "true"}
			style={size === null ? undefined : { width: size.width, height: size.height }}
		>
			<button
				type="button"
				className="sh-ide-defs-grip"
				aria-label="Resize the definitions list"
				title="Drag to resize; arrow keys too, Enter to reset"
				onPointerDown={onGripDown}
				onPointerMove={onGripMove}
				onPointerUp={onGripEnd}
				onPointerCancel={onGripEnd}
				onKeyDown={onGripKey}
				onDoubleClick={reset}
			/>
			<div className="sh-ide-defs-head">
				<span>
					Definitions of <code>{word}</code>
				</span>
				<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="Close definitions">
					<X size={14} />
				</button>
			</div>
			{rows === null && (
				<div className="sh-companion-empty sh-file-status">
					<LoaderCircle size={14} className="sh-spin" /> Looking it up…
				</div>
			)}
			{error !== undefined && <div className="sh-connect-error">{error}</div>}
			{rows !== null && error === undefined && rows.length === 0 && (
				<div className="sh-file-note">
					No definition of {word} in the {source}.
				</div>
			)}
			{rows !== null && rows.length > 0 && (
				<ul className="sh-ide-defs-list">
					{rows.map(row => (
						<li key={row.key}>
							<button
								type="button"
								className="sh-ide-def"
								onClick={() => onPick(row)}
								disabled={row.open === null}
								title={row.open === null ? "Outside the repository: it cannot be opened here" : undefined}
							>
								<span className="sh-ide-def-label">{row.label}</span>
								<span className="sh-ide-def-where">{row.where}</span>
								{row.signature !== undefined && <code className="sh-ide-def-sig">{row.signature}</code>}
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
