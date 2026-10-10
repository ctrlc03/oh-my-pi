/**
 * CodeMirror setup for the editor sheet: one extension set shared by every tab
 * (each tab keeps its own `EditorState`, so undo history survives tab switches),
 * colours from the `--syn-*` tokens, and a line highlight for edits that arrived
 * from disk.
 */
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import type { Extension, Range } from "@codemirror/state";
import { Annotation, EditorState, StateEffect, StateField } from "@codemirror/state";
import type { DecorationSet, KeyBinding } from "@codemirror/view";
import {
	Decoration,
	drawSelection,
	EditorView,
	highlightActiveLine,
	highlightActiveLineGutter,
	highlightSpecialChars,
	keymap,
	lineNumbers,
} from "@codemirror/view";
import { tagHighlighter, tags as t } from "@lezer/highlight";

/** Token classes coloured by ide.css from the `--syn-*` tokens; the most specific tag wins. */
const highlighter = tagHighlighter([
	{ tag: [t.keyword, t.tagName, t.self], class: "sh-ide-kw" },
	{ tag: [t.string, t.regexp, t.character, t.special(t.string)], class: "sh-ide-str" },
	{ tag: [t.number, t.bool, t.null, t.atom], class: "sh-ide-num" },
	{ tag: t.comment, class: "sh-ide-comment" },
	{ tag: [t.typeName, t.className, t.namespace, t.standard(t.name)], class: "sh-ide-type" },
	{
		tag: [
			t.function(t.variableName),
			t.function(t.propertyName),
			t.function(t.definition(t.variableName)),
			t.macroName,
		],
		class: "sh-ide-fn",
	},
	{ tag: [t.attributeName, t.propertyName, t.labelName], class: "sh-ide-attr" },
	{ tag: [t.meta, t.annotation, t.processingInstruction, t.heading, t.link], class: "sh-ide-meta" },
	{ tag: t.strong, class: "sh-ide-strong" },
	{ tag: t.emphasis, class: "sh-ide-em" },
	{ tag: t.invalid, class: "sh-ide-invalid" },
]);

/** Marks a transaction that brings in the text on disk rather than the user's typing. */
export const fromDisk = Annotation.define<true>();

/** Highlight these 1-based lines of the new document (an empty list clears the highlight). */
export const markChanged = StateEffect.define<number[]>();

const changedLine = Decoration.line({ class: "sh-ide-changed" });

/** Lines the last update from disk touched; cleared when the user edits. */
const changedLines = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(marks, tr) {
		let next = tr.docChanged && tr.annotation(fromDisk) === undefined ? Decoration.none : marks.map(tr.changes);
		for (const effect of tr.effects) {
			if (!effect.is(markChanged)) continue;
			const doc = tr.state.doc;
			const ranges: Range<Decoration>[] = [];
			for (const n of effect.value) if (n >= 1 && n <= doc.lines) ranges.push(changedLine.range(doc.line(n).from));
			next = Decoration.set(ranges);
		}
		return next;
	},
	provide: field => EditorView.decorations.from(field),
});

/** Editor chrome from the app's tokens; follows the light and dark palettes with no editor-side switch. */
const theme = EditorView.theme({
	"&": { height: "100%", color: "var(--fg)", backgroundColor: "var(--bg-inset)" },
	"&.cm-focused": { outline: "none" },
	".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55" },
	".cm-content": { caretColor: "var(--fg)" },
	".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg)" },
	"&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": {
		backgroundColor: "color-mix(in srgb, var(--accent) 30%, transparent)",
	},
	".cm-gutters": { color: "var(--fg-faint)", backgroundColor: "var(--bg-inset)", border: "none" },
	".cm-activeLine": { backgroundColor: "var(--hover)" },
	".cm-activeLineGutter": { backgroundColor: "var(--hover)", color: "var(--fg-muted)" },
	".cm-foldPlaceholder": { color: "var(--fg-muted)", backgroundColor: "var(--bg-raised)", border: "none" },
	".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
		backgroundColor: "color-mix(in srgb, var(--accent) 22%, transparent)",
	},
	".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--accent) 14%, transparent)" },
	".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--warn) 30%, transparent)" },
	".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--warn) 55%, transparent)" },
	".cm-panels": { color: "var(--fg)", backgroundColor: "var(--bg-raised)" },
	".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
	".cm-panel.cm-search": { padding: "6px 28px 6px 8px", fontFamily: "var(--font-ui)" },
	".cm-panel.cm-search label": { fontSize: "12px", color: "var(--fg-muted)" },
	".cm-textfield": {
		color: "var(--fg)",
		backgroundColor: "var(--bg-inset)",
		border: "1px solid var(--border-strong)",
		borderRadius: "var(--radius-sm)",
		padding: "3px 6px",
	},
	".cm-button": {
		color: "var(--fg)",
		backgroundColor: "var(--bg-overlay)",
		backgroundImage: "none",
		border: "1px solid var(--border-strong)",
		borderRadius: "var(--radius-sm)",
		padding: "3px 8px",
	},
	".cm-panel.cm-search [name=close]": { color: "var(--fg-muted)", fontSize: "18px" },
	".sh-ide-changed": {
		backgroundColor: "color-mix(in srgb, var(--ok) 13%, transparent)",
		boxShadow: "inset 3px 0 var(--ok)",
	},
});

