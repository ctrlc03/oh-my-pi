import { Check, ChevronRight, LoaderCircle, MessageSquarePlus } from "lucide-react";
import type { ReactNode } from "react";
import { Fragment, useMemo, useState } from "react";
import { useEditorLayout } from "../../lib/editor-layout";
import { splitPath } from "../../lib/format";
import { noteTip } from "../../lib/line-attribution";
import type { BoardFile, HunkNote } from "../../lib/review-board";
import {
	type BoardLayout,
	commentsByHunk,
	type HunkBlock,
	type Highlighter,
	highlightRows,
	hunkLineRange,
	hunkOfRow,
	noteSource,
	notesOf,
	type ParsedFile,
	parseFile,
} from "../../lib/review-board-view";
import { languageOf } from "../../lib/highlight";
import {
	commentId,
	commentOnRows,
	type DiffReview,
	type DiffRow,
	isLineRow,
	lineLabel,
	pickRow,
	type ReviewComment,
	type ReviewScope,
	type RowSelection,
} from "../../lib/review-comments";
import { CommentBox, diffRowProps, ReviewNote } from "../shell/ReviewDiff";
import type { NotesState } from "./board-data";

const BADGES: Record<BoardFile["status"], { letter: string; tone: string; label: string }> = {
	added: { letter: "A", tone: "add", label: "added" },
	modified: { letter: "M", tone: "mod", label: "modified" },
	deleted: { letter: "D", tone: "del", label: "deleted" },
	renamed: { letter: "R", tone: "move", label: "renamed" },
};

/** A diff line's text: the sign, then the code with highlight.js markup when there is some. */
function CodeText({ row, html }: { row: DiffRow; html: string | null }): ReactNode {
	if (html === null) return row.text === "" ? " " : row.text;
	return (
		<>
			<span className="rb-sign">{row.text.slice(0, 1)}</span>
			<span className="sh-file-code" dangerouslySetInnerHTML={{ __html: html }} />
		</>
	);
}

/** One of the reviewer's comments; editing it is local to the note. */
function BoardComment({ id, comment, review }: { id: string; comment: ReviewComment; review: DiffReview }): ReactNode {
	const [text, setText] = useState<string | null>(null);
	return (
		<ReviewNote
			comment={comment}
			editText={text}
			onEdit={() => setText(comment.text)}
			onEditChange={setText}
			onEditSave={() => {
				if (text !== null && text.trim().length > 0) review.save({ ...comment, text: text.trim() });
				setText(null);
			}}
			onEditCancel={() => setText(null)}
			onDelete={() => review.remove(id)}
		/>
	);
}

function explainLabel(state: NotesState): string {
	return state.unexplained > 1 ? `Explain ${state.unexplained} hunks` : "Explain";
}

/** Column 3: what the agent said about this hunk, or how to get it to. */
function NoteCell({ notes, state }: { notes: readonly HunkNote[]; state: NotesState }): ReactNode {
	if (notes.length > 0) {
		return (
			<>
				{notes.map((note, i) => (
					<article
						key={i}
						className={note.weak === true ? "rb-note rb-note-weak" : "rb-note"}
						data-source={note.source}
					>
						<div className="rb-note-source">{noteSource(note)}</div>
						{note.intent !== undefined && note.intent !== "" && (
							<div className="rb-note-intent">{note.intent}</div>
						)}
						<div className="rb-note-text">{note.text}</div>
						{note.weak === true && (
							<div className="rb-note-thin">
								<span>Thin note: it says little about why.</span>
								{state.generating ? (
									<span className="rb-working">
										<LoaderCircle size={14} className="sh-spin" /> Writing notes…
									</span>
								) : (
									state.canGenerate && (
										<button type="button" className="sh-btn" onClick={state.explain}>
											{explainLabel(state)}
										</button>
									)
								)}
								{state.error !== null && <span className="rb-error">{state.error}</span>}
							</div>
						)}
					</article>
				))}
			</>
		);
	}
	if (state.generating) {
		return (
			<div className="rb-empty rb-working">
				<LoaderCircle size={14} className="sh-spin" /> Writing notes…
			</div>
		);
	}
	switch (state.status) {
		case "unavailable":
			return <div className="rb-empty">Agent notes need a companion that supports the review board.</div>;
		case "idle":
		case "loading":
			return (
				<div className="rb-empty rb-working">
					<LoaderCircle size={14} className="sh-spin" /> Looking for what the agent said…
				</div>
			);
		case "error":
			return <div className="rb-empty rb-error">Could not read the agent's notes: {state.error}</div>;
		case "ready":
			return (
				<div className="rb-empty">
					<span>No session explains this hunk.</span>
					{state.canGenerate && (
						<button type="button" className="sh-btn" onClick={state.explain}>
							{explainLabel(state)}
						</button>
					)}
					{state.error !== null && <span className="rb-error">{state.error}</span>}
				</div>
			);
	}
}

