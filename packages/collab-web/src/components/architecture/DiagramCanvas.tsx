import type { Blueprint, BlueprintDiagram, BlueprintEdge, BlueprintNode } from "@oh-my-pi/pi-wire/blueprint";
import {
	Braces,
	Boxes,
	Cloud,
	Code,
	Component,
	Database,
	FileCode,
	Folder,
	Info,
	ListOrdered,
	Maximize,
	Minus,
	Monitor,
	Package,
	Plus,
	Server,
	User,
} from "lucide-react";
import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Point, Size, View } from "../../lib/pan-zoom";
import { fitView, openingView, panBy, pinchView, wheelFactor, zoomAt } from "../../lib/pan-zoom";
import { toLayout } from "../../lib/zoom";
import { ancestry, clip, edgeKind, nodeKind } from "./blueprint-model";
import type { DiagramLayout, PlacedEdge, PlacedNode } from "./blueprint-layout";
import { EDGE_LABEL_HEIGHT, nodeLabelChars } from "./blueprint-layout";

/** A diagram ready to draw: what it shows (possibly filtered to its changes) and where. */
export interface Scene {
	diagram: BlueprintDiagram;
	layout: DiagramLayout;
	/** Nodes shown only because a changed edge touches them. */
	context: ReadonlySet<string>;
	/** The filter left nothing of this diagram. */
	empty: boolean;
}

/** Something to bring into view and pulse, from a search hit. */
export interface Spot {
	diagram: string;
	node?: string;
	edge?: string;
	/** Changes for every request, so choosing the same hit twice works. */
	tick: number;
}

export interface DiagramCanvasProps {
	map: Blueprint;
	/** The diagram to show; the canvas zooms into or out of it when this changes to a neighbour. */
	current: string;
	getScene(id: string): Scene | null;
	/** Diagrams that hold changes (a diff map), for the marker on unchanged nodes that lead to them. */
	insideChanges: ReadonlySet<string>;
	selectedNode?: string;
	selectedEdge?: string;
	/** Height at the bottom that something on top of the canvas covers (the details sheet on a phone), in layout px. */
	coveredBottom?: number;
	spot: Spot | null;
	/** Click or Enter on a node: open its child diagram, or its details when it has none. */
	onActivateNode(node: BlueprintNode): void;
	/** The details button of a node (or `i`): show its summary and code without opening the child. */
	onDetailsNode(node: BlueprintNode): void;
	onSelectEdge(edge: BlueprintEdge): void;
	onClearSelection(): void;
	/** Bring the canvas surface into focus on mount: Escape then reaches the viewer. */
	autoFocus?: boolean;
}

/** Zoom-in below this and node text stops being readable, so a large diagram opens at it and is panned. */
const READABLE_SCALE = 0.55;
const BUTTON_STEP = 1.4;
const DURATION_MS = 460;
const DRAG_SLOP = 5;
const PULSE_MS = 1800;

const KIND_ICONS: Record<string, typeof Server> = {
	system: Boxes,
	service: Server,
	component: Component,
	package: Package,
	module: Folder,
	file: FileCode,
	symbol: Braces,
	store: Database,
	queue: ListOrdered,
	actor: User,
	ui: Monitor,
	external: Cloud,
};

/** Arrowheads, one per edge style and change colour; drawn in the SVG's defs so every layer shares them. */
const ARROWS = ["call", "import", "event", "data", "http", "rpc", "spawn", "added", "modified", "removed"];

const CHANGE_MARK: Record<string, string> = { added: "+", modified: "~", removed: "−" };
const CHANGE_WORD: Record<string, string> = { added: "added", modified: "changed", removed: "removed" };

