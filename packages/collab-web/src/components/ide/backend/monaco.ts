/**
 * The Monaco engine: VS Code's editor (find and replace, multi-cursor, folding, the command palette, minimap)
 * behind the editor interface. A document is a Monaco text model plus the view state (cursor, scroll, folds)
 * it had when it was last shown. This module is Monaco's own bundle: the build makes it a standalone file
 * under `monaco-assets/` (see `scripts/build-monaco-assets.ts`) that the page imports only when the Monaco
 * engine is chosen, so the main bundle and phones never carry it.
 */
import "./monaco-languages";
import { minimapShown } from "../../../lib/editor-layout";
import type { LineMark } from "../../../lib/line-attribution";
import type { LspDiagnostic } from "../../../lib/repo-intel";
import { diffText } from "../text-diff";
import { textPositionAt, toMarker } from "./lsp-map";
import { editor, KeyCode, KeyMod, languages, Range, Uri } from "./monaco-core";
import { monacoLanguageOf } from "./monaco-language-ids";
import { readTheme, watchTheme } from "./monaco-theme";
import type {
	CursorInfo,
	DocInit,
	DocSnapshot,
	EditorDoc,
	EditorEngine,
	EditorView,
	EditorViewHooks,
	LineSelection,
	LoadedLanguage,
	Pos,
	ViewLayout,
} from "./types";

type Model = editor.ITextModel;
type Editor = editor.IStandaloneCodeEditor;

const THEME = "omp";
/** Line height as a multiple of the font size (what `readTheme` and CodeMirror's `.cm-scroller` use). */
const LINE_HEIGHT_RATIO = 1.55;

const lineHeightFor = (fontSize: number): number => Math.round(fontSize * LINE_HEIGHT_RATIO);
const LF = editor.EndOfLinePreference.LF;

// The worker lives next to this file in the built app. The dev server serves no such file: there Monaco runs
// its worker code on the main thread, which is slower for large files and logs a warning.
if (process.env.NODE_ENV === "production") {
	globalThis.MonacoEnvironment = {
		getWorker: () => new Worker(new URL("editor.worker.js", import.meta.url)),
	};
}

const toLf = (text: string): string => text.replace(/\r\n/g, "\n");

/** The document of each model, for the providers that only receive a model. */
const docs = new WeakMap<Model, MonacoDoc>();

interface SavedMark {
	version: number;
	lf: string;
}

class MonacoDoc implements EditorDoc {
	readonly engine = "monaco";
	/** The view showing this document: its cursor and selection are the live ones. */
	shownIn: MonacoView | null = null;
	/** Cursor, scroll and folds as of when the document was last hidden. */
	viewState: editor.ICodeEditorViewState | null = null;
	/** Set while the sheet brings disk text in: the model's events are its own business then. */
	muted = false;
	readonly #subscription: { dispose(): void };
	#savedVersion: number;
	#cleanText: string;
	#marks: string[] = [];
	/** The agent-line marks: each decoration with the text its line had (trimmed) when it was marked. */
	#attribution: { id: string; text: string }[] = [];

