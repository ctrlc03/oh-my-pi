import type { CSSProperties, ReactNode } from "react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CodemapFlowDirection, CodemapFlowStep, CodemapNode } from "../../lib/companion";
import { NodeIcon, nodeSub, PHONE_QUERY, useMedia } from "./shared";

const DIRECTIONS: { value: CodemapFlowDirection; label: string }[] = [
	{ value: "down", label: "Downstream" },
	{ value: "up", label: "Upstream" },
];

export interface FlowGraphProps {
	/** The walk from the focus, breadth first; `steps[0]` is the focus. */
	steps: CodemapFlowStep[];
	direction: CodemapFlowDirection;
	onDirection(direction: CodemapFlowDirection): void;
	/** Re-centre the map on `node`. */
	onFocus(node: CodemapNode): void;
}

/** A measured curve from a step to the step it was reached from. */
interface Curve {
	key: number;
	d: string;
	bridge: boolean;
}

/**
 * Cross-language flow from the focus symbol (event → decoder → type → circuit): hop
 * columns joined by curves on wide screens, an indented tree on phones.
 */
export function FlowGraph({ steps, direction, onDirection, onFocus }: FlowGraphProps): ReactNode {
	const stacked = useMedia(PHONE_QUERY);
	const canvas = useRef<HTMLDivElement>(null);
	const [curves, setCurves] = useState<Curve[]>([]);

	const columns = useMemo(() => {
		const cols: number[][] = [];
		steps.forEach((step, index) => {
			while (cols.length <= step.hop) cols.push([]);
			cols[step.hop]?.push(index);
		});
		return cols;
	}, [steps]);

	// Depth-first order so each step sits under the one it came from.
	const tree = useMemo(() => {
		const kids = steps.map<number[]>(() => []);
		steps.forEach((step, index) => {
			if (step.from !== null) kids[step.from]?.push(index);
		});
		const order: number[] = [];
		const visit = (index: number): void => {
			order.push(index);
			for (const kid of kids[index] ?? []) visit(kid);
		};
		if (steps.length > 0) visit(0);
		return order;
	}, [steps]);

	useLayoutEffect(() => {
		const root = canvas.current;
		if (stacked || !root) return;
		const measure = (): void => {
			const base = root.getBoundingClientRect();
			const boxes = new Map<number, DOMRect>();
			for (const el of root.querySelectorAll<HTMLElement>("[data-step]")) {
				boxes.set(Number(el.dataset.step), el.getBoundingClientRect());
			}
			const next: Curve[] = [];
			steps.forEach((step, index) => {
				const parent = step.from === null ? undefined : boxes.get(step.from);
				const child = boxes.get(index);
				if (!parent || !child) return;
				const fromX = parent.right - base.left;
				const toX = child.left - base.left;
				const fromY = parent.top - base.top + parent.height / 2;
				const toY = child.top - base.top + child.height / 2;
				const mid = (fromX + toX) / 2;
				next.push({
					key: index,
					d: `M${fromX} ${fromY} C${mid} ${fromY} ${mid} ${toY} ${toX} ${toY}`,
					bridge: step.bridge,
				});
			});
			setCurves(next);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(root);
		return () => observer.disconnect();
	}, [steps, stacked]);

	return (
		<div className="sh-cm-flow">
			<div className="sh-cm-flow-bar">
				<div className="sh-segmented" role="radiogroup" aria-label="flow direction">
					{DIRECTIONS.map(d => (
						<button
							key={d.value}
							type="button"
							role="radio"
							aria-checked={direction === d.value}
							className={direction === d.value ? "sh-segment sh-segment-on" : "sh-segment"}
							onClick={() => onDirection(d.value)}
						>
							{d.label}
						</button>
					))}
				</div>
				<span className="sh-cm-count">
					{steps.length - 1} step{steps.length === 2 ? "" : "s"}
				</span>
			</div>
			{steps.length < 2 ? (
				<div className="sh-companion-empty">
					Nothing {direction === "down" ? "downstream of" : "upstream of"} this symbol.
				</div>
			) : stacked ? (
				<ul className="sh-cm-tree">
					{tree.map(index => {
						const step = steps[index];
						return step ? (
							<li key={index} style={{ "--depth": step.hop } as CSSProperties}>
								<StepCard step={step} onFocus={onFocus} />
							</li>
						) : null;
					})}
				</ul>
			) : (
				<div className="sh-cm-flow-scroll">
					<div className="sh-cm-flow-cols" ref={canvas}>
						<svg className="sh-cm-curves" aria-hidden>
							{curves.map(c => (
								<path
									key={c.key}
									d={c.d}
									strokeWidth={1.5}
									className={c.bridge ? "sh-cm-curve sh-cm-curve-bridge" : "sh-cm-curve"}
								/>
							))}
						</svg>
						{columns.map((indices, hop) => (
							<ol key={hop} className="sh-cm-flow-col" aria-label={`hop ${hop}`}>
								{indices.map(index => {
									const step = steps[index];
									return step ? (
										<li key={index} data-step={index}>
											<StepCard step={step} onFocus={onFocus} />
										</li>
									) : null;
								})}
							</ol>
						))}
					</div>
				</div>
			)}
		</div>
	);
}

function StepCard({ step, onFocus }: { step: CodemapFlowStep; onFocus(node: CodemapNode): void }): ReactNode {
	const origin = step.hop === 0;
	return (
		<button
			type="button"
			className={origin ? "sh-cm-step sh-cm-step-focus" : "sh-cm-step"}
			onClick={() => onFocus(step.node)}
			disabled={origin}
		>
			{step.label && (
				<span className={step.bridge ? "sh-cm-chip sh-cm-chip-bridge" : "sh-cm-chip"}>{step.label}</span>
			)}
			<span className="sh-cm-step-main">
				<NodeIcon node={step.node} />
				<span className="sh-cm-row-label">{step.node.label}</span>
				{step.node.symbolKind && <span className="sh-cm-kind">{step.node.symbolKind}</span>}
			</span>
			<span className="sh-cm-row-sub">{nodeSub(step.node)}</span>
		</button>
	);
}
