import type { SimulationLinkDatum, SimulationNodeDatum } from "d3-force";
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";
import { Maximize, Minus, Plus } from "lucide-react";
import type { CSSProperties, PointerEvent, ReactNode } from "react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CodemapMap, CodemapNode } from "../../lib/companion";
import { langColor, nodeCounts, nodeSub, strokeWidth } from "./shared";

/** Settling steps run synchronously, so the layout is deterministic and nothing animates. */
const TICKS = 300;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 10;
/** Pointer travel (px) before a press becomes a pan rather than a click. */
const DRAG_SLOP = 4;
/** Room around the nodes in the fitted view, in layout units: label height below, margin around. */
const FIT_MARGIN = 36;
const LABEL_PX = 11;

interface Body extends SimulationNodeDatum {
	node: CodemapNode;
	r: number;
}

type Tie = SimulationLinkDatum<Body>;

interface Layout {
	bodies: Body[];
	/** Centre of the nodes' bounds. */
	cx: number;
	cy: number;
	/** Bounds including the margin, to fit into the viewport. */
	width: number;
	height: number;
}

/** View centre in layout units and zoom relative to the fitted view. */
interface Camera {
	x: number;
	y: number;
	zoom: number;
}

interface Viewport {
	width: number;
	height: number;
}

function layoutMap(map: CodemapMap): Layout {
	// Sizes are relative to the biggest child: absolute counts span four orders of magnitude between a
	// file and a package, which would pin every folder at the cap.
	const most = Math.max(1, ...map.nodes.map(node => node.symbols ?? 0));
	const bodies = map.nodes.map<Body>(node => ({ node, r: 7 + 19 * Math.sqrt((node.symbols ?? 0) / most) }));
	const ties = map.edges.map<Tie>(e => ({ source: e.from, target: e.to }));
	const linked: Record<number, true> = {};
	for (const e of map.edges) {
		linked[e.from] = true;
		linked[e.to] = true;
	}
	// Unlinked children feel only repulsion; a stronger pull keeps them beside the cluster, not off in a corner.
	const pull = (_: Body, i: number): number => (linked[i] ? 0.05 : 0.6);
	const sim = forceSimulation(bodies)
		.force("link", forceLink<Body, Tie>(ties).distance(80).strength(0.5))
		.force("charge", forceManyBody<Body>().strength(-260))
		.force(
			"collide",
			forceCollide<Body>(d => d.r + 14),
		)
		.force("x", forceX<Body>(0).strength(pull))
		.force("y", forceY<Body>(0).strength(pull))
		.stop();
	sim.tick(TICKS);
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	for (const b of bodies) {
		const x = b.x ?? 0;
		const y = b.y ?? 0;
		minX = Math.min(minX, x - b.r);
		maxX = Math.max(maxX, x + b.r);
		minY = Math.min(minY, y - b.r);
		maxY = Math.max(maxY, y + b.r);
	}
	if (bodies.length === 0) minX = maxX = minY = maxY = 0;
	return {
		bodies,
		cx: (minX + maxX) / 2,
		cy: (minY + maxY) / 2,
		width: maxX - minX + FIT_MARGIN * 2,
		height: maxY - minY + FIT_MARGIN * 2,
	};
}

export interface ForceMapProps {
	map: CodemapMap;
	/** Re-centre the map on `node`. */
	onFocus(node: CodemapNode): void;
}

/**
 * Force-directed overview of a folder's children: size by symbols, colour by language,
 * folders as rounded squares and files as discs. Pan by dragging, zoom by wheel or buttons.
 */
