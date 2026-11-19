/**
 * The CodeMirror engine: `editor.ts`'s extensions behind the editor interface. A document is one
 * `EditorState` (so undo history survives tab switches); one `EditorView` shows whichever is active.
 */
import type { Extension, Text, TransactionSpec } from "@codemirror/state";
import { EditorState, Transaction } from "@codemirror/state";
import { setDiagnostics } from "@codemirror/lint";
import type { Tooltip } from "@codemirror/view";
import { EditorView } from "@codemirror/view";
import type { LineMark } from "../../../lib/line-attribution";
import type { LspDiagnostic } from "../../../lib/repo-intel";
import { importChunk } from "../../../lib/stale-build";
import { baseExtensions, fromDisk, markAgentLines, markChanged, selectedLines, tabExtensions, wordAt } from "../editor";
import { languageFor } from "../languages";
import { diffText } from "../text-diff";
import { renderHover } from "./hover-markdown";
import { offsetToPosition, positionToOffset, toRangeDiagnostic } from "./lsp-map";
import type {
	CursorInfo,
	DocInit,
	DocSnapshot,
	EditorDoc,
	EditorEngine,
	EditorView as EngineView,
	EditorViewHooks,
	LineSelection,
	LoadedLanguage,
	Pos,
} from "./types";

/** The view showing each CodeMirror view's document; the shared extensions find their owner through it. */
const owners = new WeakMap<EditorView, CmView>();

const base = baseExtensions(() => ({
	definition(view, offset) {
		const owner = owners.get(view);
		if (owner?.doc != null) owner.hooks().definition(owner.doc, offsetToPosition(view.state.doc, offset));
	},
	references(view, offset) {
		const owner = owners.get(view);
		if (owner?.doc != null) owner.hooks().references(owner.doc, offsetToPosition(view.state.doc, offset));
	},
	changed(view, text) {
		const owner = owners.get(view);
		if (owner?.doc != null && !owner.doc.muted) owner.hooks().changed(owner.doc, text);
	},
	hover(view, offset) {
		return owners.get(view)?.hoverAt(offset) ?? null;
	},
	attribution(view, tip) {
		const owner = owners.get(view);
		if (owner?.doc != null) owner.hooks().attribution?.(owner.doc, tip);
	},
}));

const toLf = (text: string): string => text.replace(/\r\n/g, "\n");

class CmDoc implements EditorDoc {
	readonly engine = "codemirror";
	readonly crlf: boolean;
	/** Set while the sheet brings disk text in: the view's events are its own business then. */
	muted = false;
	/** The view this document is shown in, whose state is the live one. */
	shownIn: EditorView | null = null;
	#stored: EditorState;
	#clean: Text;

	constructor(
		readonly path: string,
		readonly writable: boolean,
		state: EditorState,
		crlf: boolean,
	) {
		this.#stored = state;
		this.#clean = state.doc;
		this.crlf = crlf;
	}

	get state(): EditorState {
		return this.shownIn?.state ?? this.#stored;
	}

	set state(state: EditorState) {
		this.#stored = state;
	}

