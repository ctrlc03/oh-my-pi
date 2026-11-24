import type { Token } from "@oh-my-pi/pi-utils/marked";
import { Marked } from "@oh-my-pi/pi-utils/marked";
import { listMayContinueAt } from "@oh-my-pi/pi-utils/marked-list";
import type { MouseEvent, ReactNode } from "react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type DiagramKind, diagramKindOf, isClosedFence } from "../../lib/diagrams";
import { isRelativeLink } from "../../lib/file-viewer";
import { escapeHtml } from "../../lib/format";
import { DiagramFigure } from "../diagram/DiagramFigure";
import { mathExtension } from "./math";

function unescapeHtml(raw: string): string {
	const parseCodePoint = (value: number): string => {
		if (Number.isFinite(value) && value >= 0 && value <= 0x10ffff) {
			try {
				return String.fromCodePoint(value);
			} catch {}
		}
		return "";
	};

	return raw.replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/gi, (match, entity) => {
		const lower = entity.toLowerCase();
		switch (lower) {
			case "nbsp":
				return " ";
			case "lt":
				return "<";
			case "gt":
				return ">";
			case "quot":
				return '"';
			case "apos":
				return "'";
			case "amp":
				return "&";
			default: {
				if (lower.startsWith("#x")) {
					return parseCodePoint(Number.parseInt(lower.slice(2), 16));
				}
				if (lower.startsWith("#")) {
					return parseCodePoint(Number(lower.slice(1)));
				}
				return match;
			}
		}
	});
}
function safeHref(href: string): string | null {
	const trimmed = href.trim();
	let protocol: string;
	try {
		// Resolve the scheme exactly as the browser will: the URL parser strips leading
		// C0 controls and embedded tab/newline that a text check would carry through.
		({ protocol } = new URL(trimmed, "https://relative.invalid/"));
	} catch {
		return null;
	}
	if (protocol === "https:" || protocol === "http:" || protocol === "mailto:") return trimmed;
	return null; // unknown scheme (javascript:, data:, …)
}

const md = new Marked({
	gfm: true,
	renderer: {
		// Raw HTML tokens (block + inline both arrive here) are escaped, never emitted.
		html({ text }) {
			const cleaned = text.replace(/<\/?(?:advisory|span|text)\b(?:\s[^>]*)?\s*\/?>/gi, "");
			if (cleaned === "") return "";
			return escapeHtml(unescapeHtml(cleaned));
		},
		// Fenced and indented code, wrapped with a copy button handled by `onCopyClick`. `data-lang` is the header's label.
		code({ text, lang, escaped, raw }) {
			const language = /^\S*/.exec(lang ?? "")?.[0] ?? "";
			const code = `${text.replace(/\n$/, "")}\n`;
			const cls = language ? ` class="language-${escapeHtml(language)}"` : "";
			// A closed diagram fence gets a placeholder that `MarkdownBody` replaces with the rendered diagram.
			const kind = isClosedFence(raw) ? diagramKindOf(language, text) : null;
			const diagram = kind === null ? "" : ` tr-diagram" data-diagram="${kind}`;
			return `<div class="tr-code${diagram}" data-lang="${escapeHtml(language || "text")}"><pre><code${cls}>${escaped ? code : escapeHtml(code)}</code></pre><button type="button" class="tr-copy" aria-label="Copy code"></button></div>\n`;
		},
		link({ href, title, tokens }) {
			const inner = this.parser.parseInline(tokens);
			const url = safeHref(href);
			if (url === null) return inner;
			const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
			return `<a href="${escapeHtml(url)}"${titleAttr} target="_blank" rel="noopener">${inner}</a>`;
		},
		// An image the document names relatively has no address the page can load; it is filled in by `MarkdownBody`
		// when the document's owner can resolve it. Anything with a scheme (`https:`, `data:`) renders as marked does.
		image({ href, title, text }) {
			if (!isRelativeLink(href)) return false;
			const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
			return `<img data-md-src="${escapeHtml(href)}" alt="${escapeHtml(text)}"${titleAttr}>`;
		},
	},
	breaks: true,
});
md.use(mathExtension);

function renderMarkdown(text: string): string {
	try {
		return md.parse(text, { async: false });
	} catch {
		return escapeHtml(text);
	}
}

/**
 * Delegated handler for the copy buttons the `code` renderer emits. Marks the
 * button `data-copied` briefly so CSS can confirm the copy.
 */
function onCopyClick(e: MouseEvent<HTMLDivElement>): void {
	const button = (e.target as Element).closest(".tr-copy");
	const code = button?.parentElement?.querySelector("code");
	if (!button || !code) return;
	void navigator.clipboard?.writeText(code.textContent ?? "").then(() => {
		button.setAttribute("data-copied", "");
		setTimeout(() => button.removeAttribute("data-copied"), 1500);
	});
}

interface DiagramMount {
	kind: DiagramKind;
	source: string;
	/** The element the figure is portaled into, inside its fence's placeholder. */
	host: HTMLElement;
}

