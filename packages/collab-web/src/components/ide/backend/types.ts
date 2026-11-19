/**
 * What `IdeSheet` needs from a code editor, so it can run on CodeMirror (phones, and anywhere Monaco is not
 * wanted) or Monaco (desktop) without knowing which. Documents outlive views: a tab's text, undo history and
 * marks belong to its {@link EditorDoc}, which the sheet keeps while its {@link EditorView} comes and goes
 * (the sheet closing, the engine setting changing).
 *
 * Positions are the repo-intel contract's: 1-based line, 0-based UTF-16 character.
 */
import type { LineMark } from "../../../lib/line-attribution";
import type { LspDiagnostic, LspRange } from "../../../lib/repo-intel";

export type EngineName = "codemirror" | "monaco";

export interface Pos {
	/** 1-based. */
	line: number;
	/** 0-based UTF-16 offset in the line. */
	character: number;
}

export interface CursorInfo {
	line: number;
	/** 1-based column, for the status bar. */
	col: number;
	/** Characters selected by the main selection. */
	selected: number;
}

export interface LineSelection {
	/** 1-based first and last line the main selection touches (the cursor line when nothing is selected). */
	from: number;
	to: number;
	/** The whole lines' text, LF-separated. */
	text: string;
}

export interface LoadedLanguage {
	/** Shown in the status bar; null for plain text. */
	name: string | null;
	/** What `createDoc` takes: opaque to the sheet. */
	handle: unknown;
}

export interface DocInit {
	/** The tab's identity (repo-relative path). */
	path: string;
	/** Which session's repository the path is in (the companion host's instance id): two sessions may open the same path. */
	scope: string;
	/** The file uses CRLF line breaks (default: `text` contains one); a save writes them back. */
	crlf?: boolean;
	/** The file as read: it may contain CRLF. */
	text: string;
	writable: boolean;
	language: LoadedLanguage;
	/**
	 * The user's edits so far, when the document replaces one made by the other engine: `text` is then what is
	 * on disk, and this is applied on top as an edit (so the document starts dirty).
	 */
	unsaved?: string;
}

/** The text a save sent, to mark clean once the write succeeded even if the user kept typing meanwhile. */
export interface DocSnapshot {
	/** What to write to disk: the file's own line breaks. */
	text: string;
	readonly mark: unknown;
}

export interface EditorDoc {
	readonly engine: EngineName;
	readonly path: string;
	readonly writable: boolean;
	/** Saved with CRLF line breaks. */
	readonly crlf: boolean;
	/** The text, LF line breaks (what a diff against the disk and the language server work on). */
	text(): string;
	/** Whether the text differs from the last text marked clean (loaded, saved or reloaded from disk). */
	isDirty(): boolean;
	/** The text as last marked clean, LF line breaks: what the other engine rebuilds this document from. */
	cleanText(): string;
	snapshot(): DocSnapshot;
	/** The document is what `snapshot` captured (default: what it is now). */
	markClean(snapshot?: DocSnapshot): void;
	/**
	 * Bring in the text now on disk as the minimal edits from the current text (the cursor and scroll stay put),
	 * mark the document clean, and return the 1-based lines it changed. `mark` highlights them until the user
	 * types; `undoable` lets the user undo it (the user's own discarded edits), else it stays out of the history
	 * where the engine can: an agent's edit to a clean file is not the user's to undo.
	 * No change events fire: the caller refreshes what it shows.
	 */
	applyDisk(text: string, options: { mark: boolean; undoable: boolean }): number[];
	cursor(): CursorInfo;
	selectedLines(): LineSelection;
	wordAt(pos: Pos): string | null;
	/** Where the cursor (the main selection's head) is. */
	head(): Pos;
	setDiagnostics(diagnostics: readonly LspDiagnostic[]): void;
	/**
	 * Mark these lines as written by an agent (replacing the marks before; none clears them): a gutter bar whose hover is
	 * the mark's `tip`. A mark follows its line as text is typed around it and goes when its line's text changes, so
	 * a person's edit flips the line back; the marks are the text as it is now, not a promise about later text.
	 */
	setAttribution(marks: readonly LineMark[]): void;
	/** Release the document (the tab closed or the engine changed). */
	dispose(): void;
}

export interface HoverAnswer {
	markdown: string;
	range?: LspRange;
}

/** What a view tells the sheet, read on every event (the sheet re-points it each render). */
export interface EditorViewHooks {
	/** The shown document's text or selection changed (`text`: its text did). */
	changed(doc: EditorDoc, text: boolean): void;
	/** F12 or Cmd/Ctrl+click. */
	definition(doc: EditorDoc, pos: Pos): void;
	/** Shift+F12 or the context menu. */
	references(doc: EditorDoc, pos: Pos): void;
	shortcut(kind: "save" | "quick-open" | "search-files"): void;
	/** Hover text for a position; undefined while no language server is offered. Rejects/returns null for nothing to show. */
	hover?(doc: EditorDoc, pos: Pos, signal: AbortSignal): Promise<HoverAnswer | null>;
	/** An agent-line mark was tapped (CodeMirror; a phone has no hover): `tip` is its hover text. */
	attribution?(doc: EditorDoc, tip: string): void;
}

/** What the user's layout asks of the editing surface itself (the rest of the layout is the sheet's own). */
export interface ViewLayout {
	/** Editor font size in pixels; the line height follows at the app's 1.55 ratio. */
	fontSize: number;
	lineNumbers: boolean;
	/** Monaco's minimap: `null` shows it when the pane is wide or `roomy`. CodeMirror has none. */
	minimap: boolean | null;
	/** The pane is a tab with the whole main area to itself: a wide editor offers extras (the minimap). */
	roomy: boolean;
}

export interface EditorView {
	readonly engine: EngineName;
	/** Show `doc` (null: an empty editor, no tabs open). */
	show(doc: EditorDoc | null): void;
	/** Put the cursor at the position (clamped to the document) and bring it to the middle of the view. */
	reveal(pos: { line: number; character?: number }): void;
	focus(): void;
	/** The layout menu's choices and the font size; called once the view exists and whenever one changes. */
	setLayout(layout: ViewLayout): void;
	/** Release the view; its documents survive. */
	destroy(): void;
}

export interface EditorEngine {
	readonly name: EngineName;
	/** Fetch what the file's language needs (a grammar chunk). Never rejects: failing means plain text. */
	loadLanguage(path: string): Promise<LoadedLanguage>;
	createDoc(init: DocInit): EditorDoc;
	createView(parent: HTMLElement, hooks: () => EditorViewHooks): EditorView;
}