export interface BoardFileViewProps {
	file: BoardFile;
	layout: BoardLayout;
	scope: ReviewScope;
	review: DiffReview | null;
	noteIndex: ReadonlyMap<string, HunkNote[]>;
	notes: NotesState;
	hljs: Highlighter | null;
	open: boolean;
	viewed: boolean;
	index: number;
	onToggle(): void;
	onViewed(): void;
}

/** One file of the board: a header, then its hunks, each a row of code, the agent's note and the comments. */
export function BoardFileView({
	file,
	layout,
	scope,
	review,
	noteIndex,
	notes,
	hljs,
	open,
	viewed,
	index,
	onToggle,
	onViewed,
}: BoardFileViewProps): ReactNode {
	const parsed = useMemo(() => parseFile(file.diff), [file.diff]);
	const html = useMemo(
		() => (hljs === null || !open ? null : highlightRows(hljs, languageOf(file.path), parsed.rows)),
		[hljs, open, file.path, parsed],
	);
	const { attribution } = useEditorLayout();
	// A hunk with a note quoted from a session was written by that session: its added rows carry the session's hover.
	// This is the hunk's attribution, not each line's; the editor's gutter has the line-level answer.
	const hunkTips = useMemo(
		() =>
			parsed.hunks.map(hunk =>
				attribution
					? (notesOf(noteIndex, file.path, hunk.header)
							.map(noteTip)
							.find(tip => tip !== null) ?? null)
					: null,
			),
		[parsed, noteIndex, file.path, attribution],
	);
	const comments = review?.comments;
	const placed = useMemo(
		() => commentsByHunk(parsed, comments, scope, file.path),
		[parsed, comments, scope, file.path],
	);
	const [sel, setSel] = useState<RowSelection | null>(null);
	/** Text typed for the selection; null until typed, so the box shows the range's existing comment. */
	const [draft, setDraft] = useState<string | null>(null);
	const { dir, base } = splitPath(file.path);
	const badge = BADGES[file.status];
	const count = placed.orphans.length + placed.byHunk.reduce((sum, group) => sum + group.length, 0);

	const close = (): void => {
		setSel(null);
		setDraft(null);
	};
	const pick = (i: number, extend: boolean): void => {
		const next = pickRow(parsed.rows, sel, i, extend);
		setSel(next.sel);
		if (next.fresh) setDraft(null);
	};
	const lo = sel === null ? 0 : Math.min(sel.anchor, sel.head);
	const hi = sel === null ? 0 : Math.max(sel.anchor, sel.head);
	const range = sel === null ? null : commentOnRows(parsed.rows, sel.anchor, sel.head, scope, file.path, "");
	const existing =
		range === null || comments === undefined
			? undefined
			: Object.hasOwn(comments, commentId(range))
				? comments[commentId(range)]
				: undefined;
	const boxText = draft ?? existing?.text ?? "";
	const boxHunk = sel === null || range === null ? -1 : hunkOfRow(parsed.hunks, hi);

	const rowProps = (i: number, extra: string): Record<string, unknown> => {
		const row = parsed.rows[i]!;
		const line = isLineRow(row);
		return diffRowProps(
			row,
			extra,
			{
				commentable: review !== null && line,
				selected: line && sel !== null && i >= lo && i <= hi,
				marked: Object.hasOwn(placed.marked, i),
				agent: row.kind === "add" ? (hunkTips[hunkOfRow(parsed.hunks, i)] ?? null) : null,
			},
			extend => pick(i, extend),
		);
	};

	const codeCell = (i: number | null, side: "old" | "new"): ReactNode => {
		if (i === null) return <div className="sh-sdiff-cell sh-sdiff-gap" aria-hidden />;
		const row = parsed.rows[i]!;
		return (
			<div {...rowProps(i, "sh-sdiff-cell")}>
				<span className="sh-udiff-num" aria-hidden>
					{side === "old" ? row.oldLine : row.newLine}
				</span>
				<CodeText row={row} html={html?.[i] ?? null} />
			</div>
		);
	};

	const code = (hunk: HunkBlock): ReactNode => {
		if (layout === "four") {
			return (
				<div className="sh-udiff sh-sdiff rb-code">
					<div className="sh-sdiff-full sh-udiff-hunk rb-hunk-head" title={hunk.header}>
						{hunk.header}
					</div>
					{hunk.lines.map((line, k) =>
						line.kind === "full" ? (
							<div key={k} {...rowProps(line.row, "sh-sdiff-full")}>
								{parsed.rows[line.row]!.text}
							</div>
						) : (
							<Fragment key={k}>
								{codeCell(line.left, "old")}
								{codeCell(line.right, "new")}
							</Fragment>
						),
					)}
				</div>
			);
		}
		const rows: number[] = [];
		for (let i = hunk.first; i <= hunk.last; i++) rows.push(i);
		return (
			<div className="sh-udiff rb-code">
				<div className="sh-udiff-row sh-udiff-hunk rb-hunk-head" title={hunk.header}>
					{hunk.header}
				</div>
				{rows.map(i => {
					const row = parsed.rows[i]!;
					return (
						<div key={i} {...rowProps(i, "sh-udiff-row")}>
							{isLineRow(row) && (
								<>
									<span className="sh-udiff-num" aria-hidden>
										{row.oldLine}
									</span>
									<span className="sh-udiff-num" aria-hidden>
										{row.newLine}
									</span>
								</>
							)}
							<CodeText row={row} html={html?.[i] ?? null} />
						</div>
					);
				})}
			</div>
		);
	};

	const commentCell = (hunk: HunkBlock): ReactNode => {
		const entries = placed.byHunk[hunk.index] ?? [];
		const box = review !== null && sel !== null && range !== null && boxHunk === hunk.index;
		const lines = hunkLineRange(parsed.rows, hunk);
		const boxEl = box && (
			<CommentBox
				key="box"
				value={boxText}
				label={lineLabel(range)}
				hint={sel.anchor === sel.head ? "Tap another line to extend the range." : null}
				submitLabel={existing === undefined ? "Add" : "Replace"}
				onChange={setDraft}
				onSubmit={() => {
					const comment = commentOnRows(parsed.rows, sel.anchor, sel.head, scope, file.path, boxText.trim());
					if (comment === null) return;
					review.save(comment);
					close();
				}}
				onCancel={close}
			/>
		);
		// The box sits in row order among the hunk's comments, after those that end before the selection.
		const before = entries.filter(([, , at]) => at <= hi);
		const after = entries.filter(([, , at]) => at > hi);
		return (
			<>
				{review !== null && before.map(([id, c]) => <BoardComment key={id} id={id} comment={c} review={review} />)}
				{boxEl}
				{review !== null && after.map(([id, c]) => <BoardComment key={id} id={id} comment={c} review={review} />)}
				{review !== null && !box && lines !== null && (
					<button
						type="button"
						className="sh-btn rb-hunk-comment"
						onClick={() => {
							setSel({ anchor: lines.first, head: lines.last });
							setDraft(null);
						}}
					>
						<MessageSquarePlus size={14} /> Comment on this hunk
					</button>
				)}
				{review !== null && entries.length === 0 && !box && (
					<div className="rb-hint">Tap lines to comment on them.</div>
				)}
			</>
		);
	};

	return (
		<section className="rb-file" id={`rb-file-${index}`} data-viewed={viewed ? "" : undefined}>
			<div className="rb-file-head">
				<button
					type="button"
					className="sh-change-head"
					onClick={onToggle}
					aria-expanded={open}
					title={`${file.path} · ${badge.label}`}
				>
					<ChevronRight size={14} className={open ? "tr-chev tr-chev--open" : "tr-chev"} />
					<span className={`sh-status-badge sh-status-badge-${badge.tone}`} aria-label={badge.label}>
						{badge.letter}
					</span>
					<span className="sh-change-path">
						<span className="sh-change-dir">{dir}</span>
						<span className="sh-change-base">{base}</span>
					</span>
					{file.added > 0 && <span className="sh-change-add">+{file.added}</span>}
					{file.removed > 0 && <span className="sh-change-del">−{file.removed}</span>}
					{count > 0 && <span className="rb-file-count">{count}</span>}
				</button>
				<button
					type="button"
					className="sh-btn sh-btn-icon sh-tc-viewed"
					aria-pressed={viewed}
					aria-label={viewed ? "Mark as not viewed" : "Mark as viewed"}
					title={viewed ? "Viewed" : "Mark as viewed"}
					onClick={onViewed}
				>
					<Check size={16} />
				</button>
			</div>
			{open && (
				<>
					{file.truncated === true && <div className="sh-file-note">The diff is longer than the host sends.</div>}
					<FileHunks
						parsed={parsed}
						layout={layout}
						path={file.path}
						noteIndex={noteIndex}
						notes={notes}
						code={code}
						commentCell={commentCell}
					/>
					{review !== null && placed.orphans.length > 0 && (
						<div className="rb-orphans">
							<div className="rb-orphans-title">Comments on lines this diff no longer has</div>
							{placed.orphans.map(([id, c]) => (
								<BoardComment key={id} id={id} comment={c} review={review} />
							))}
						</div>
					)}
				</>
			)}
		</section>
	);
}