	/** Re-baseline: the text being edited from is `doc`. */
	startFrom(unsaved: string | undefined): void {
		this.#clean = this.state.doc;
		if (unsaved === undefined || unsaved === toLf(this.#clean.toString())) return;
		const insert = this.crlf ? unsaved.replace(/\n/g, "\r\n") : unsaved;
		this.update({ changes: { from: 0, to: this.state.doc.length, insert } });
	}

	update(spec: TransactionSpec): void {
		if (this.shownIn !== null) this.shownIn.dispatch(spec);
		else this.#stored = this.#stored.update(spec).state;
	}

	text(): string {
		return this.state.doc.toString();
	}

	isDirty(): boolean {
		return !this.state.doc.eq(this.#clean);
	}

	cleanText(): string {
		return this.#clean.toString();
	}

	snapshot(): DocSnapshot {
		return { text: this.state.sliceDoc(), mark: this.state.doc };
	}

	markClean(snapshot?: DocSnapshot): void {
		this.#clean = snapshot === undefined ? this.state.doc : (snapshot.mark as Text);
	}

	applyDisk(text: string, options: { mark: boolean; undoable: boolean }): number[] {
		const { edits, changedLines } = diffText(this.text(), toLf(text));
		this.muted = true;
		try {
			this.update({
				changes: edits,
				effects: markChanged.of(options.mark ? changedLines : []),
				annotations: [fromDisk.of(true), Transaction.addToHistory.of(options.undoable)],
			});
		} finally {
			this.muted = false;
		}
		this.#clean = this.state.doc;
		return changedLines;
	}

	cursor(): CursorInfo {
		const { head, from, to } = this.state.selection.main;
		const line = this.state.doc.lineAt(head);
		return { line: line.number, col: head - line.from + 1, selected: to - from };
	}

	selectedLines(): LineSelection {
		return selectedLines(this.state);
	}

	wordAt(pos: Pos): string | null {
		return wordAt(this.state, positionToOffset(this.state.doc, pos));
	}

	head(): Pos {
		return offsetToPosition(this.state.doc, this.state.selection.main.head);
	}

	setDiagnostics(diagnostics: readonly LspDiagnostic[]): void {
		const doc = this.state.doc;
		this.update(
			setDiagnostics(
				this.state,
				diagnostics.map(d => toRangeDiagnostic(d, doc)),
			),
		);
	}

	setAttribution(marks: readonly LineMark[]): void {
		this.update({ effects: markAgentLines.of(marks.map(({ line, tip }) => ({ line, tip }))) });
	}

	dispose(): void {}
}

function emptyState(): EditorState {
	return EditorState.create({ extensions: base });
}

class CmView implements EngineView {
	readonly engine = "codemirror";
	doc: CmDoc | null = null;
	readonly #view: EditorView;
	#hover: AbortController | null = null;

	constructor(
		parent: HTMLElement,
		readonly hooks: () => EditorViewHooks,
	) {
		this.#view = new EditorView({ parent, state: emptyState() });
		owners.set(this.#view, this);
	}

	show(doc: EditorDoc | null): void {
		const next = doc as CmDoc | null;
		if (next === this.doc) return;
		if (this.doc !== null) {
			this.doc.state = this.#view.state;
			this.doc.shownIn = null;
		}
		this.doc = next;
		this.#hover?.abort();
		if (next === null) {
			this.#view.setState(emptyState());
			return;
		}
		this.#view.setState(next.state);
		next.shownIn = this.#view;
	}

	reveal(pos: { line: number; character?: number }): void {
		const doc = this.#view.state.doc;
		const line = doc.line(Math.min(Math.max(pos.line, 1), doc.lines));
		const at = line.from + Math.min(Math.max(pos.character ?? 0, 0), line.length);
		this.#view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: "center" }) });
	}

	focus(): void {
		this.#view.focus();
	}

	/** The font size and the line numbers are the sheet's CSS (`ide.css`); the glyphs just changed size. */
	setLayout(): void {
		this.#view.requestMeasure();
	}

	/** The language server's hover for the character at `offset`, as CodeMirror's tooltip. */
	hoverAt(offset: number): Promise<Tooltip | null> | null {
		const doc = this.doc;
		const hooks = this.hooks();
		if (doc === null || hooks.hover === undefined) return null;
		this.#hover?.abort();
		const controller = new AbortController();
		this.#hover = controller;
		const state = doc.state;
		return hooks.hover(doc, offsetToPosition(state.doc, offset), controller.signal).then(
			answer => {
				if (answer === null || controller.signal.aborted || this.doc !== doc) return null;
				const word = state.wordAt(offset);
				const from =
					answer.range === undefined ? (word?.from ?? offset) : positionToOffset(state.doc, answer.range.start);
				const to =
					answer.range === undefined ? (word?.to ?? offset) : positionToOffset(state.doc, answer.range.end);
				return {
					pos: Math.min(from, offset),
					end: Math.max(to, offset),
					above: true,
					create: () => renderHover(answer.markdown),
				};
			},
			() => null,
		);
	}

	destroy(): void {
		this.#hover?.abort();
		if (this.doc !== null) {
			this.doc.state = this.#view.state;
			this.doc.shownIn = null;
			this.doc = null;
		}
		this.#view.destroy();
	}
}

export const codemirrorEngine: EditorEngine = {
	name: "codemirror",
	async loadLanguage(path: string): Promise<LoadedLanguage> {
		const entry = languageFor(path);
		if (entry === null) return { name: null, handle: null };
		const handle = await importChunk(() => entry.load()).catch(() => null);
		return { name: entry.name, handle };
	},
	createDoc(init: DocInit): EditorDoc {
		const crlf = init.crlf ?? init.text.includes("\r\n");
		const text = crlf ? init.text.replace(/\r?\n/g, "\r\n") : init.text;
		const state = EditorState.create({
			doc: text,
			extensions: [base, tabExtensions(init.language.handle as Extension | null, init.writable, crlf)],
		});
		const doc = new CmDoc(init.path, init.writable, state, crlf);
		doc.startFrom(init.unsaved);
		return doc;
	},
	createView(parent, hooks) {
		return new CmView(parent, hooks);
	},
};
