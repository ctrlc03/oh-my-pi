import { Maximize, Minus, Plus } from "lucide-react";
import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Point, Size, View } from "../../lib/pan-zoom";
import { fitView, openingView, panBy, pinchView, wheelFactor, zoomAt } from "../../lib/pan-zoom";

const BUTTON_STEP = 1.4;

export interface PanZoomProps {
	/** Natural size of the content, in CSS pixels. */
	size: Size;
	/** Smallest zoom the opening view may use: a diagram too wide for it opens at this zoom, to be panned, instead of shrinking its text. */
	readableScale: number;
	children: ReactNode;
}

/**
 * A pan/zoom surface: drag to pan, wheel or trackpad pinch to zoom at the cursor, two fingers to pinch and pan
 * on touch, double-click or the fit button to fit all of it, +/- buttons or keys. It opens on the content (all
 * of it, or its start at the readable zoom) until the first gesture, so it stays put while the sheet resizes
 * (rotation, on-screen keyboard).
 */
export function PanZoom({ size, readableScale, children }: PanZoomProps): ReactNode {
	const surface = useRef<HTMLDivElement>(null);
	const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
	// Which view a resize restores: null once the user has moved the view.
	const following = useRef<"opening" | "fit" | null>("opening");
	const pointers = useRef(new Map<number, Point>());

	const viewport = (): Size => {
		const box = surface.current?.getBoundingClientRect();
		return { width: box?.width ?? 0, height: box?.height ?? 0 };
	};
	const fit = useCallback((): void => {
		following.current = "fit";
		setView(fitView(size, viewport()));
	}, [size]);

	useLayoutEffect(() => {
		const node = surface.current;
		if (!node) return;
		const restore = (): void => {
			if (following.current === "opening") setView(openingView(size, viewport(), readableScale));
			else if (following.current === "fit") setView(fitView(size, viewport()));
		};
		following.current = "opening";
		restore();
		const observer = new ResizeObserver(restore);
		observer.observe(node);
		return () => observer.disconnect();
	}, [readableScale, size]);

	const change = (next: (view: View) => View): void => {
		following.current = null;
		setView(next);
	};
	const local = (clientX: number, clientY: number): Point => {
		const box = surface.current!.getBoundingClientRect();
		return { x: clientX - box.left, y: clientY - box.top };
	};
	const zoomFromCenter = (factor: number): void => {
		const { width, height } = viewport();
		change(prev => zoomAt(prev, factor, { x: width / 2, y: height / 2 }));
	};

	// A wheel listener must be non-passive to stop the page scrolling under the viewer; React's is passive.
	useEffect(() => {
		const node = surface.current;
		if (!node) return;
		const onWheel = (e: WheelEvent): void => {
			e.preventDefault();
			const at = local(e.clientX, e.clientY);
			// Pinch on a trackpad arrives as ctrl+wheel; a mouse wheel as large whole-number steps; two-finger scroll pans.
			const mouseWheel =
				e.deltaMode !== 0 || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50);
			if (e.ctrlKey || mouseWheel) change(prev => zoomAt(prev, wheelFactor(e.deltaY, e.deltaMode), at));
			else change(prev => panBy(prev, -e.deltaX, -e.deltaY));
		};
		node.addEventListener("wheel", onWheel, { passive: false });
		return () => node.removeEventListener("wheel", onWheel);
	}, []);

	const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
		if (e.button !== 0 && e.pointerType === "mouse") return;
		e.currentTarget.setPointerCapture(e.pointerId);
		pointers.current.set(e.pointerId, local(e.clientX, e.clientY));
	};
	const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
		const known = pointers.current;
		const before = known.get(e.pointerId);
		if (before === undefined) return;
		const now = local(e.clientX, e.clientY);
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
	};

	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
		if (e.key === "+" || e.key === "=") zoomFromCenter(BUTTON_STEP);
		else if (e.key === "-") zoomFromCenter(1 / BUTTON_STEP);
		else if (e.key === "0") fit();
		else if (e.key.startsWith("Arrow")) {
			const step = 48;
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

	return (
		<div className="sh-pz">
			<div
				ref={surface}
				className="sh-pz-surface"
				tabIndex={0}
				role="application"
				aria-label="Diagram: drag to pan, scroll or pinch to zoom"
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerEnd}
				onPointerCancel={onPointerEnd}
				onDoubleClick={fit}
				onKeyDown={onKeyDown}
			>
				<div
					className="sh-pz-content"
					style={{
						width: size.width,
						height: size.height,
						transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
					}}
				>
					{children}
				</div>
			</div>
			<div className="sh-pz-controls">
				<button
					type="button"
					className="sh-btn sh-btn-icon"
					onClick={() => zoomFromCenter(1 / BUTTON_STEP)}
					aria-label="Zoom out"
				>
					<Minus size={15} />
				</button>
				<button type="button" className="sh-btn sh-btn-icon" onClick={fit} aria-label="Fit to screen">
					<Maximize size={15} />
				</button>
				<button
					type="button"
					className="sh-btn sh-btn-icon"
					onClick={() => zoomFromCenter(BUTTON_STEP)}
					aria-label="Zoom in"
				>
					<Plus size={15} />
				</button>
			</div>
		</div>
	);
}