	constructor(
		readonly path: string,
		readonly writable: boolean,
		readonly crlf: boolean,
		readonly model: Model,
		cleanText: string,
	) {
		this.#savedVersion = model.getAlternativeVersionId();
		this.#cleanText = cleanText;
		docs.set(model, this);
		this.#subscription = model.onDidChangeContent(() => {
			this.#pruneAttribution();
			if (this.muted) return;
			this.#clearMarks();
			this.shownIn?.hooks().changed(this, true);
		});
	}

	/** Drop the marks of lines whose text changed since they were marked: a person's edit flips a line back. */
	#pruneAttribution(): void {
		if (this.#attribution.length === 0) return;
		const stale: string[] = [];
		this.#attribution = this.#attribution.filter(mark => {
			const range = this.model.getDecorationRange(mark.id);
			const keep = range !== null && this.model.getLineContent(range.startLineNumber).trim() === mark.text;
			if (!keep) stale.push(mark.id);
			return keep;
		});
		if (stale.length > 0) this.model.deltaDecorations(stale, []);
	}

	#clearMarks(): void {
		if (this.#marks.length > 0) this.#marks = this.model.deltaDecorations(this.#marks, []);
	}

	/** Mark the loaded text as the clean one, then put the unsaved text of the other engine's document on top. */
	startFrom(unsaved: string | undefined): void {
		this.#savedVersion = this.model.getAlternativeVersionId();
		if (unsaved === undefined || unsaved === this.#cleanText) return;
		this.model.pushEditOperations(null, [{ range: this.model.getFullModelRange(), text: unsaved }], () => null);
	}

	text(): string {
		return this.model.getValue(LF);
	}

	isDirty(): boolean {
		return this.model.getAlternativeVersionId() !== this.#savedVersion;
	}

	cleanText(): string {
		return this.#cleanText;
	}

	snapshot(): DocSnapshot {
		const mark: SavedMark = { version: this.model.getAlternativeVersionId(), lf: this.text() };
		return { text: this.model.getValue(), mark };
	}

	markClean(snapshot?: DocSnapshot): void {
		const mark = (snapshot?.mark as SavedMark | undefined) ?? {
			version: this.model.getAlternativeVersionId(),
			lf: this.text(),
		};
		this.#savedVersion = mark.version;
		this.#cleanText = mark.lf;
	}

	applyDisk(text: string, options: { mark: boolean; undoable: boolean }): number[] {
		const before = this.text();
		const { edits, changedLines } = diffText(before, toLf(text));
		this.muted = true;
		try {
			if (edits.length > 0) {
				const operations = edits.map(edit => {
					const from = textPositionAt(before, edit.from);
					const to = textPositionAt(before, edit.to);
					return {
						range: new Range(from.line, from.character + 1, to.line, to.character + 1),
						text: edit.insert,
					};
				});
				// Monaco has no way to keep an edit out of its undo stack that leaves the stack sound, so a reload is
				// one step of its own: undoing it brings the previous text back (dirty). `undoable` only matters to CodeMirror.
				this.model.pushStackElement();
				this.model.pushEditOperations(null, operations, () => null);
				this.model.pushStackElement();
			}
			this.#clearMarks();
			if (options.mark) {
				this.#marks = this.model.deltaDecorations(
					[],
					changedLines.map(line => ({
						range: new Range(line, 1, line, 1),
						options: {
							isWholeLine: true,
							className: "sh-ide-mm-changed",
							linesDecorationsClassName: "sh-ide-mm-changed-bar",
						},
					})),
				);
			}
		} finally {
			this.muted = false;
		}
		this.markClean();
		return changedLines;
	}

	cursor(): CursorInfo {
		const view = this.shownIn;
		const selection = view?.editor.getSelection();
		const position = view?.editor.getPosition();
		if (view === null || selection == null || position == null) {
			const state = this.viewState?.cursorState[0];
			return { line: state?.position.lineNumber ?? 1, col: state?.position.column ?? 1, selected: 0 };
		}
		return {
			line: position.lineNumber,
			col: position.column,
			selected: this.model.getValueLengthInRange(selection, LF),
		};
	}

	selectedLines(): LineSelection {
		const selection = this.shownIn?.editor.getSelection();
		const first = selection?.startLineNumber ?? 1;
		let last = selection?.endLineNumber ?? first;
		// A selection ending at the start of a line does not include that line.
		if (selection != null && !selection.isEmpty() && selection.endColumn === 1 && last > first) last -= 1;
		const range = new Range(first, 1, last, this.model.getLineMaxColumn(last));
		return { from: first, to: last, text: this.model.getValueInRange(range, LF) };
	}

	wordAt(pos: Pos): string | null {
		return this.model.getWordAtPosition({ lineNumber: pos.line, column: pos.character + 1 })?.word ?? null;
	}

	head(): Pos {
		const position = this.shownIn?.editor.getPosition() ?? this.viewState?.cursorState[0]?.position;
		return { line: position?.lineNumber ?? 1, character: (position?.column ?? 1) - 1 };
	}

	setDiagnostics(diagnostics: readonly LspDiagnostic[]): void {
		editor.setModelMarkers(
			this.model,
			"lsp",
			diagnostics.map(d => toMarker(d, this.model.getLineCount(), line => this.model.getLineMaxColumn(line) - 1)),
		);
	}

	setAttribution(marks: readonly LineMark[]): void {
		const lineCount = this.model.getLineCount();
		const placed = marks.filter(mark => mark.line >= 1 && mark.line <= lineCount);
		const ids = this.model.deltaDecorations(
			this.#attribution.map(mark => mark.id),
			placed.map(mark => ({
				range: new Range(mark.line, 1, mark.line, 1),
				options: {
					// A line typed at the edge of a marked one is not the agent's.
					stickiness: editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
					linesDecorationsClassName: "sh-ide-attr-bar",
					linesDecorationsTooltip: mark.tip,
				},
			})),
		);
		this.#attribution = ids.map((id, i) => ({ id, text: this.model.getLineContent(placed[i]!.line).trim() }));
	}

	dispose(): void {
		this.#subscription.dispose();
		docs.delete(this.model);
		this.model.dispose();
	}
}

