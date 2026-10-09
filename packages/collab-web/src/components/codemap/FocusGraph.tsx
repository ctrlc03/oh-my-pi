import { FileText } from "lucide-react";
import type { ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import type { CodemapLink, CodemapNode, CodemapView } from "../../lib/companion";
import { nodeCounts, NodeIcon, NodeRow, nodeSub, PHONE_QUERY, strokeWidth, useMedia } from "./shared";

export interface FocusGraphProps {
	view: CodemapView;
	/** Re-centre the map on `node`. */
	onFocus(node: CodemapNode): void;
	onOpenFile(path: string, line?: number): void;
}

/** A measured curve from a link row to the focus card. */
interface Curve {
	key: string;
	d: string;
	width: number;
	bridge: boolean;
}

/**
 * The neighbourhood of one focus: what uses it on the left, what it uses on the right, with
 * curves drawn between measured DOM boxes on wide screens and plain stacked lists on phones.
 */
export function FocusGraph({ view, onFocus, onOpenFile }: FocusGraphProps): ReactNode {
	const stacked = useMedia(PHONE_QUERY);
	const graph = useRef<HTMLDivElement>(null);
	const card = useRef<HTMLElement>(null);
	const [curves, setCurves] = useState<Curve[]>([]);
	const symbol = view.focus.kind === "symbol";
	const childrenTitle = view.focus.kind === "dir" ? "Contents" : symbol ? "Members" : "Symbols";

	// Curves are measured from the laid-out rows, so they follow wrapping, scrolling
	// containers and window resizes without the CSS having to know about them.
	useLayoutEffect(() => {
		const root = graph.current;
		const target = card.current;
		if (stacked || !root || !target) return;
		const measure = (): void => {
			const base = root.getBoundingClientRect();
			const hub = target.getBoundingClientRect();
			const rows = [...root.querySelectorAll<HTMLElement>("[data-link]")];
			const perSide = { up: view.upstream.length, down: view.downstream.length };
			const next: Curve[] = [];
			for (const row of rows) {
				const side = row.dataset.link === "up" ? "up" : "down";
				const index = Number(row.dataset.index);
				const link = (side === "up" ? view.upstream : view.downstream)[index];
				if (!link) continue;
				const box = row.getBoundingClientRect();
				// Spread the landing points along the card edge so curves do not pile into one spot.
				const slot = (index + 0.5) / perSide[side];
				const hubY = hub.top - base.top + hub.height * (0.12 + 0.76 * slot);
				const rowY = box.top - base.top + box.height / 2;
				const fromX = side === "up" ? box.right - base.left : hub.right - base.left;
				const toX = side === "up" ? hub.left - base.left : box.left - base.left;
				const fromY = side === "up" ? rowY : hubY;
				const toY = side === "up" ? hubY : rowY;
				const mid = (fromX + toX) / 2;
				next.push({
					key: `${side}:${index}`,
					d: `M${fromX} ${fromY} C${mid} ${fromY} ${mid} ${toY} ${toX} ${toY}`,
					width: strokeWidth(link.weight),
					bridge: link.bridge,
				});
			}
			setCurves(next);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(root);
		observer.observe(target);
		return () => observer.disconnect();
	}, [view, stacked]);

	return (
		<div className="sh-cm-focus">
			<div className="sh-cm-graph" ref={graph}>
				{!stacked && (
					<svg className="sh-cm-curves" aria-hidden>
						{curves.map(c => (
							<path
								key={c.key}
								d={c.d}
								strokeWidth={c.width}
								className={c.bridge ? "sh-cm-curve sh-cm-curve-bridge" : "sh-cm-curve"}
							/>
						))}
					</svg>
				)}
				<LinkColumn
					side="up"
					title={symbol ? "Upstream" : "Used by"}
					links={view.upstream}
					more={view.moreUpstream}
					symbol={symbol}
					stacked={stacked}
					onFocus={onFocus}
				/>
				<section className="sh-cm-card" ref={card} aria-label="focus">
					<div className="sh-cm-card-head">
						<NodeIcon node={view.focus} size={18} />
						<span className="sh-cm-card-title">{view.focus.label}</span>
						{view.focus.symbolKind && <span className="sh-cm-kind">{view.focus.symbolKind}</span>}
					</div>
					<div className="sh-cm-card-path">{nodeSub(view.focus)}</div>
					{view.focus.signature && <pre className="sh-cm-card-sig">{view.focus.signature}</pre>}
					{view.focus.doc && <p className="sh-cm-card-doc">{view.focus.doc}</p>}
					{view.focus.kind !== "symbol" && <div className="sh-cm-card-counts">{nodeCounts(view.focus)}</div>}
					{view.focus.kind !== "dir" && (
						<button
							type="button"
							className="sh-btn sh-cm-card-action"
							onClick={() => onOpenFile(view.focus.path, view.focus.line)}
						>
							<FileText size={14} /> {symbol ? "View source" : "View file"}
						</button>
					)}
				</section>
				<LinkColumn
					side="down"
					title={symbol ? "Downstream" : "Uses"}
					links={view.downstream}
					more={view.moreDownstream}
					symbol={symbol}
					stacked={stacked}
					onFocus={onFocus}
				/>
			</div>
			{view.children.length > 0 && (
				<section className="sh-cm-children" aria-label={childrenTitle}>
					<h3 className="sh-cm-col-title">
						{childrenTitle} <span className="sh-cm-count">{view.children.length}</span>
					</h3>
					<ul className="sh-cm-list">
						{view.children.map(child => (
							<li key={`${child.kind}:${child.path}:${child.label}:${child.line ?? 0}`}>
								<NodeRow node={child} onPick={onFocus} local={view.focus.kind !== "dir"} />
							</li>
						))}
					</ul>
				</section>
			)}
		</div>
	);
}

interface LinkColumnProps {
	side: "up" | "down";
	title: string;
	links: CodemapLink[];
	more: number;
	/** Symbol links always show their relationship; folder and file links only when they cross languages. */
	symbol: boolean;
	/** Phone layout: an empty column is left out rather than kept as a placeholder beside the card. */
	stacked: boolean;
	onFocus(node: CodemapNode): void;
}

function LinkColumn({ side, title, links, more, symbol, stacked, onFocus }: LinkColumnProps): ReactNode {
	if (stacked && links.length === 0 && more === 0) return null;
	return (
		<section className={`sh-cm-col sh-cm-col-${side}`} aria-label={title}>
			<h3 className="sh-cm-col-title">
				{title} <span className="sh-cm-count">{links.length + more}</span>
			</h3>
			{links.length === 0 ? (
				<div className="sh-cm-none">None</div>
			) : (
				<ul className="sh-cm-list">
					{links.map((link, index) => (
						<li
							key={`${link.node.kind}:${link.node.path}:${link.node.label}:${link.label}`}
							data-link={side}
							data-index={index}
						>
							<NodeRow
								node={link.node}
								onPick={onFocus}
								chip={symbol || link.bridge ? link.label : undefined}
								bridge={link.bridge}
								weight={symbol ? undefined : link.weight}
							/>
						</li>
					))}
				</ul>
			)}
			{more > 0 && <div className="sh-cm-more">+{more} more</div>}
		</section>
	);
}