/**
 * Where an image the document names relatively can be read from: a URL the page may load (an object URL of the
 * file's bytes), or null when the file cannot be shown. Only the Markdown viewer of a file gives one, since only it
 * knows where the file is; everywhere else relative images stay as their alt text.
 */
export type ResolveImage = (href: string) => Promise<string | null>;

export interface MarkdownProps {
	text: string;
	resolveImage?: ResolveImage;
}

/**
 * The rendered markup of a block. The `code` renderer leaves a placeholder (the plain code block) for each
 * closed diagram fence; once the markup is in the page, each placeholder gets a {@link DiagramFigure} portaled
 * into it, which draws the diagram and falls back to that same code block when it cannot.
 */
function MarkdownBody({ html, resolveImage }: { html: string; resolveImage?: ResolveImage }): ReactNode {
	const root = useRef<HTMLDivElement>(null);
	const [mounts, setMounts] = useState<readonly DiagramMount[]>([]);
	// React re-applies `innerHTML` whenever this object changes identity, which would wipe the portal hosts
	// appended below on the re-render `setMounts` triggers.
	const inner = useMemo(() => ({ __html: html }), [html]);
	useLayoutEffect(() => {
		const found: DiagramMount[] = [];
		for (const node of root.current?.querySelectorAll<HTMLElement>(".tr-diagram[data-diagram]") ?? []) {
			const kind = node.dataset.diagram === "excalidraw" ? "excalidraw" : "mermaid";
			const host = document.createElement("div");
			host.className = "tr-diagram-host";
			node.append(host);
			node.dataset.mounted = "";
			found.push({ kind, source: node.querySelector("code")?.textContent ?? "", host });
		}
		setMounts(prev => (prev.length === 0 && found.length === 0 ? prev : found));
	}, [html]);
	// Relative images carry no `src` until the owner of the document says where to read them from.
	useEffect(() => {
		if (resolveImage === undefined) return;
		let live = true;
		for (const img of root.current?.querySelectorAll<HTMLImageElement>("img[data-md-src]") ?? []) {
			void resolveImage(img.dataset.mdSrc ?? "").then(
				url => {
					if (!live) return;
					if (url === null) img.dataset.broken = "";
					else img.src = url;
				},
				() => {
					if (live) img.dataset.broken = "";
				},
			);
		}
		return () => {
			live = false;
		};
	}, [html, resolveImage]);
	return (
		<>
			<div ref={root} className="tr-md" onClick={onCopyClick} dangerouslySetInnerHTML={inner} />
			{mounts.map((mount, i) =>
				createPortal(<DiagramFigure kind={mount.kind} source={mount.source} />, mount.host, String(i)),
			)}
		</>
	);
}

export const Markdown = memo(function Markdown({ text, resolveImage }: MarkdownProps): ReactNode {
	const html = useMemo(() => renderMarkdown(text), [text]);
	return <MarkdownBody html={html} resolveImage={resolveImage} />;
});

/**
 * Rendered leading blocks of a streaming text: `source` is the (tab-expanded)
 * text they cover, ending on a stable block boundary, and `html` their markup.
 */
export interface FrozenMarkdownPrefix {
	readonly source: string;
	readonly html: string;
}

const NO_PREFIX: FrozenMarkdownPrefix = { source: "", html: "" };

/**
 * An own-line display-math opener. A closer appended later turns the text from
 * it on into one block across blank lines, so nothing at or past it freezes.
 */