/** Save (Cmd/Ctrl+S) is bound on the sheet, so it also works with the focus outside the editor. */
export interface EditorHooks {
	/** F12, or Cmd/Ctrl+click on a word. */
	definition(pos: number): void;
	/** The document or selection changed. */
	changed(view: EditorView): void;
}

/** Shared by every tab of one sheet; `hooks` is read on each event, so it may be a ref's current value. */
export function baseExtensions(hooks: () => EditorHooks): Extension[] {
	const actions: KeyBinding[] = [
		{
			key: "F12",
			run: view => {
				hooks().definition(view.state.selection.main.head);
				return true;
			},
		},
	];
	return [
		lineNumbers(),
		highlightActiveLineGutter(),
		foldGutter(),
		highlightSpecialChars(),
		history(),
		drawSelection(),
		indentOnInput(),
		bracketMatching(),
		closeBrackets(),
		highlightActiveLine(),
		highlightSelectionMatches(),
		search({ top: true }),
		syntaxHighlighting(highlighter),
		theme,
		changedLines,
		EditorState.allowMultipleSelections.of(true),
		keymap.of([
			...actions,
			...closeBracketsKeymap,
			...defaultKeymap,
			...searchKeymap,
			...historyKeymap,
			...foldKeymap,
			indentWithTab,
		]),
		EditorView.domEventHandlers({
			mousedown(event, view) {
				if (!(event.metaKey || event.ctrlKey) || event.button !== 0) return false;
				const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
				if (pos === null) return false;
				event.preventDefault();
				hooks().definition(pos);
				return true;
			},
		}),
		EditorView.updateListener.of(update => {
			if (update.docChanged || update.selectionSet) hooks().changed(update.view);
		}),
	];
}

/**
 * Per-tab extensions: the language, whether the file may be edited, and its line
 * break (a CRLF file is saved with CRLF; others with LF).
 */
export function tabExtensions(language: Extension | null, writable: boolean, crlf: boolean): Extension[] {
	const out: Extension[] = [EditorState.readOnly.of(!writable)];
	if (language !== null) out.push(language);
	if (crlf) out.push(EditorState.lineSeparator.of("\r\n"));
	// A read-only file keeps its cursor and selection, but phones should not raise the keyboard for it.
	if (!writable) out.push(EditorView.contentAttributes.of({ inputmode: "none" }));
	return out;
}

/** The identifier at `pos`, or null outside one. */
export function wordAt(state: EditorState, pos: number): string | null {
	const range = state.wordAt(pos);
	return range === null ? null : state.sliceDoc(range.from, range.to);
}

/** The whole lines the main selection touches (the cursor line when nothing is selected), 1-based, with their text. */
export function selectedLines(state: EditorState): { from: number; to: number; text: string } {
	const { from, to } = state.selection.main;
	const first = state.doc.lineAt(from);
	// A selection ending at the start of a line does not include that line.
	const last = state.doc.lineAt(to > from && state.doc.lineAt(to).from === to ? to - 1 : to);
	return { from: first.number, to: last.number, text: state.doc.sliceString(first.from, last.to) };
}
