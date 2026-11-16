import { ChevronsDownUp, ChevronsUpDown, FileText, LoaderCircle, Sparkles, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { splitPath } from "../../lib/format";
import { loadHighlighter } from "../../lib/highlight";
import type { BoardFile, HunkNote } from "../../lib/review-board";
import {
	type BoardLayout,
	boardLayout,
	boardScope,
	boardStorageKey,
	type Highlighter,
	indexNotes,
} from "../../lib/review-board-view";
import {
	commentId,
	type DiffReview,
	loadReviewComments,
	type ReviewComment,
	saveReviewComments,
} from "../../lib/review-comments";
import { fileSignature, loadViewed, saveViewed, viewedPaths } from "../../lib/turn-changes";
import type { ReviewSubject } from "../../lib/review-board";
import { PHONE_QUERY, useMedia } from "../codemap/shared";
import { BoardFileView } from "./BoardFileView";
import type { NotesState } from "./board-data";
import { SendBar } from "./SendBar";
import "../shell/turn-changes.css";
import "./review-board.css";

/** Up to this many files open expanded; more start collapsed. */
const EXPAND_ALL_UP_TO = 6;

/** The board area's width in layout pixels, following the sheet as it is resized. */
function useWidth(ref: { current: HTMLElement | null }): number {
	const [width, setWidth] = useState(0);
	useEffect(() => {
		const el = ref.current;
		if (el === null) return;
		const read = (): void => setWidth(el.clientWidth);
		read();
		const observer = new ResizeObserver(read);
		observer.observe(el);
		return () => observer.disconnect();
	}, [ref]);
	return width;
}

/** highlight.js, fetched once the board first shows code; the board is plain text until it arrives (or if it cannot). */
function useHighlighter(): Highlighter | null {
	const [hljs, setHljs] = useState<Highlighter | null>(null);
	useEffect(() => {
		let stale = false;
		loadHighlighter().then(
			loaded => {
				if (!stale) setHljs(loaded);
			},
			() => {},
		);
		return () => {
			stale = true;
		};
	}, []);
	return hljs;
}

const COLUMN_TITLES: Record<Exclude<BoardLayout, "stacked">, string[]> = {
	four: ["Old", "New", "Agent's reasoning", "Your comments"],
	three: ["Changes", "Agent's reasoning", "Your comments"],
};

export interface ReviewBoardProps {
	subject: ReviewSubject;
	sessionId: string | null;
	files: readonly BoardFile[];
	/** Things to say about the files (unreadable ones, omitted ones). */
	notices: readonly string[];
	notes: NotesState;
	/** Builds the one prompt carrying `comments` to the agent. */
	prompt(comments: readonly ReviewComment[], notes: readonly HunkNote[]): string;
	/** null: this viewer cannot send, so commenting is off. */
	onSend: ((text: string, deliver: "follow-up" | undefined) => void) | null;
}

/**
 * The board over one subject's files: per hunk the old and new code, the agent's note and the reviewer's comments.
 * Comments and viewed marks are kept per session and subject, so a reload (or another subject) never loses them.
 */
export function ReviewBoard({
	subject,
	sessionId,
	files,
	notices,
	notes,
	prompt,
	onSend,
}: ReviewBoardProps): ReactNode {
	const key = sessionId === null ? null : boardStorageKey(sessionId, subject);
	const scope = boardScope(subject);
	const area = useRef<HTMLDivElement>(null);
	const width = useWidth(area);
	const phone = useMedia(PHONE_QUERY);
	const layout = boardLayout(width, phone);
	const hljs = useHighlighter();
	const [comments, setComments] = useState<Record<string, ReviewComment>>(() =>
		key === null || onSend === null ? {} : loadReviewComments(key),
	);
	const [marks, setMarks] = useState<Record<string, string>>(() => (key === null ? {} : loadViewed(key)));
	const [explicit, setExplicit] = useState<Record<string, boolean>>({});
	const [rail, setRail] = useState(false);
	const viewed = useMemo(() => viewedPaths(files, marks), [files, marks]);
	const noteIndex = useMemo(() => indexNotes(notes.notes), [notes.notes]);

	const changeComments = useCallback(
		(next: Record<string, ReviewComment>): void => {
			setComments(next);
			if (key !== null) saveReviewComments(key, next);
		},
		[key],
	);
	const review: DiffReview | null =
		onSend === null
			? null
			: {
					comments,
					save: comment => changeComments({ ...comments, [commentId(comment)]: comment }),
					remove: id => changeComments(Object.fromEntries(Object.entries(comments).filter(([k]) => k !== id))),
				};

	const isOpen = (file: BoardFile): boolean =>
		Object.hasOwn(explicit, file.path)
			? explicit[file.path]!
			: files.length <= EXPAND_ALL_UP_TO && !viewed.has(file.path);
	const markViewed = (file: BoardFile): void => {
		const next = { ...marks };
		const done = viewed.has(file.path);
		if (done) delete next[file.path];
		else next[file.path] = fileSignature(file);
		setMarks(next);
		if (key !== null) saveViewed(key, next);
		// Marking a file viewed folds it away; unmarking it leaves it as it is.
		if (!done) setExplicit({ ...explicit, [file.path]: false });
	};
	const setAll = (open: boolean): void => setExplicit(Object.fromEntries(files.map(file => [file.path, open])));
	const allOpen = files.length > 0 && files.every(isOpen);
	const jump = (file: BoardFile, i: number): void => {
		setExplicit({ ...explicit, [file.path]: true });
		setRail(false);
		// After the file has rendered open.
		requestAnimationFrame(() => area.current?.querySelector(`#rb-file-${i}`)?.scrollIntoView({ block: "start" }));
	};

	const added = files.reduce((sum, file) => sum + file.added, 0);
	const removed = files.reduce((sum, file) => sum + file.removed, 0);
	const titles = layout === "stacked" ? null : COLUMN_TITLES[layout];

	return (
		<div className="rb-pane">
			<div className="rb-toolbar">
				<button type="button" className="sh-btn" aria-expanded={rail} onClick={() => setRail(!rail)}>
					<FileText size={14} /> Files{" "}
					<span className="sh-tab-count">
						{viewed.size}/{files.length}
					</span>
				</button>
				<span className="rb-summary">
					{files.length} file{files.length === 1 ? "" : "s"} · <span className="sh-change-add">+{added}</span>{" "}
					<span className="sh-change-del">−{removed}</span>
				</span>
				<span className="rb-toolbar-fill" />
				{notes.canGenerate && notes.unexplained > 0 && (
					<button type="button" className="sh-btn" disabled={notes.generating} onClick={notes.explain}>
						{notes.generating ? <LoaderCircle size={14} className="sh-spin" /> : <Sparkles size={14} />}
						{notes.generating
							? "Writing notes…"
							: `Explain ${notes.unexplained} hunk${notes.unexplained === 1 ? "" : "s"}`}
					</button>
				)}
				{files.length > 1 && (
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						aria-label={allOpen ? "Collapse all files" : "Expand all files"}
						title={allOpen ? "Collapse all" : "Expand all"}
						onClick={() => setAll(!allOpen)}
					>
						{allOpen ? <ChevronsDownUp size={16} /> : <ChevronsUpDown size={16} />}
					</button>
				)}
			</div>
			{notes.error !== null && <div className="sh-connect-error rb-notice-line">{notes.error}</div>}
			{notes.status === "unavailable" && (
				<div className="sh-file-note">Notes from the agent need a companion that supports the review board.</div>
			)}
			{notices.map(text => (
				<div key={text} className="sh-file-note">
					{text}
				</div>
			))}
			<div className="rb-main" ref={area} data-layout={layout}>
				{rail && (
					<>
						<button
							type="button"
							className="rb-scrim"
							aria-label="Close the file list"
							onClick={() => setRail(false)}
						/>
						<nav className="rb-rail" aria-label="Files">
							<div className="rb-rail-head">
								Files
								<button
									type="button"
									className="sh-btn sh-btn-icon"
									aria-label="Close"
									onClick={() => setRail(false)}
								>
									<X size={16} />
								</button>
							</div>
							<ul>
								{files.map((file, i) => {
									const { dir, base } = splitPath(file.path);
									return (
										<li key={file.path}>
											<button
												type="button"
												className="rb-rail-file"
												data-viewed={viewed.has(file.path) ? "" : undefined}
												onClick={() => jump(file, i)}
												title={file.path}
											>
												<span className="sh-change-path">
													<span className="sh-change-dir">{dir}</span>
													<span className="sh-change-base">{base}</span>
												</span>
												{file.added > 0 && <span className="sh-change-add">+{file.added}</span>}
												{file.removed > 0 && <span className="sh-change-del">−{file.removed}</span>}
											</button>
										</li>
									);
								})}
							</ul>
						</nav>
					</>
				)}
				<div className="rb-body" data-layout={layout}>
					{titles !== null && (
						<div className="rb-colheads" data-layout={layout}>
							{titles.map(title => (
								<div key={title} className="rb-colhead">
									{title}
								</div>
							))}
						</div>
					)}
					{files.length === 0 ? (
						<div className="sh-companion-empty">No files changed.</div>
					) : (
						files.map((file, i) => (
							<BoardFileView
								key={file.path}
								file={file}
								index={i}
								layout={layout}
								scope={scope}
								review={review}
								noteIndex={noteIndex}
								notes={notes}
								hljs={hljs}
								open={isOpen(file)}
								viewed={viewed.has(file.path)}
								onToggle={() => setExplicit({ ...explicit, [file.path]: !isOpen(file) })}
								onViewed={() => markViewed(file)}
							/>
						))
					)}
				</div>
			</div>
			<SendBar
				comments={comments}
				readOnly={onSend === null}
				onDiscard={() => changeComments({})}
				onSend={deliver => {
					if (onSend === null) return;
					onSend(prompt(Object.values(comments), notes.notes), deliver);
					changeComments({});
				}}
			/>
		</div>
	);
}