class MonacoView implements EditorView {
	readonly engine = "monaco";
	doc: MonacoDoc | null = null;
	readonly editor: Editor;
	readonly #cleanups: (() => void)[] = [];
	#layout: ViewLayout | null = null;
	#minimap = false;

	constructor(
		readonly parent: HTMLElement,
		readonly hooks: () => EditorViewHooks,
	) {
		const theme = readTheme(parent);
		editor.defineTheme(THEME, theme.data);
		this.editor = editor.create(parent, {
			model: null,
			theme: THEME,
			automaticLayout: true,
			fontFamily: theme.fontFamily,
			fontSize: theme.fontSize,
			lineHeight: theme.lineHeight,
			minimap: { enabled: false },
			scrollBeyondLastLine: false,
			// The sheet clips overflow: widgets (hover, find, suggestions) are positioned against the page instead.
			fixedOverflowWidgets: true,
			renderLineHighlight: "line",
			occurrencesHighlight: "singleFile",
			matchBrackets: "always",
			bracketPairColorization: { enabled: true },
			folding: true,
			lineNumbersMinChars: 3,
			renderWhitespace: "selection",
			wordBasedSuggestions: "off",
			quickSuggestions: false,
			suggestOnTriggerCharacters: false,
			parameterHints: { enabled: false },
			links: false,
			colorDecorators: false,
			stickyScroll: { enabled: false },
			contextmenu: true,
			padding: { top: 6, bottom: 6 },
		});
		this.#cleanups.push(
			watchTheme(parent, () => {
				const next = readTheme(parent);
				editor.defineTheme(THEME, next.data);
				editor.setTheme(THEME);
				this.editor.updateOptions({
					fontFamily: next.fontFamily,
					fontSize: next.fontSize,
					lineHeight: next.lineHeight,
				});
				// A new code font changes the glyph widths Monaco measured.
				void document.fonts.ready.then(() => editor.remeasureFonts());
			}),
		);
		void document.fonts.ready.then(() => editor.remeasureFonts());
		this.#bind();
		const resize = new ResizeObserver(() => this.#updateMinimap());
		resize.observe(parent);
		this.#cleanups.push(() => resize.disconnect());
		this.#updateMinimap();
	}

