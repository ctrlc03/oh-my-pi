import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
	commentId,
	commentOnRows,
	type DiffReview,
	isLineRow,
	lineLabel,
	parseUnifiedDiff,
	type ReviewComment,
	type ReviewScope,
	rowKey,
	sameHunk,
} from "../../lib/review-comments";
import { lastRow, splitLines } from "../../lib/split-diff";

interface Selection {
	anchor: number;
	head: number;
}

export interface UnifiedDiffProps {
	diff: string;
	scope: ReviewScope;
	path: string;
	/** null: commenting is off (nowhere to send a review). */
	review: DiffReview | null;
	/** Side-by-side layout (old file left, new file right) instead of one column. */
	side?: boolean;
}

/**
 * Colored unified diff with line numbers. `DiffBlock` (agent edits) reads blank rows as
 * elided gaps and `---`/`+++` as changes, which misrenders a real `git diff`.
 * With a `review`, tapping a line selects it, a second tap (or shift-click) in the same hunk
 * extends the range, and the comment box opens under the selection.
 */
export function UnifiedDiff({ diff, scope, path, review, side }: UnifiedDiffProps): ReactNode {
	const rows = useMemo(() => parseUnifiedDiff(diff), [diff]);
	const split = useMemo(() => (side ? splitLines(rows) : undefined), [side, rows]);
	const [sel, setSel] = useState<Selection | null>(null);
	/** Text typed for the selection; null until typed, so the box shows the range's existing comment. */
	const [draft, setDraft] = useState<string | null>(null);
	const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
	const comments = review?.comments;
	const layout = useMemo(() => {
		const index: Record<string, number> = {};
		rows.forEach((row, i) => {
			if (isLineRow(row)) index[rowKey(row)] = i;
		});
		const after: Record<number, Array<[string, ReviewComment]>> = {};
		const marked: Record<number, true> = {};
		// Comments whose lines the diff no longer has (the file changed since) stay reachable here.
		const orphans: Array<[string, ReviewComment]> = [];
		for (const [id, c] of Object.entries(comments ?? {})) {
			if (c.scope !== scope || c.path !== path) continue;
			const from = Object.hasOwn(index, c.from) ? index[c.from] : undefined;
			const to = Object.hasOwn(index, c.to) ? index[c.to] : undefined;
			if (from === undefined || to === undefined) {
				orphans.push([id, c]);
				continue;
			}
			(after[to] ??= []).push([id, c]);
			for (let i = from; i <= to; i++) marked[i] = true;
		}
		return { after, marked, orphans };
	}, [rows, comments, scope, path]);
	if (diff.trim().length === 0) return <div className="sh-companion-empty">No textual changes.</div>;

	const close = (): void => {
		setSel(null);
		setDraft(null);
	};
	const pick = (i: number, extend: boolean): void => {
		if (sel === null) {
			setSel({ anchor: i, head: i });
			setDraft(null);
			return;
		}
		const single = sel.anchor === sel.head;
		if (single && !extend && i === sel.anchor) return close();
		if ((single || extend) && sameHunk(rows, sel.anchor, i)) return setSel({ anchor: sel.anchor, head: i });
		setSel({ anchor: i, head: i });
		setDraft(null);
	};
	const lo = sel === null ? 0 : Math.min(sel.anchor, sel.head);
	const hi = sel === null ? 0 : Math.max(sel.anchor, sel.head);
	const range = sel === null ? null : commentOnRows(rows, sel.anchor, sel.head, scope, path, "");
	const existing =
		range === null || comments === undefined
			? undefined
			: Object.hasOwn(comments, commentId(range))
				? comments[commentId(range)]
				: undefined;
	const boxText = draft ?? existing?.text ?? "";

	const note = ([id, c]: [string, ReviewComment]): ReactNode => (
		<ReviewNote
			key={id}
			comment={c}
			editText={editing?.id === id ? editing.text : null}
			onEdit={() => setEditing({ id, text: c.text })}
			onEditChange={text => setEditing({ id, text })}
			onEditSave={() => {
				if (editing !== null && editing.text.trim().length > 0) review?.save({ ...c, text: editing.text.trim() });
				setEditing(null);
			}}
			onEditCancel={() => setEditing(null)}
			onDelete={() => review?.remove(id)}
		/>
	);

	const rowProps = (i: number, extra: string): Record<string, unknown> => {
		const row = rows[i]!;
		const line = isLineRow(row);
		const commentable = review !== null && line;
		const selected = line && sel !== null && i >= lo && i <= hi;
		const className = [
			extra,
			row.kind === "hunk" && "sh-udiff-hunk",
			row.kind === "add" && "sh-udiff-add",
			row.kind === "del" && "sh-udiff-del",
			commentable && "sh-udiff-pick",
			selected && "sh-udiff-sel",
			line && Object.hasOwn(layout.marked, i) && "sh-udiff-commented",
		]
			.filter(Boolean)
			.join(" ");
		const onKey = (e: KeyboardEvent): void => {
			if (e.key !== "Enter" && e.key !== " ") return;
			e.preventDefault();
			pick(i, e.shiftKey);
		};
		return {
			className,
			...(commentable && {
				role: "button",
				tabIndex: 0,
				"aria-pressed": selected,
				onKeyDown: onKey,
				onClick: (e: MouseEvent) => {
					// Dragging across the text to copy it is not a tap on the line.
					if (window.getSelection()?.isCollapsed === false) return;
					pick(i, e.shiftKey);
				},
			}),
		};
	};
	/** Notes on the rows of one display line, then the comment box when the selection ends on it. */
	const below = (i: number): ReactNode => (
		<>
			{layout.after[i]?.map(note)}
			{review !== null && sel !== null && range !== null && hi === i && (
				<CommentBox
					value={boxText}
					label={lineLabel(range)}
					hint={sel.anchor === sel.head ? "Tap another line to extend the range." : null}
					submitLabel={existing === undefined ? "Add" : "Replace"}
					onChange={setDraft}
					onSubmit={() => {
						const comment = commentOnRows(rows, sel.anchor, sel.head, scope, path, boxText.trim());
						if (comment === null) return;
						review.save(comment);
						close();
					}}
					onCancel={close}
				/>
			)}
		</>
	);

	if (split !== undefined) {
		const cell = (i: number | null, side: "old" | "new"): ReactNode => {
			if (i === null) return <div className="sh-sdiff-cell sh-sdiff-gap" aria-hidden />;
			const row = rows[i]!;
			const num = side === "old" ? row.oldLine : row.newLine;
			return (
				<div {...rowProps(i, "sh-sdiff-cell")}>
					<span className="sh-udiff-num" aria-hidden>
						{num}
					</span>
					{row.text === "" ? " " : row.text}
				</div>
			);
		};
		return (
			<div className="sh-udiff sh-sdiff">
				{split.map((line, k) => (
					<Fragment key={k}>
						{line.kind === "full" ? (
							<div {...rowProps(line.row, "sh-sdiff-full")}>{rows[line.row]!.text}</div>
						) : (
							<>
								{cell(line.left, "old")}
								{cell(line.right, "new")}
							</>
						)}
						{below(lastRow(line))}
					</Fragment>
				))}
				{layout.orphans.map(note)}
			</div>
		);
	}

	return (
		<div className="sh-udiff">
			{rows.map((row, i) => {
				const line = isLineRow(row);
				return (
					<Fragment key={i}>
						<div {...rowProps(i, "sh-udiff-row")}>
							{line && (
								<>
									<span className="sh-udiff-num" aria-hidden>
										{row.oldLine}
									</span>
									<span className="sh-udiff-num" aria-hidden>
										{row.newLine}
									</span>
								</>
							)}
							{row.text === "" ? " " : row.text}
						</div>
						{below(i)}
					</Fragment>
				);
			})}
			{layout.orphans.map(note)}
		</div>
	);
}