function prefersReducedMotion(): boolean {
	return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function matrix(view: View): string {
	return `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
}

/** Where a child diagram of `size` sits inside its parent's node: centred, as large as the node allows. */
function placeInside(node: PlacedNode, size: Size): View {
	const scale = Math.min(node.width / size.width, node.height / size.height) * 0.94;
	return {
		x: node.x + (node.width - size.width * scale) / 2,
		y: node.y + (node.height - size.height * scale) / 2,
		scale,
	};
}

/** Space kept between a revealed box and the edge of the visible area. */
const REVEAL_MARGIN = 20;

/**
 * `view` with `box` (in diagram coordinates) inside the `visible` area, a margin from its edges: `view` itself when
 * it is there already, otherwise panned so the box sits in the middle of the area along each axis that needed it. A
 * box larger than the area on an axis is aligned to its start there.
 */
function revealBox(view: View, box: { x: number; y: number; width: number; height: number }, visible: Size): View {
	const pan = (offset: number, start: number, extent: number, room: number): number => {
		const low = start * view.scale + offset;
		const size = extent * view.scale;
		if (size > room - 2 * REVEAL_MARGIN) return REVEAL_MARGIN - low;
		if (low >= REVEAL_MARGIN && low + size <= room - REVEAL_MARGIN) return 0;
		return (room - size) / 2 - low;
	};
	const dx = pan(view.x, box.x, box.width, visible.width);
	const dy = pan(view.y, box.y, box.height, visible.height);
	return dx === 0 && dy === 0 ? view : { x: view.x + dx, y: view.y + dy, scale: view.scale };
}

/** The world view in which a child placed by `inside` shows as `child` does on its own. */
function worldFor(child: View, inside: View): View {
	const scale = child.scale / inside.scale;
	return { x: child.x - scale * inside.x, y: child.y - scale * inside.y, scale };
}

interface Transition {
	kind: "in" | "out" | "fade";
	from: string;
	to: string;
	run: boolean;
	/** The child's placement inside the parent's node (zoom transitions). */
	inside: View | null;
	worldStart: View;
	worldEnd: View;
	/** The views each diagram has before and after (fade). */
	fromView: View;
	toView: View;
}

interface LayerProps {
	scene: Scene;
	insideChanges: ReadonlySet<string>;
	map: Blueprint;
	selectedNode?: string;
	selectedEdge?: string;
	pulse: string | null;
	interactive: boolean;
	onNodeClick(node: BlueprintNode): void;
	onNodeDetails(node: BlueprintNode): void;
	onEdgeClick(edge: BlueprintEdge): void;
	onNodeKey(event: KeyboardEvent<SVGGElement>, node: PlacedNode): void;
	onFocusNode(node: PlacedNode): void;
}

export function DiagramCanvas(props: DiagramCanvasProps): ReactNode {
	const { map, current, getScene, insideChanges, spot } = props;
	const surface = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState<Size>({ width: 0, height: 0 });
	const sizeRef = useRef(size);
	sizeRef.current = size;
	const [shown, setShown] = useState(current);
	const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
	const viewRef = useRef(view);
	viewRef.current = view;
	const views = useRef(new Map<string, View>());
	/** Which view a resize restores: null once the user has moved the view. */
	const following = useRef<"opening" | "fit" | null>("opening");
	const [transition, setTransition] = useState<Transition | null>(null);
	const pointers = useRef(new Map<number, Point>());
	const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
	const suppressClick = useRef(false);
	const [hover, setHover] = useState<string | null>(null);
	const [pulse, setPulse] = useState<string | null>(null);
	const handledSpot = useRef<number | null>(null);

	const scene = getScene(shown);
	const sceneRef = useRef(scene);
	sceneRef.current = scene;
	const propsRef = useRef(props);
	propsRef.current = props;
	const sceneSize = useMemo<Size>(
		() => ({ width: scene?.layout.width ?? 0, height: scene?.layout.height ?? 0 }),
		[scene],
	);

	const measure = useCallback((): Size => {
		const box = surface.current?.getBoundingClientRect();
		return { width: toLayout(box?.width ?? 0), height: toLayout(box?.height ?? 0) };
	}, []);

	useLayoutEffect(() => {
		const node = surface.current;
		if (!node) return;
		setSize(measure());
		const observer = new ResizeObserver(() => setSize(measure()));
		observer.observe(node);
		return () => observer.disconnect();
	}, [measure]);

	// The part of the surface nothing covers: what a view is fitted to and a selection is kept inside.
	const covered = props.coveredBottom ?? 0;
	const visible = useMemo<Size>(
		() => ({ width: size.width, height: Math.max(0, size.height - covered) }),
		[size, covered],
	);
	const visibleRef = useRef(visible);
	visibleRef.current = visible;

	// The opening view follows the visible size until the first gesture (rotation, a panel docking, a sheet opening).
	useLayoutEffect(() => {
		if (visible.width === 0 || visible.height === 0 || sceneSize.width === 0) return;
		if (following.current === "opening") setView(openingView(sceneSize, visible, READABLE_SCALE));
		else if (following.current === "fit") setView(fitView(sceneSize, visible));
	}, [visible, sceneSize]);

	// A selected node or edge stays in the visible part: after the view is refitted for a panel or sheet that just
	// opened, or after the selection moved, it is panned (never zoomed) to the middle of the visible part if it is not in.
	const selectedBox = useMemo(() => {
		if (scene === null) return null;
		if (props.selectedNode !== undefined) {
			const hit = scene.layout.nodes.find(placed => placed.node.id === props.selectedNode);
			return hit ? { x: hit.x, y: hit.y, width: hit.width, height: hit.height } : null;
		}
		if (props.selectedEdge !== undefined) {
			const hit = scene.layout.edges.find(placed => placed.edge.id === props.selectedEdge);
			if (!hit) return null;
			const { x, y, width } = hit.label;
			return { x: x - width / 2, y: y - EDGE_LABEL_HEIGHT / 2, width, height: EDGE_LABEL_HEIGHT };
		}
		return null;
	}, [scene, props.selectedNode, props.selectedEdge]);
	useLayoutEffect(() => {
		if (selectedBox === null || transition !== null || visible.width === 0 || visible.height === 0) return;
		setView(prev => {
			const next = revealBox(prev, selectedBox, visible);
			return next === prev ? prev : next;
		});
	}, [selectedBox, visible, transition]);

	useEffect(() => {
		if (props.autoFocus) surface.current?.focus({ preventScroll: true });
	}, [props.autoFocus]);

	const viewFor = useCallback((id: string, sceneOf: Scene | null): View => {
		const saved = views.current.get(id);
		if (saved !== undefined) return saved;
		const room = visibleRef.current;
		return sceneOf === null ? { x: 0, y: 0, scale: 1 } : openingView(sceneOf.layout, room, READABLE_SCALE);
	}, []);

	const commit = useCallback((id: string, next: View, follow: "opening" | null): void => {
		following.current = follow;
		setShown(id);
		setView(next);
		setTransition(null);
	}, []);

	// A new `current`: jump when nothing can be animated, otherwise zoom into or out of the neighbouring node.
	useLayoutEffect(() => {
		if (current === shown) {
			if (transition !== null) setTransition(null);
			return;
		}
		if (transition !== null && transition.to === current) return;
		views.current.set(shown, viewRef.current);
		const from = getScene(shown);
		const to = getScene(current);
		const hadView = views.current.has(current);
		const room = sizeRef.current;
		if (from === null || to === null || room.width === 0 || prefersReducedMotion()) {
			commit(current, viewFor(current, to), hadView ? null : "opening");
			return;
		}
		const toView = viewFor(current, to);
		const down = ancestry(map, current).at(-2)?.id === shown;
		const up = ancestry(map, shown).at(-2)?.id === current;
		const parent = down ? from : up ? to : null;
		const childId = down ? current : up ? shown : null;
		const opening = parent?.layout.nodes.find(placed => placed.node.child === childId);
		const fromView = viewRef.current;
		if (parent !== null && opening !== undefined && childId !== null) {
			const childScene = down ? to : from;
			const inside = placeInside(opening, childScene.layout);
			setTransition({
				kind: down ? "in" : "out",
				from: shown,
				to: current,
				run: false,
				inside,
				worldStart: down ? fromView : worldFor(fromView, inside),
				worldEnd: down ? worldFor(toView, inside) : toView,
				fromView,
				toView,
			});
		} else {
			setTransition({
				kind: "fade",
				from: shown,
				to: current,
				run: false,
				inside: null,
				worldStart: fromView,
				worldEnd: toView,
				fromView,
				toView,
			});
		}
	}, [current, shown, transition, map, getScene, viewFor, commit]);

	// Run the transition one frame after its start styles are on screen, and commit when it ends. Keyed on the pair of
	// diagrams: flipping `run` must not restart the clock.
	const transitionKey = transition === null ? null : `${transition.from}>${transition.to}`;
	const transitionRef = useRef(transition);
	transitionRef.current = transition;
	useEffect(() => {
		if (transitionKey === null) return;
		let second = 0;
		const first = requestAnimationFrame(() => {
			second = requestAnimationFrame(() => setTransition(t => (t === null ? t : { ...t, run: true })));
		});
		const done = setTimeout(() => {
			const ending = transitionRef.current;
			if (ending !== null) commit(ending.to, ending.toView, views.current.has(ending.to) ? null : "opening");
		}, DURATION_MS + 80);
		return () => {
			cancelAnimationFrame(first);
			cancelAnimationFrame(second);
			clearTimeout(done);
		};
	}, [transitionKey, commit]);

	const change = (next: (prev: View) => View): void => {
		following.current = null;
		setView(next);
	};
	const fit = useCallback((): void => {
		following.current = "fit";
		setView(fitView(sceneSize, visibleRef.current));
	}, [sceneSize]);
	const zoomFromCenter = (factor: number): void => {
		const room = visibleRef.current;
		change(prev => zoomAt(prev, factor, { x: room.width / 2, y: room.height / 2 }));
	};

	// A wheel listener must be non-passive to stop the page scrolling under the canvas; React's is passive.
	useEffect(() => {
		const node = surface.current;
		if (!node) return;
		const onWheel = (e: WheelEvent): void => {
			e.preventDefault();
			if (transition !== null) return;
			const box = node.getBoundingClientRect();
			const at = { x: toLayout(e.clientX - box.left), y: toLayout(e.clientY - box.top) };
			// Pinch on a trackpad arrives as ctrl+wheel; a mouse wheel as large whole-number steps; two-finger scroll pans.
			const mouseWheel =
				e.deltaMode !== 0 || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50);
			following.current = null;
			if (e.ctrlKey || mouseWheel) setView(prev => zoomAt(prev, wheelFactor(e.deltaY, e.deltaMode), at));
			else setView(prev => panBy(prev, toLayout(-e.deltaX), toLayout(-e.deltaY)));
		};
		node.addEventListener("wheel", onWheel, { passive: false });
		return () => node.removeEventListener("wheel", onWheel);
	}, [transition]);

	const local = (clientX: number, clientY: number): Point => {
		const box = surface.current!.getBoundingClientRect();
		return { x: toLayout(clientX - box.left), y: toLayout(clientY - box.top) };
	};
	const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
		if (e.button !== 0 && e.pointerType === "mouse") return;
		const at = local(e.clientX, e.clientY);
		pointers.current.set(e.pointerId, at);
		drag.current =
			pointers.current.size === 1 ? { x: at.x, y: at.y, moved: false } : { x: at.x, y: at.y, moved: true };
	};
	const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
		const known = pointers.current;
		const before = known.get(e.pointerId);
		if (before === undefined || transition !== null) return;
		const now = local(e.clientX, e.clientY);
		const start = drag.current;
		if (start !== null && !start.moved) {
			if (Math.hypot(now.x - start.x, now.y - start.y) < DRAG_SLOP) return;
			start.moved = true;
			// Capture only once it is a drag: a plain click must still reach the node under the pointer.
			e.currentTarget.setPointerCapture(e.pointerId);
		}
		if (known.size === 1) {
			change(prev => panBy(prev, now.x - before.x, now.y - before.y));
		} else if (known.size === 2) {
			const [firstId, secondId] = [...known.keys()];
			const from = { a: known.get(firstId!)!, b: known.get(secondId!)! };
			const to = e.pointerId === firstId ? { a: now, b: from.b } : { a: from.a, b: now };
			change(prev => pinchView(prev, from, to));
		}
		known.set(e.pointerId, now);
	};
	const onPointerEnd = (e: PointerEvent<HTMLDivElement>): void => {
		pointers.current.delete(e.pointerId);
		if (pointers.current.size === 0) {
			suppressClick.current = drag.current?.moved === true;
			drag.current = null;
			// The click that follows the release is the end of a drag: swallow it, then forget.
			setTimeout(() => {
				suppressClick.current = false;
			}, 0);
		}
	};

	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
		if (e.target !== e.currentTarget) return;
		if (e.key === "+" || e.key === "=") zoomFromCenter(BUTTON_STEP);
		else if (e.key === "-") zoomFromCenter(1 / BUTTON_STEP);
		else if (e.key === "0") fit();
		else if (e.key.startsWith("Arrow")) {
			const step = 56;
			change(prev =>
				panBy(
					prev,
					e.key === "ArrowLeft" ? step : e.key === "ArrowRight" ? -step : 0,
					e.key === "ArrowUp" ? step : e.key === "ArrowDown" ? -step : 0,
				),
			);
		} else return;
		e.preventDefault();
	};

	/** Arrow keys on a node move focus to the nearest node that way. */
	const onNodeKey = useCallback((e: KeyboardEvent<SVGGElement>, from: PlacedNode): void => {
		const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key as string];
		const here = sceneRef.current;
		if (dir === undefined || here === null) return;
		e.preventDefault();
		e.stopPropagation();
		const cx = from.x + from.width / 2;
		const cy = from.y + from.height / 2;
		let best: PlacedNode | null = null;
		let bestScore = Number.POSITIVE_INFINITY;
		for (const other of here.layout.nodes) {
			if (other === from) continue;
			const dx = other.x + other.width / 2 - cx;
			const dy = other.y + other.height / 2 - cy;
			const along = dx * dir[0]! + dy * dir[1]!;
			if (along <= 0) continue;
			const across = Math.abs(dx * dir[1]!) + Math.abs(dy * dir[0]!);
			const cost = along + across * 2;
			if (cost < bestScore) {
				bestScore = cost;
				best = other;
			}
		}
		if (best === null) return;
		const target = Array.from(
			surface.current?.querySelectorAll<SVGGElement>(".ar-layer-live [data-ar-node]") ?? [],
		).find(g => g.dataset.arNode === best.node.id);
		target?.focus({ preventScroll: true });
	}, []);
	/** A node focused by keyboard that is off screen is brought in. */
	const onFocusNode = useCallback((placed: PlacedNode): void => {
		const room = visibleRef.current;
		const v = viewRef.current;
		const left = v.x + placed.x * v.scale;
		const top = v.y + placed.y * v.scale;
		const right = left + placed.width * v.scale;
		const bottom = top + placed.height * v.scale;
		const margin = 24;
		let dx = 0;
		let dy = 0;
		if (left < margin) dx = margin - left;
		else if (right > room.width - margin) dx = room.width - margin - right;
		if (top < margin) dy = margin - top;
		else if (bottom > room.height - margin) dy = room.height - margin - bottom;
		if (dx !== 0 || dy !== 0) {
			following.current = null;
			setView(prev => panBy(prev, dx, dy));
		}
	}, []);
	const onNodeClick = useCallback((node: BlueprintNode): void => {
		if (!suppressClick.current) propsRef.current.onActivateNode(node);
	}, []);
	const onNodeDetails = useCallback((node: BlueprintNode): void => {
		if (!suppressClick.current) propsRef.current.onDetailsNode(node);
	}, []);
	const onEdgeClick = useCallback((edge: BlueprintEdge): void => {
		if (!suppressClick.current) propsRef.current.onSelectEdge(edge);
	}, []);

	// A search hit: bring the node or edge to the middle and pulse it.
	useEffect(() => {
		if (spot === null || handledSpot.current === spot.tick || spot.diagram !== shown || transition !== null) return;
		const targetScene = getScene(shown);
		const room = visibleRef.current;
		if (targetScene === null || room.width === 0) return;
		handledSpot.current = spot.tick;
		let center: Point | null = null;
		if (spot.node !== undefined) {
			const hit = targetScene.layout.nodes.find(placed => placed.node.id === spot.node);
			if (hit) center = { x: hit.x + hit.width / 2, y: hit.y + hit.height / 2 };
		} else if (spot.edge !== undefined) {
			const hit = targetScene.layout.edges.find(placed => placed.edge.id === spot.edge);
			if (hit) center = { x: hit.label.x, y: hit.label.y };
		}
		if (center === null) return;
		const target = center;
		following.current = null;
		setView(prev => {
			const scale = Math.max(prev.scale, 0.85);
			return { x: room.width / 2 - target.x * scale, y: room.height / 2 - target.y * scale, scale };
		});
		setPulse(spot.node ?? spot.edge ?? null);
		const timer = setTimeout(() => setPulse(null), PULSE_MS);
		return () => clearTimeout(timer);
	}, [spot, shown, transition, getScene]);

	const layerProps = (id: string, interactive: boolean): LayerProps | null => {
		const layerScene = getScene(id);
		if (layerScene === null) return null;
		return {
			scene: layerScene,
			insideChanges,
			map,
			selectedNode: props.selectedNode,
			selectedEdge: props.selectedEdge,
			pulse,
			interactive,
			onNodeClick,
			onNodeDetails,
			onEdgeClick,
			onNodeKey,
			onFocusNode,
		};
	};

	const live = layerProps(shown, transition === null);
	const incoming = transition === null ? null : layerProps(transition.to, false);
	const hovered = hover;
	const running_ = transition?.run === true;

	let world: View = view;
	let layers: ReactNode;
	if (transition === null || live === null) {
		layers = live && <SceneLayer key={shown} {...live} hover={hovered} onHover={setHover} live />;
	} else if (transition.kind === "fade") {
		world = { x: 0, y: 0, scale: 1 };
		layers = (
			<>
				<g className="ar-layer" style={{ transform: matrix(transition.fromView), opacity: running_ ? 0 : 1 }}>
					<SceneLayer {...live} hover={null} onHover={setHover} />
				</g>
				{incoming && (
					<g
						className="ar-layer ar-layer-late"
						style={{ transform: matrix(transition.toView), opacity: running_ ? 1 : 0 }}
					>
						<SceneLayer {...incoming} hover={null} onHover={setHover} />
					</g>
				)}
			</>
		);
	} else {
		world = running_ ? transition.worldEnd : transition.worldStart;
		const inside = transition.inside!;
		const zoomIn = transition.kind === "in";
		// Parent at the origin, child inside its node: the one on the way out fades while the other grows into place.
		const parentProps = zoomIn ? live : incoming;
		const childProps = zoomIn ? incoming : live;
		layers = (
			<>
				{parentProps && (
					<g
						className={zoomIn ? "ar-layer" : "ar-layer ar-layer-late"}
						style={{ opacity: zoomIn ? (running_ ? 0 : 1) : running_ ? 1 : 0 }}
					>
						<SceneLayer {...parentProps} hover={null} onHover={setHover} />
					</g>
				)}
				{childProps && (
					<g
						className={zoomIn ? "ar-layer ar-layer-late" : "ar-layer"}
						style={{
							transform: `translate(${inside.x}px, ${inside.y}px) scale(${inside.scale})`,
							opacity: zoomIn ? (running_ ? 1 : 0) : running_ ? 0 : 1,
						}}
					>
						<SceneLayer {...childProps} hover={null} onHover={setHover} />
					</g>
				)}
			</>
		);
	}

	const empty = scene?.empty === true && transition === null;
	return (
		<div className="ar-canvas">
			<div
				ref={surface}
				className="ar-surface"
				tabIndex={0}
				role="group"
				aria-label={`Diagram${scene ? ` ${scene.diagram.title}` : ""}: drag to pan, scroll or pinch to zoom, Tab to move between nodes, Enter to open one`}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerEnd}
				onPointerCancel={onPointerEnd}
				onDoubleClick={e => {
					if (e.target === e.currentTarget || (e.target as Element).classList.contains("ar-svg")) fit();
				}}
				onKeyDown={onKeyDown}
				onClick={e => {
					if (suppressClick.current) return;
					const target = e.target as Element;
					if (
						target === e.currentTarget ||
						target.classList.contains("ar-svg") ||
						target.classList.contains("ar-backdrop")
					) {
						props.onClearSelection();
					}
				}}
			>
				<svg className="ar-svg" width={size.width} height={size.height} role="presentation">
					<defs>
						{ARROWS.map(name => (
							<marker
								key={name}
								id={`ar-arrow-${name}`}
								className={`ar-arrow ar-arrow-${name}`}
								viewBox="0 0 10 10"
								refX="9"
								refY="5"
								markerWidth="9"
								markerHeight="9"
								markerUnits="userSpaceOnUse"
								orient="auto"
							>
								<path d="M 0 1 L 10 5 L 0 9 z" />
							</marker>
						))}
					</defs>
					<rect className="ar-backdrop" width={size.width} height={size.height} />
					<g
						className={
							transition === null ? "ar-world" : running_ ? "ar-world ar-world-run" : "ar-world ar-world-prep"
						}
						style={{ transform: matrix(world) }}
					>
						{layers}
					</g>
				</svg>
				{empty && <div className="ar-empty">Nothing in this diagram changed.</div>}
			</div>
			<div className="ar-zoom" role="group" aria-label="Zoom">
				<button
					type="button"
					className="ar-btn ar-btn-icon"
					onClick={() => zoomFromCenter(1 / BUTTON_STEP)}
					aria-label="Zoom out"
				>
					<Minus size={15} />
				</button>
				<button type="button" className="ar-btn ar-btn-icon" onClick={fit} aria-label="Fit to screen">
					<Maximize size={15} />
				</button>
				<button
					type="button"
					className="ar-btn ar-btn-icon"
					onClick={() => zoomFromCenter(BUTTON_STEP)}
					aria-label="Zoom in"
				>
					<Plus size={15} />
				</button>
			</div>
		</div>
	);
}

interface SceneLayerProps extends LayerProps {
	hover: string | null;
	onHover(id: string | null): void;
	/** The layer that takes pointer and keyboard input. */
	live?: boolean;
}

function SceneLayer(props: SceneLayerProps): ReactNode {
	const { scene, hover } = props;
	// Edges that touch the hovered node stay lit; the rest of the picture recedes.
	const lit = useMemo(() => {
		const ids = new Set<string>();
		if (hover === null) return ids;
		for (const placed of scene.layout.edges) {
			if (placed.edge.from === hover || placed.edge.to === hover) ids.add(placed.edge.id);
		}
		return ids;
	}, [scene, hover]);
	return (
		<g className={props.live ? "ar-layer-live" : undefined} data-hovering={hover !== null ? "" : undefined}>
			{scene.layout.edges.map(placed => (
				<EdgeView
					key={placed.edge.id}
					placed={placed}
					selected={props.selectedEdge === placed.edge.id}
					pulsing={props.pulse === placed.edge.id}
					lit={lit.has(placed.edge.id)}
					interactive={props.interactive}
					onClick={props.onEdgeClick}
				/>
			))}
			{scene.layout.nodes.map(placed => (
				<NodeView
					key={placed.node.id}
					placed={placed}
					map={props.map}
					context={scene.context.has(placed.node.id)}
					inside={placed.node.child !== undefined && props.insideChanges.has(placed.node.child)}
					selected={props.selectedNode === placed.node.id}
					pulsing={props.pulse === placed.node.id}
					interactive={props.interactive}
					onClick={props.onNodeClick}
					onDetails={props.onNodeDetails}
					onKey={props.onNodeKey}
					onFocusNode={props.onFocusNode}
					onHover={props.onHover}
				/>
			))}
		</g>
	);
}

interface EdgeViewProps {
	placed: PlacedEdge;
	selected: boolean;
	pulsing: boolean;
	lit: boolean;
	interactive: boolean;
	onClick(edge: BlueprintEdge): void;
}

const EdgeView = memo(function EdgeView({
	placed,
	selected,
	pulsing,
	lit,
	interactive,
	onClick,
}: EdgeViewProps): ReactNode {
	const { edge, label } = placed;
	const kind = edgeKind(edge.kind);
	const arrow = edge.change ?? kind;
	const classes = [
		"ar-edge",
		`ar-edge-${kind}`,
		edge.change && `ar-change-${edge.change}`,
		selected && "ar-selected",
		pulsing && "ar-pulse",
		lit && "ar-lit",
	]
		.filter(Boolean)
		.join(" ");
	const activate = (): void => onClick(edge);
	return (
		<g
			className={classes}
			tabIndex={interactive ? 0 : undefined}
			role={interactive ? "button" : undefined}
			aria-label={interactive ? `Show the code behind: ${edge.label}` : undefined}
			aria-hidden={interactive ? undefined : true}
			onClick={interactive ? activate : undefined}
			onKeyDown={
				interactive
					? e => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								activate();
							}
						}
					: undefined
			}
		>
			<title>{edge.label}</title>
			<path className="ar-edge-hit" d={placed.d} />
			<path className="ar-edge-line" d={placed.d} markerEnd={`url(#ar-arrow-${arrow})`} />
			<g className="ar-elabel" transform={`translate(${label.x} ${label.y})`}>
				<rect
					x={-label.width / 2}
					y={-EDGE_LABEL_HEIGHT / 2}
					width={label.width}
					height={EDGE_LABEL_HEIGHT}
					rx={EDGE_LABEL_HEIGHT / 2}
				/>
				<text textAnchor="middle" dominantBaseline="central">
					{label.text}
				</text>
			</g>
		</g>
	);
});