	#bind(): void {
		const ed = this.editor;
		const at = (position: { lineNumber: number; column: number }): Pos => ({
			line: position.lineNumber,
			character: position.column - 1,
		});
		const definition = (): void => {
			if (this.doc !== null) this.hooks().definition(this.doc, this.doc.head());
		};
		const references = (): void => {
			if (this.doc !== null) this.hooks().references(this.doc, this.doc.head());
		};
		// `addCommand` outranks Monaco's own bindings and keeps the key from reaching the page.
		ed.addCommand(KeyCode.F12, definition);
		ed.addCommand(KeyMod.Shift | KeyCode.F12, references);
		ed.addCommand(KeyMod.CtrlCmd | KeyCode.KeyS, () => this.hooks().shortcut("save"));
		ed.addCommand(KeyMod.CtrlCmd | KeyCode.KeyP, () => this.hooks().shortcut("quick-open"));
		ed.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyF, () => this.hooks().shortcut("search-files"));
		ed.addAction({
			id: "omp.goToDefinition",
			label: "Go to Definition",
			contextMenuGroupId: "navigation",
			contextMenuOrder: 1,
			run: definition,
		});
		ed.addAction({
			id: "omp.findReferences",
			label: "Find All References",
			contextMenuGroupId: "navigation",
			contextMenuOrder: 2,
			run: references,
		});
		const click = ed.onMouseDown(event => {
			if (this.doc === null || !event.event.leftButton || !(event.event.metaKey || event.event.ctrlKey)) return;
			if (event.target.position === null) return;
			event.event.preventDefault();
			event.event.stopPropagation();
			this.hooks().definition(this.doc, at(event.target.position));
		});
		const cursor = ed.onDidChangeCursorSelection(() => {
			if (this.doc !== null && !this.doc.muted) this.hooks().changed(this.doc, false);
		});
		this.#cleanups.push(
			() => click.dispose(),
			() => cursor.dispose(),
		);
	}

	#updateMinimap(): void {
		const layout = this.#layout;
		const enabled = minimapShown(layout?.minimap ?? null, layout?.roomy === true, this.parent.clientWidth);
		if (enabled === this.#minimap) return;
		this.#minimap = enabled;
		this.editor.updateOptions({ minimap: { enabled } });
	}

	show(doc: EditorDoc | null): void {
		const next = doc as MonacoDoc | null;
		if (next === this.doc) return;
		if (this.doc !== null) {
			this.doc.viewState = this.editor.saveViewState();
			this.doc.shownIn = null;
		}
		this.doc = next;
		if (next === null) {
			this.editor.setModel(null);
			return;
		}
		// A read-only file keeps its cursor and selection, but phones should not raise the keyboard for it.
		this.editor.updateOptions({ readOnly: !next.writable, domReadOnly: !next.writable });
		next.shownIn = this;
		this.editor.setModel(next.model);
		if (next.viewState !== null) this.editor.restoreViewState(next.viewState);
	}

	reveal(pos: { line: number; character?: number }): void {
		const model = this.editor.getModel();
		if (model === null) return;
		const lineNumber = Math.min(Math.max(pos.line, 1), model.getLineCount());
		const column = Math.min(Math.max((pos.character ?? 0) + 1, 1), model.getLineMaxColumn(lineNumber));
		this.editor.setPosition({ lineNumber, column });
		this.editor.revealPositionInCenter({ lineNumber, column }, editor.ScrollType.Immediate);
	}

	focus(): void {
		this.editor.focus();
	}

	setLayout(layout: ViewLayout): void {
		const previous = this.#layout;
		this.#layout = layout;
		this.editor.updateOptions({
			fontSize: layout.fontSize,
			lineHeight: lineHeightFor(layout.fontSize),
			lineNumbers: layout.lineNumbers ? "on" : "off",
		});
		// New glyph sizes: Monaco measured the old ones.
		if (previous?.fontSize !== layout.fontSize) void document.fonts.ready.then(() => editor.remeasureFonts());
		this.#updateMinimap();
	}

	destroy(): void {
		for (const cleanup of this.#cleanups) cleanup();
		if (this.doc !== null) {
			this.doc.viewState = this.editor.saveViewState();
			this.doc.shownIn = null;
			this.doc = null;
		}
		this.editor.dispose();
	}
}

languages.registerHoverProvider("*", {
	async provideHover(model, position, token) {
		const doc = docs.get(model);
		const view = doc?.shownIn;
		const hooks = view?.hooks();
		if (doc === undefined || view == null || hooks === undefined || view.doc !== doc || hooks.hover === undefined)
			return null;
		const controller = new AbortController();
		token.onCancellationRequested(() => controller.abort());
		const answer = await hooks
			.hover(doc, { line: position.lineNumber, character: position.column - 1 }, controller.signal)
			.catch(() => null);
		if (answer === null || controller.signal.aborted) return null;
		const range = answer.range;
		return {
			range:
				range === undefined
					? undefined
					: new Range(range.start.line, range.start.character + 1, range.end.line, range.end.character + 1),
			contents: [{ value: answer.markdown }],
		};
	},
});

export const monacoEngine: EditorEngine = {
	name: "monaco",
	async loadLanguage(path: string): Promise<LoadedLanguage> {
		// Monaco fetches the Monarch tokenizer itself when a model first uses the language.
		const language = monacoLanguageOf(path);
		return { name: language?.name ?? null, handle: language?.id ?? "plaintext" };
	},
	createDoc(init: DocInit): EditorDoc {
		const crlf = init.crlf ?? init.text.includes("\r\n");
		const text = crlf ? init.text.replace(/\r?\n/g, "\r\n") : init.text;
		const uri = Uri.from({ scheme: "omp-file", path: `/${init.path}`, query: init.scope });
		editor.getModel(uri)?.dispose();
		const model = editor.createModel(text, init.language.handle as string, uri);
		const doc = new MonacoDoc(init.path, init.writable, crlf, model, toLf(init.text));
		doc.startFrom(init.unsaved);
		return doc;
	},
	createView(parent, hooks) {
		return new MonacoView(parent, hooks);
	},
};