interface CommentBoxProps {
	value: string;
	/** The lines being commented, e.g. `12-14`. */
	label: string;
	hint: string | null;
	submitLabel: string;
	onChange(text: string): void;
	onSubmit(): void;
	onCancel(): void;
}

function CommentBox({ value, label, hint, submitLabel, onChange, onSubmit, onCancel }: CommentBoxProps): ReactNode {
	const input = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		const el = input.current;
		if (el === null) return;
		el.focus();
		el.setSelectionRange(el.value.length, el.value.length);
	}, []);
	const blank = value.trim().length === 0;
	return (
		<div className="sh-udiff-note">
			<textarea
				ref={input}
				className="sh-input sh-udiff-textarea"
				rows={3}
				value={value}
				placeholder={`Comment on line ${label}`}
				aria-label={`Comment on line ${label}`}
				onChange={e => onChange(e.currentTarget.value)}
				onKeyDown={e => {
					if (e.key === "Escape") {
						// The sheet closes on Escape unless the key was handled.
						e.preventDefault();
						onCancel();
					} else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !blank) {
						e.preventDefault();
						onSubmit();
					}
				}}
			/>
			{hint !== null && <div className="sh-udiff-hint">{hint}</div>}
			<div className="sh-udiff-actions">
				<button type="button" className="sh-btn" onClick={onCancel}>
					Cancel
				</button>
				<button type="button" className="sh-btn sh-btn-primary" disabled={blank} onClick={onSubmit}>
					{submitLabel}
				</button>
			</div>
		</div>
	);
}

interface ReviewNoteProps {
	comment: ReviewComment;
	/** Text being edited, or null while the note is shown. */
	editText: string | null;
	onEdit(): void;
	onEditChange(text: string): void;
	onEditSave(): void;
	onEditCancel(): void;
	onDelete(): void;
}

function ReviewNote({
	comment,
	editText,
	onEdit,
	onEditChange,
	onEditSave,
	onEditCancel,
	onDelete,
}: ReviewNoteProps): ReactNode {
	if (editText !== null) {
		return (
			<CommentBox
				value={editText}
				label={lineLabel(comment)}
				hint={null}
				submitLabel="Save"
				onChange={onEditChange}
				onSubmit={onEditSave}
				onCancel={onEditCancel}
			/>
		);
	}
	return (
		<div className="sh-udiff-note">
			<div className="sh-udiff-note-head">
				<span className="sh-udiff-note-lines">line {lineLabel(comment)}</span>
				<button type="button" className="sh-btn sh-udiff-note-btn" onClick={onEdit}>
					Edit
				</button>
				<button type="button" className="sh-btn sh-udiff-note-btn" onClick={onDelete}>
					Delete
				</button>
			</div>
			<div className="sh-udiff-note-text">{comment.text}</div>
		</div>
	);
}