export function ForceMap({ map, onFocus }: ForceMapProps): ReactNode {
	const layout = useMemo(() => layoutMap(map), [map]);
	const surface = useRef<HTMLDivElement>(null);
	const [viewport, setViewport] = useState<Viewport>({ width: 0, height: 0 });
	const [camera, setCamera] = useState<Camera>({ x: layout.cx, y: layout.cy, zoom: 1 });
	const [hover, setHover] = useState<number | null>(null);
	const press = useRef<{ x: number; y: number; id: number; panning: boolean } | null>(null);
	const panned = useRef(false);

	useLayoutEffect(() => {
		const el = surface.current;
		if (!el) return;
		const measure = (): void => setViewport({ width: el.clientWidth, height: el.clientHeight });
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	// Layout units per pixel when the whole map fits; zooming divides it.
	const fit = viewport.width > 0 ? Math.max(layout.width / viewport.width, layout.height / viewport.height) : 1;
	const scale = fit / camera.zoom;
	// Handlers batched ahead of a render must still see the latest fit and viewport.
	const fitRef = useRef(fit);
	fitRef.current = fit;
	const viewportRef = useRef(viewport);
	viewportRef.current = viewport;

	// Zoom about a viewport point, keeping the layout point under it still.
	const zoomAt = useCallback((factor: number, px: number, py: number): void => {
		setCamera(c => {
			const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, c.zoom * factor));
			const before = fitRef.current / c.zoom;
			const after = fitRef.current / zoom;
			return {
				zoom,
				x: c.x + (px - viewportRef.current.width / 2) * (before - after),
				y: c.y + (py - viewportRef.current.height / 2) * (before - after),
			};
		});
	}, []);

	// A native listener: React's wheel handlers are passive and could not stop the page scrolling.
	useEffect(() => {
		const el = surface.current;
		if (!el) return;
		const onWheel = (e: WheelEvent): void => {
			e.preventDefault();
			const box = el.getBoundingClientRect();
			zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - box.left, e.clientY - box.top);
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, [zoomAt]);

	const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
		if (e.button !== 0) return;
		press.current = { x: e.clientX, y: e.clientY, id: e.pointerId, panning: false };
		panned.current = false;
	};
	const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
		const p = press.current;
		if (!p) return;
		const dx = e.clientX - p.x;
		const dy = e.clientY - p.y;
		if (!p.panning) {
			if (Math.hypot(dx, dy) < DRAG_SLOP) return;
			p.panning = true;
			panned.current = true;
			// Capture only once it is a pan, so a plain click still lands on the node under it.
			e.currentTarget.setPointerCapture(p.id);
		}
		p.x = e.clientX;
		p.y = e.clientY;
		setCamera(c => ({ ...c, x: c.x - (dx * fitRef.current) / c.zoom, y: c.y - (dy * fitRef.current) / c.zoom }));
	};
	const endPress = (): void => {
		press.current = null;
	};
	const pick = useCallback(
		(node: CodemapNode): void => {
			if (!panned.current) onFocus(node);
		},
		[onFocus],
	);

	const box =
		viewport.width > 0
			? `${camera.x - (viewport.width * scale) / 2} ${camera.y - (viewport.height * scale) / 2} ${viewport.width * scale} ${viewport.height * scale}`
			: undefined;
	const hovered = hover === null ? null : (layout.bodies[hover]?.node ?? null);
	const home: Camera = { x: layout.cx, y: layout.cy, zoom: 1 };
	const empty = layout.bodies.length === 0;

	return (
		<div className="sh-cm-map">
			<div
				className="sh-cm-map-surface"
				ref={surface}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={endPress}
				onPointerCancel={endPress}
			>
				{empty ? (
					<div className="sh-companion-empty sh-cm-empty">
						Nothing to map here: no source files below this folder.
					</div>
				) : (
					box && (
						<svg className="sh-cm-map-svg" viewBox={box} role="img" aria-label="folder map">
							<Scene
								map={map}
								bodies={layout.bodies}
								scale={scale}
								hover={hover}
								onHover={setHover}
								onPick={pick}
							/>
						</svg>
					)
				)}
			</div>
			{!empty && (
				<div className="sh-cm-map-tools">
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={() => zoomAt(1.4, viewport.width / 2, viewport.height / 2)}
						aria-label="zoom in"
						title="zoom in"
					>
						<Plus size={16} />
					</button>
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={() => zoomAt(1 / 1.4, viewport.width / 2, viewport.height / 2)}
						aria-label="zoom out"
						title="zoom out"
					>
						<Minus size={16} />
					</button>
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={() => setCamera(home)}
						aria-label="fit to view"
						title="fit to view"
					>
						<Maximize size={15} />
					</button>
				</div>
			)}
			{!empty && (
				<div className="sh-cm-map-info">
					{hovered ? (
						<>
							<strong>{hovered.label}</strong> <span>{nodeSub(hovered)}</span> <span>{nodeCounts(hovered)}</span>
						</>
					) : (
						<span>
							{map.nodes.length} item{map.nodes.length === 1 ? "" : "s"} · {map.edges.length} link
							{map.edges.length === 1 ? "" : "s"}
							{map.edges.length === 0 && " · none depend on each other"}
							{map.omitted > 0 && ` · ${map.omitted} least-connected not shown`}
						</span>
					)}
				</div>
			)}
		</div>
	);
}