const MATH_OPENER_LINE = /^ {0,3}(?:\$\$|\\\[)[ \t]*$/m;
/** A whitespace-only line from the sticky offset, capturing its terminator ("\n", or "" at end of text). */
const WHITESPACE_LINE = /[^\S\n]*(\n|$)/y;

/**
 * Number of leading `tokens` (lexed from `src`) that end on a stable block
 * boundary: a blank-line break that no append to `src` can move, so that
 * `lex(src) = lex(head) ++ lex(tail)` for the current text and every
 * append-only extension of it. 0 when there is none.
 */
function stableTokenCount(src: string, tokens: readonly Token[]): { count: number; end: number } {
	const opener = MATH_OPENER_LINE.exec(src);
	const mathLimit = opener === null ? src.length : opener.index;
	let pos = 0;
	let count = 0;
	let end = 0;
	for (let i = 0; i < tokens.length; i++) {
		const raw = tokens[i]!.raw;
		const tokenEnd = pos + raw.length;
		if (tokenEnd > mathLimit) break;
		// The break must be followed by real block content: at end of text the
		// next line is unknown; a leading space or newline, or a line of other
		// whitespace, joins the blank run in front of the cut.
		if (raw.endsWith("\n\n") && tokenEnd < src.length) {
			const next = src.charCodeAt(tokenEnd);
			WHITESPACE_LINE.lastIndex = tokenEnd;
			const prev = i > 0 ? tokens[i - 1] : undefined;
			if (
				next !== 0x20 &&
				next !== 0x0a &&
				WHITESPACE_LINE.exec(src) === null &&
				(prev?.type !== "list" || !listMayContinueAt(src, tokenEnd, prev.raw))
			) {
				count = i + 1;
				end = tokenEnd;
			}
		}
		pos = tokenEnd;
	}
	return { count, end };
}

/**
 * Renders streaming Markdown `text`, reusing `prefix` (the result of the
 * previous call for an earlier version of the text) when `text` extends it.
 * Only the text after the prefix is lexed and parsed; blocks of it that end on
 * a stable boundary join the returned prefix. The markup equals
 * `md.parse(text)` byte for byte: anything the split cannot reproduce exactly
 * (reference definitions, carriage returns) renders the whole text instead.
 */
export function renderStreamingMarkdown(
	text: string,
	prefix: FrozenMarkdownPrefix,
): { html: string; prefix: FrozenMarkdownPrefix } {
	// `\r` rewrites line structure under marked's normalization; bail out.
	if (text.includes("\r")) return { html: renderMarkdown(text), prefix: NO_PREFIX };
	// Tabs expand to four spaces (as marked's own normalization does), so token
	// raws tile `src` exactly.
	const src = text.includes("\t") ? text.replaceAll("\t", "    ") : text;
	const base = src.length > prefix.source.length && src.startsWith(prefix.source) ? prefix : NO_PREFIX;
	const rest = base.source.length === 0 ? src : src.slice(base.source.length);
	try {
		const tokens = md.lexer(rest);
		// A reference definition resolves links anywhere, including the frozen
		// prefix, which was lexed without it; with no prefix, `tokens` already
		// lexed the whole text with its definitions.
		for (const _label in tokens.links) {
			return { html: base === NO_PREFIX ? md.parser(tokens) : renderMarkdown(text), prefix: NO_PREFIX };
		}
		const { count, end } = stableTokenCount(rest, tokens);
		if (count === 0) return { html: base.html + md.parser(tokens), prefix: base };
		const frozen: FrozenMarkdownPrefix = {
			source: src.slice(0, base.source.length + end),
			html: base.html + md.parser(tokens.slice(0, count)),
		};
		return { html: frozen.html + md.parser(tokens.slice(count)), prefix: frozen };
	} catch {
		return { html: renderMarkdown(text), prefix: NO_PREFIX };
	}
}

/** The frozen prefix a {@link StreamingMarkdown} element currently shows and the child nodes it built. */
interface AppliedFrozen {
	prefix: FrozenMarkdownPrefix;
	nodeCount: number;
}

/**
 * {@link Markdown} for a block that is still streaming: settled leading
 * blocks are rendered once and reused, so each token re-parses only the open
 * tail instead of the whole growing block. Output is identical to
 * {@link Markdown} for the same text.
 *
 * The DOM follows the same split: frozen blocks are parsed into nodes once
 * and kept; each update replaces only the tail's nodes. The container keeps
 * the blocks as direct children, exactly as {@link Markdown} does.
 */
export const StreamingMarkdown = memo(function StreamingMarkdown({ text }: { text: string }): ReactNode {
	const prefixRef = useRef(NO_PREFIX);
	const rootRef = useRef<HTMLDivElement>(null);
	// Unknown after the initial markup; the first update rebuilds.
	const appliedRef = useRef<AppliedFrozen | null>(null);
	// React owns only the initial markup. It re-applies `dangerouslySetInnerHTML` whenever the
	// prop object changes identity, so the object itself must stay constant across renders.
	const [initialHtml] = useState(() => {
		const rendered = renderStreamingMarkdown(text, NO_PREFIX);
		prefixRef.current = rendered.prefix;
		return { __html: rendered.html };
	});
	const shownTextRef = useRef(text);
	useLayoutEffect(() => {
		const root = rootRef.current;
		if (root === null || text === shownTextRef.current) return;
		shownTextRef.current = text;
		const rendered = renderStreamingMarkdown(text, prefixRef.current);
		const prefix = rendered.prefix;
		prefixRef.current = prefix;
		const applied = appliedRef.current;
		if (applied !== null && (prefix === applied.prefix || prefix.html.startsWith(applied.prefix.html))) {
			while (root.childNodes.length > applied.nodeCount) root.lastChild!.remove();
			if (prefix !== applied.prefix) {
				root.insertAdjacentHTML("beforeend", prefix.html.slice(applied.prefix.html.length));
				appliedRef.current = { prefix, nodeCount: root.childNodes.length };
			}
		} else {
			root.innerHTML = prefix.html;
			appliedRef.current = { prefix, nodeCount: root.childNodes.length };
		}
		// `rendered.html` always starts with the frozen prefix's markup.
		root.insertAdjacentHTML("beforeend", rendered.html.slice(prefix.html.length));
	}, [text]);
	return <div ref={rootRef} className="tr-md" dangerouslySetInnerHTML={initialHtml} />;
});