interface NodeViewProps {
	placed: PlacedNode;
	map: Blueprint;
	context: boolean;
	inside: boolean;
	selected: boolean;
	pulsing: boolean;
	interactive: boolean;
	onClick(node: BlueprintNode): void;
	onDetails(node: BlueprintNode): void;
	onKey(event: KeyboardEvent<SVGGElement>, node: PlacedNode): void;
	onFocusNode(node: PlacedNode): void;
	onHover(id: string | null): void;
}

const NodeView = memo(function NodeView({
	placed,
	map,
	context,
	inside,
	selected,
	pulsing,
	interactive,
	onClick,
	onDetails,
	onKey,
	onFocusNode,
	onHover,
}: NodeViewProps): ReactNode {
	const { node, width, height } = placed;
	const kind = nodeKind(node.kind);
	const Icon = KIND_ICONS[kind] ?? Component;
	const opens = node.child !== undefined && Object.hasOwn(map.diagrams, node.child);
	const hasDetails = node.summary !== undefined || (node.refs?.length ?? 0) > 0 || node.path !== undefined;
	const classes = [
		"ar-node",
		`ar-kind-${kind}`,
		node.change && `ar-change-${node.change}`,
		opens && "ar-opens",
		context && "ar-context",
		selected && "ar-selected",
		pulsing && "ar-pulse",
	]
		.filter(Boolean)
		.join(" ");
	const verb = opens ? "Open" : hasDetails ? "Show details of" : "";
	const status = node.change ? `, ${CHANGE_WORD[node.change]}` : inside ? ", has changes inside" : "";
	const activate = (): void => onClick(node);
	return (
		<g
			className={classes}
			transform={`translate(${placed.x} ${placed.y})`}
			data-ar-node={node.id}
			tabIndex={interactive ? 0 : undefined}
			role={interactive ? "button" : undefined}
			aria-label={interactive ? `${verb ? `${verb} ` : ""}${node.label}, ${node.kind}${status}` : undefined}
			aria-hidden={interactive ? undefined : true}
			onClick={interactive ? activate : undefined}
			onFocus={interactive ? () => onFocusNode(placed) : undefined}
			onMouseEnter={interactive ? () => onHover(node.id) : undefined}
			onMouseLeave={interactive ? () => onHover(null) : undefined}
			onKeyDown={
				interactive
					? e => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								activate();
							} else if (e.key === "i" && hasDetails) {
								e.preventDefault();
								onDetails(node);
							} else onKey(e, placed);
						}
					: undefined
			}
		>
			<title>{node.summary ? `${node.label}: ${node.summary}` : node.label}</title>
			{opens && <rect className="ar-node-stack" x={5} y={5} width={width} height={height} rx={10} />}
			<rect className="ar-node-box" width={width} height={height} rx={10} />
			<Icon className="ar-node-icon" x={12} y={10} size={14} aria-hidden />
			<text className="ar-node-kind" x={32} y={21}>
				{node.kind}
			</text>
			<text className="ar-node-label" x={13} y={44}>
				{clip(node.label, nodeLabelChars(width))}
			</text>
			{hasDetails && interactive && (
				<g
					className="ar-node-chip"
					transform={`translate(${width - 26} 7)`}
					onClick={e => {
						e.stopPropagation();
						onDetails(node);
					}}
				>
					<rect width={20} height={20} rx={6} />
					{(node.refs?.length ?? 0) > 0 ? (
						<Code x={3} y={3} size={14} aria-hidden />
					) : (
						<Info x={3} y={3} size={14} aria-hidden />
					)}
					<title>{`Details of ${node.label}`}</title>
				</g>
			)}
			{node.change ? (
				<g className="ar-badge" transform="translate(-4 -4)">
					<circle r={9} cx={0} cy={0} />
					<text textAnchor="middle" dominantBaseline="central" y={0.5}>
						{CHANGE_MARK[node.change]}
					</text>
				</g>
			) : (
				inside && (
					<g className="ar-badge ar-badge-inside" transform="translate(-3 -3)">
						<circle r={5} cx={0} cy={0} />
					</g>
				)
			)}
		</g>
	);
});