interface SceneProps {
	map: CodemapMap;
	bodies: Body[];
	/** Layout units per pixel, so labels keep a constant on-screen size. */
	scale: number;
	hover: number | null;
	onHover(index: number | null): void;
	onPick(node: CodemapNode): void;
}

/** Edges and nodes; memoized so panning (which only moves the viewBox) does not re-render them. */
const Scene = memo(function Scene({ map, bodies, scale, hover, onHover, onPick }: SceneProps): ReactNode {
	const near = useMemo(() => {
		const linked: Record<number, true> = {};
		if (hover === null) return linked;
		linked[hover] = true;
		for (const e of map.edges) {
			if (e.from === hover) linked[e.to] = true;
			else if (e.to === hover) linked[e.from] = true;
		}
		return linked;
	}, [map.edges, hover]);
	return (
		<g className={hover === null ? undefined : "sh-cm-map-hovering"}>
			{map.edges.map((e, i) => {
				const a = bodies[e.from];
				const b = bodies[e.to];
				if (!a || !b) return null;
				const lit = hover !== null && (e.from === hover || e.to === hover);
				return (
					<line
						key={`${e.from}>${e.to}:${i}`}
						x1={a.x}
						y1={a.y}
						x2={b.x}
						y2={b.y}
						strokeWidth={strokeWidth(e.weight)}
						vectorEffect="non-scaling-stroke"
						className={`sh-cm-edge${e.bridge ? " sh-cm-edge-bridge" : ""}${lit ? " sh-cm-edge-lit" : ""}`}
					>
						<title>{`${a.node.label} → ${b.node.label} · ${e.weight}`}</title>
					</line>
				);
			})}
			{bodies.map((b, i) => {
				const x = b.x ?? 0;
				const y = b.y ?? 0;
				const dim = hover !== null && !near[i];
				return (
					<g
						key={`${b.node.kind}:${b.node.path}`}
						className={`sh-cm-node sh-cm-node-${b.node.kind}${dim ? " sh-cm-node-dim" : ""}`}
						style={{ "--lang": langColor(b.node.lang) } as CSSProperties}
						onPointerEnter={() => onHover(i)}
						onPointerLeave={() => onHover(null)}
						onClick={() => onPick(b.node)}
					>
						{b.node.kind === "dir" ? (
							<rect x={x - b.r} y={y - b.r} width={b.r * 2} height={b.r * 2} rx={Math.min(8, b.r * 0.4)} />
						) : (
							<circle cx={x} cy={y} r={b.r} />
						)}
					</g>
				);
			})}
			{/* Labels on their own layer above every node, so a neighbour drawn later cannot cover them. */}
			{bodies.map((b, i) => (
				<text
					key={`${b.node.kind}:${b.node.path}`}
					className={`sh-cm-label${i === hover ? " sh-cm-label-on" : hover !== null && !near[i] ? " sh-cm-node-dim" : ""}`}
					x={b.x ?? 0}
					y={(b.y ?? 0) + b.r + (LABEL_PX + 3) * scale}
					fontSize={LABEL_PX * scale}
					textAnchor="middle"
				>
					{b.node.label}
				</text>
			))}
		</g>
	);
});