interface FileHunksProps {
	parsed: ParsedFile;
	layout: BoardLayout;
	path: string;
	noteIndex: ReadonlyMap<string, HunkNote[]>;
	notes: NotesState;
	code(hunk: HunkBlock): ReactNode;
	commentCell(hunk: HunkBlock): ReactNode;
}

function FileHunks({ parsed, layout, path, noteIndex, notes, code, commentCell }: FileHunksProps): ReactNode {
	if (parsed.hunks.length === 0) {
		return parsed.notice.length === 0 ? (
			<div className="sh-companion-empty">No textual changes.</div>
		) : (
			<pre className="rb-notice">{parsed.notice.join("\n")}</pre>
		);
	}
	return (
		<>
			{parsed.hunks.map(hunk => (
				<div key={hunk.index} className="rb-hunk" data-layout={layout}>
					<div className="rb-cell rb-code-cell">{code(hunk)}</div>
					<div className="rb-cell rb-note-cell">
						<div className="rb-sticky">
							<div className="rb-cell-label">Agent</div>
							<NoteCell notes={notesOf(noteIndex, path, hunk.header)} state={notes} />
						</div>
					</div>
					<div className="rb-cell rb-comments-cell">
						<div className="rb-sticky">
							<div className="rb-cell-label">Comments</div>
							{commentCell(hunk)}
						</div>
					</div>
				</div>
			))}
		</>
	);
}
