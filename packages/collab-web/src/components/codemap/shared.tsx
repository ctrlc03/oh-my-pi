import { Braces, FileCode, Folder } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useSyncExternalStore } from "react";
import type { CodemapFocus, CodemapNode } from "../../lib/companion";

/** Phones: bottom sheet, stacked lists instead of curves. */
export const PHONE_QUERY = "(max-width: 640px)";
/** Wide screens: the folder Map tab is offered (and is the default). */
export const WIDE_QUERY = "(min-width: 901px)";

/** Live `matchMedia` match, re-rendering when it flips. */
export function useMedia(query: string): boolean {
	const subscribe = useCallback(
		(onChange: () => void) => {
			const list = matchMedia(query);
			list.addEventListener("change", onChange);
			return () => list.removeEventListener("change", onChange);
		},
		[query],
	);
	return useSyncExternalStore(subscribe, () => matchMedia(query).matches);
}

const KNOWN_LANGS: Record<string, true> = { rust: true, sol: true, noir: true, ts: true, js: true, py: true, go: true };

/** The `--lang-*` token colouring a language; unknown languages fall back to `other`. */
export function langColor(lang: string): string {
	return `var(--lang-${Object.hasOwn(KNOWN_LANGS, lang) ? lang : "other"})`;
}

/** Stroke width in pixels for a link of `weight` references: log-scaled so a hub does not drown the rest. */
export function strokeWidth(weight: number): number {
	return Math.min(5, 1 + Math.log2(Math.max(1, weight)) * 0.8);
}

/** The request focus that centres the view on `node`. */
export function focusOf(node: CodemapNode): CodemapFocus {
	if (node.kind === "symbol") return { kind: "symbol", path: node.path, name: node.label, line: node.line ?? 1 };
	return { kind: node.kind, path: node.path };
}

/** Whether two foci select the same thing (so re-selecting it should not push history). */
export function sameFocus(a: CodemapFocus, b: CodemapFocus): boolean {
	if (a.kind === "symbol") return b.kind === "symbol" && a.path === b.path && a.name === b.name && a.line === b.line;
	return a.kind === b.kind && a.path === b.path;
}

/** Secondary line of a node: its path, with the line for symbols. */
export function nodeSub(node: CodemapNode): string {
	if (node.kind === "symbol") return `${node.path}:${node.line ?? 1}`;
	return node.path || "repository root";
}

/** Folder, file and symbol glyph, tinted by the node's language. */
export function NodeIcon({ node, size = 15 }: { node: CodemapNode; size?: number }): ReactNode {
	const Icon = node.kind === "dir" ? Folder : node.kind === "file" ? FileCode : Braces;
	return <Icon size={size} className="sh-cm-icon" style={{ color: langColor(node.lang) }} aria-hidden />;
}

/** "12 files · 340 symbols", "340 symbols" or "" for what a folder or file holds. */
export function nodeCounts(node: CodemapNode): string {
	const parts: string[] = [];
	if (node.files !== undefined) parts.push(`${node.files} file${node.files === 1 ? "" : "s"}`);
	if (node.symbols !== undefined) parts.push(`${node.symbols} symbol${node.symbols === 1 ? "" : "s"}`);
	return parts.join(" · ");
}

export interface NodeRowProps {
	node: CodemapNode;
	onPick(node: CodemapNode): void;
	/** Relationship to the focus, e.g. "decoded by". */
	chip?: string;
	/** The relationship crosses languages or goes through an event. */
	bridge?: boolean;
	/** References behind a folder or file link. */
	weight?: number;
	/** The node lives in the focus file: show only its line, not the path again. */
	local?: boolean;
}

/** One clickable node in a list: icon, name, where it lives, and how it relates to the focus. */
export function NodeRow({ node, onPick, chip, bridge, weight, local }: NodeRowProps): ReactNode {
	const counts = weight === undefined && node.kind !== "symbol" ? nodeCounts(node) : "";
	return (
		<button type="button" className="sh-cm-row" onClick={() => onPick(node)}>
			<NodeIcon node={node} />
			<span className="sh-cm-row-text">
				<span className="sh-cm-row-label">{node.label}</span>
				<span className="sh-cm-row-sub">{local ? `line ${node.line ?? 1}` : nodeSub(node)}</span>
			</span>
			{node.symbolKind && <span className="sh-cm-kind">{node.symbolKind}</span>}
			{chip && <span className={bridge ? "sh-cm-chip sh-cm-chip-bridge" : "sh-cm-chip"}>{chip}</span>}
			{counts && <span className="sh-cm-counts">{counts}</span>}
			{weight !== undefined && (
				<span className="sh-cm-weight" title={`${weight} reference${weight === 1 ? "" : "s"}`}>
					{weight}
				</span>
			)}
		</button>
	);
}
