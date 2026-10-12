import { ExternalLink } from "lucide-react";
import type { KeyboardEvent, MouseEvent, PointerEvent, ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { GuestClient } from "../../lib/client";
import type { CompanionHost } from "../../lib/companion";
import { petBubbleText, petStatusWord } from "../../lib/pet-activity";
import {
	clampPoint,
	defaultLeft,
	homePoint,
	PET_MARGIN,
	type PetPoint,
	petHeight,
	roamY,
	spotAt,
} from "../../lib/pet-layout";
import { closePetPip, openPetPip, petPipSupported, usePetPipWindow } from "../../lib/pet-pip";
import { hopLift, nextRoamStep, type RoamStep } from "../../lib/pet-roam";
import { setPetSettings, setPetSpot, usePetSettings, usePetSpot } from "../../lib/pet-settings";
import type { PetState } from "../../lib/pet-state";
import type { PetdexPet } from "../../lib/petdex";
import { useSystemTheme } from "../../lib/theme";
import { useDockTop, usePageVisible, useViewport } from "../../lib/use-pet-env";
import { usePetActivity } from "../../lib/use-pet-activity";
import { useMedia } from "../codemap/shared";
import { PetFigure } from "./PetFigure";
import "./pet.css";

/** How long a click's status bubble stays. */
const BUBBLE_MS = 2000;
/** The pointer must travel this far before a press becomes a drag. */
const DRAG_SLOP_PX = 4;
/** An arrow key moves the pet this far. */
const NUDGE_PX = 16;
/** Pixels an Alt+wheel notch adds to or takes from the size. */
const WHEEL_STEP_PX = 4;
/** The glide between the pet's spot and where it roams. */
const GLIDE_MS = 450;
/** The pop-out's pet is drawn at this width. */
const PIP_PET_SIZE = 104;

export interface PetLayerProps {
	/** The open session's client; null on the home screen. */
	client: GuestClient | null;
	/** The paired computer's sessions, for the home screen. */
	hosts: readonly CompanionHost[];
	hostsLive: boolean;
}

/**
 * The pet: floats over the app (below its sheets), shows what the agent is doing, and moves out into its own
 * window when asked. Mounted once, only while the pet is enabled.
 */
export function PetLayer({ client, hosts, hostsLive }: PetLayerProps): ReactNode {
	const settings = usePetSettings();
	const activity = usePetActivity(client, hosts, hostsLive);
	const pipWindow = usePetPipWindow();
	const visible = usePageVisible();
	const reduced = useMedia("(prefers-reduced-motion: reduce)");
	const theme = useSystemTheme();

	// The pop-out follows the app's theme.
	useEffect(() => {
		if (pipWindow === null) return;
		pipWindow.document.documentElement.dataset.theme = theme;
		pipWindow.document.documentElement.style.colorScheme = theme;
	}, [pipWindow, theme]);

	if (pipWindow !== null) {
		return createPortal(
			<PetPip
				state={activity.state}
				pick={settings.pick}
				still={reduced}
				onFocusApp={focusApp}
				onBack={closePetPip}
			/>,
			pipWindow.document.body,
		);
	}
	return (
		<PetFloat
			client={client}
			state={activity.state}
			still={reduced || !visible}
			roam={settings.roam && !reduced && visible}
			popOutAgain={settings.popout}
			onPopOut={openPetPip}
		/>
	);
}

/** Brings the app's tab forward; browsers allow it only after a gesture, so it is best effort. */
function focusApp(): void {
	window.focus();
}

interface DragState {
	pointer: number;
	startX: number;
	startY: number;
	originX: number;
	originY: number;
	moved: boolean;
}

interface PetFloatProps {
	client: GuestClient | null;
	state: PetState;
	still: boolean;
	roam: boolean;
	popOutAgain: boolean;
	onPopOut(): Promise<string | null>;
}

function PetFloat({ client, state, still, roam, popOutAgain, onPopOut }: PetFloatProps): ReactNode {
	const settings = usePetSettings();
	const spot = usePetSpot();
	const view = useViewport();
	const { size, pick } = settings;
	const dockTop = useDockTop(client, defaultLeft(view, size));
	const height = petHeight(size);

	const wrap = useRef<HTMLDivElement>(null);
	const at = useRef<PetPoint>({ x: 0, y: 0 });
	const drag = useRef<DragState | null>(null);
	const justDragged = useRef(false);
	const [dragging, setDragging] = useState(false);
	const [roamState, setRoamState] = useState<PetState | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const [bubbleOn, setBubbleOn] = useState(false);

	const home = useMemo(() => homePoint(spot, view, size, dockTop), [spot, view, size, dockTop]);
	const roaming = roam && state === "idle" && !dragging;
	const shown: PetState = roaming && roamState !== null ? roamState : state;

	const place = useCallback((point: PetPoint): void => {
		at.current = point;
		const el = wrap.current;
		if (el !== null) el.style.transform = `translate3d(${point.x}px, ${point.y}px, 0)`;
	}, []);

	const glide = useCallback((): void => {
		const el = wrap.current;
		if (el === null) return;
		el.dataset.glide = "";
		window.setTimeout(() => delete el.dataset.glide, GLIDE_MS);
	}, []);

	// At its spot: where it is saved or defaults to, and back there when roaming stops.
	const wasRoaming = useRef(false);
	const lastDock = useRef(dockTop);
	useLayoutEffect(() => {
		const dockMoved = lastDock.current !== dockTop;
		lastDock.current = dockTop;
		if (roaming) return;
		const held = drag.current !== null;
		// Glide back from a roam, and when a bar or the composer growing moves the default spot.
		if ((wasRoaming.current || dockMoved) && !held) glide();
		wasRoaming.current = false;
		if (!held) place(home);
	}, [roaming, home, dockTop, place, glide]);

	// Roaming: walk and hop along the band at the pet's own height, one rAF loop only while a step moves it.
	const bandY = roamY(home, size, dockTop);
	const minX = PET_MARGIN;
	const maxX = Math.max(minX, view.width - size - PET_MARGIN);
	const homeX = home.x;
	useEffect(() => {
		if (!roaming) return;
		wasRoaming.current = true;
		const pos: PetPoint = { x: Math.min(maxX, Math.max(minX, homeX)), y: bandY };
		let frame = 0;
		let timer = 0;
		glide();
		place(pos);

		const animate = (ms: number, apply: (t: number) => void, done: () => void): void => {
			const began = performance.now();
			const tick = (now: number): void => {
				const t = Math.min(1, (now - began) / ms);
				apply(t);
				if (t < 1) frame = requestAnimationFrame(tick);
				else done();
			};
			frame = requestAnimationFrame(tick);
		};
		const run = (previous: RoamStep["kind"] | null): void => {
			const step = nextRoamStep(Math.random, pos.x, minX, maxX, size, previous);
			if (step.kind === "pause") {
				setRoamState("idle");
				timer = window.setTimeout(() => run("pause"), step.ms);
			} else if (step.kind === "walk") {
				setRoamState(step.state);
				const from = pos.x;
				animate(
					step.ms,
					t => {
						pos.x = from + (step.to - from) * t;
						place(pos);
					},
					() => run("walk"),
				);
			} else {
				setRoamState("jumping");
				animate(
					step.ms,
					t => place({ x: pos.x, y: pos.y - hopLift(t, height * 0.5) }),
					() => {
						place(pos);
						run("hop");
					},
				);
			}
		};
		timer = window.setTimeout(() => run(null), GLIDE_MS);
		return () => {
			cancelAnimationFrame(frame);
			clearTimeout(timer);
			setRoamState(null);
		};
	}, [roaming, bandY, minX, maxX, homeX, size, height, place, glide]);

	// A click's status bubble, and the page hiding or the pet leaving take it away.
	useEffect(() => {
		if (!bubbleOn) return;
		const timer = window.setTimeout(() => {
			setBubbleOn(false);
			setMessage(null);
		}, BUBBLE_MS);
		return () => clearTimeout(timer);
	}, [bubbleOn, message]);

	// Alt+wheel over the pet resizes it. A native listener: React's wheel handler cannot cancel the page scroll.
	useEffect(() => {
		const el = wrap.current;
		if (el === null) return;
		const onWheel = (e: WheelEvent): void => {
			if (!e.altKey) return;
			e.preventDefault();
			const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
			if (delta !== 0) setPetSettings({ size: size + (delta < 0 ? WHEEL_STEP_PX : -WHEEL_STEP_PX) });
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, [size]);

	const onPointerDown = (e: PointerEvent<HTMLButtonElement>): void => {
		if (e.pointerType === "mouse" && e.button !== 0) return;
		drag.current = {
			pointer: e.pointerId,
			startX: e.clientX,
			startY: e.clientY,
			originX: at.current.x,
			originY: at.current.y,
			moved: false,
		};
		e.currentTarget.setPointerCapture(e.pointerId);
	};
	const onPointerMove = (e: PointerEvent<HTMLButtonElement>): void => {
		const d = drag.current;
		if (d === null || d.pointer !== e.pointerId) return;
		const dx = e.clientX - d.startX;
		const dy = e.clientY - d.startY;
		if (!d.moved) {
			if (Math.hypot(dx, dy) < DRAG_SLOP_PX) return;
			d.moved = true;
			delete wrap.current?.dataset.glide;
			setDragging(true);
		}
		place(clampPoint({ x: d.originX + dx, y: d.originY + dy }, view, size));
	};
	const endDrag = (e: PointerEvent<HTMLButtonElement>, commit: boolean): void => {
		const d = drag.current;
		if (d === null || d.pointer !== e.pointerId) return;
		drag.current = null;
		if (!d.moved) return;
		// the click that follows the release of a drag is not a click on the pet
		justDragged.current = true;
		window.setTimeout(() => {
			justDragged.current = false;
		}, 0);
		setDragging(false);
		if (commit) setPetSpot(spotAt(at.current, view, size));
		else place(home);
	};

	const onClick = (e: MouseEvent<HTMLButtonElement>): void => {
		if (justDragged.current) return;
		if (e.shiftKey && petPipSupported()) {
			void onPopOut().then(error => {
				if (error === null) return;
				setMessage(error);
				setBubbleOn(true);
			});
			return;
		}
		setMessage(null);
		setBubbleOn(true);
	};
	const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
		const step: Record<string, PetPoint> = {
			ArrowLeft: { x: -NUDGE_PX, y: 0 },
			ArrowRight: { x: NUDGE_PX, y: 0 },
			ArrowUp: { x: 0, y: -NUDGE_PX },
			ArrowDown: { x: 0, y: NUDGE_PX },
		};
		if (!Object.hasOwn(step, e.key)) return;
		e.preventDefault();
		const by = step[e.key];
		setPetSpot(spotAt(clampPoint({ x: at.current.x + by.x, y: at.current.y + by.y }, view, size), view, size));
	};

	const side = home.y < 56 ? "below" : "above";
	const align = home.x < 56 ? "start" : home.x > view.width - size - 56 ? "end" : "center";
	return (
		<div
			ref={wrap}
			className="tl-pet-layer"
			data-pet-state={shown}
			data-pet-roaming={roaming ? "true" : undefined}
			data-dragging={dragging ? "true" : undefined}
		>
			{bubbleOn && (
				<div className="tl-pet-say" role="status" data-side={side} data-align={align}>
					{message ?? petBubbleText(state)}
				</div>
			)}
			<button
				type="button"
				className="tl-pet-btn"
				aria-label={`Pet: ${petStatusWord(state)}`}
				style={{ width: size, height }}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={e => endDrag(e, true)}
				onPointerCancel={e => endDrag(e, false)}
				onClick={onClick}
				onKeyDown={onKeyDown}
			>
				<PetFigure pick={pick} state={shown} size={size} still={still} />
			</button>
			{popOutAgain && petPipSupported() && (
				<button
					type="button"
					className="tl-pet-again"
					aria-label="Pop the pet out again"
					onClick={() => void onPopOut()}
				>
					<ExternalLink size={12} />
				</button>
			)}
		</div>
	);
}

interface PetPipProps {
	state: PetState;
	pick: PetdexPet | null;
	still: boolean;
	onFocusApp(): void;
	onBack(): void;
}

/** What the pop-out window shows: the pet, a status bubble and a way back. */
function PetPip({ state, pick, still, onFocusApp, onBack }: PetPipProps): ReactNode {
	return (
		<div className="tl-pet-pip" data-pet-state={state}>
			<div className="tl-pet-say tl-pet-pip-say" role="status">
				{petBubbleText(state)}
			</div>
			<button
				type="button"
				className="tl-pet-pip-pet"
				aria-label={`Pet: ${petStatusWord(state)}`}
				onClick={onFocusApp}
			>
				<PetFigure pick={pick} state={state} size={PIP_PET_SIZE} still={still} />
			</button>
			<button type="button" className="sh-btn" onClick={onBack}>
				Back to the app
			</button>
		</div>
	);
}
