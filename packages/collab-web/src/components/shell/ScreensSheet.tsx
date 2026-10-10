import { ArrowLeft, ChevronLeft, ChevronRight, ExternalLink, MessageSquare, X } from "lucide-react";
import type { PointerEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { relTime } from "../../lib/format";
import type { Screen } from "../../lib/screens";
import { openImage } from "../../tool-render";
import { Sheet } from "./Sheet";
import "./screens.css";

/** Thumbnails mounted at first, and added per "Show more": keeps a long session's grid light. */
const PAGE = 48;
/** Horizontal travel (px) that counts as a swipe in the viewer. */
const SWIPE_PX = 56;
/** A swipe must be this many times wider than tall, so vertical panning never flips the image. */
const SWIPE_RATIO = 1.5;

export interface ScreensSheetProps {
	/** Every screen of the session, oldest first, as `collectScreens` lists them. */
	screens: readonly Screen[];
	/** Bring the transcript row of `entryId` into view (the sheet closes itself first). */
	onJump(entryId: string): void;
	onClose(): void;
}

function srcOf(screen: Screen): string {
	return `data:${screen.image.mimeType};base64,${screen.image.data}`;
}

/** "browser · 5m ago · Checking the login page" */
function caption(screen: Screen): string {
	const parts: string[] = [screen.tool];
	if (screen.at !== null) parts.push(relTime(screen.at));
	if (screen.label !== null) parts.push(screen.label);
	return parts.join(" · ");
}

/** A tap target whose image decodes only once scrolled near. */
function Thumb({ screen, onOpen }: { screen: Screen; onOpen(id: string): void }): ReactNode {
	const src = useMemo(() => srcOf(screen), [screen]);
	return (
		<button type="button" className="sh-screen-thumb" onClick={() => onOpen(screen.id)}>
			<img className="sh-screen-img" src={src} alt="" loading="lazy" decoding="async" />
			<span className="sh-screen-cap">{caption(screen)}</span>
		</button>
	);
}

/**
 * Every image the agent's tools produced, newest first: screenshots of the app it
 * is building, generated images, image files it read. Tapping one opens a viewer
 * with prev/next (buttons, arrow keys, swipe), the original, and a jump to the
 * message it came from. New screens appear as they land.
 */
export function ScreensSheet({ screens, onJump, onClose }: ScreensSheetProps): ReactNode {
	const newest = useMemo(() => [...screens].reverse(), [screens]);
	const [shown, setShown] = useState(PAGE);
	// Tracked by id, not position, so screens landing while one is open leave the viewer where it is.
	const [viewId, setViewId] = useState<string | null>(null);
	const index = viewId === null ? -1 : newest.findIndex(s => s.id === viewId);
	const viewing = index >= 0 ? newest[index] : null;

	const step = useCallback(
		(by: 1 | -1): void => {
			const next = newest[index + by];
			if (next) setViewId(next.id);
		},
		[newest, index],
	);
	useEffect(() => {
		if (viewing === null) return;
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "ArrowLeft") step(-1);
			else if (e.key === "ArrowRight") step(1);
			else return;
			e.preventDefault();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [viewing, step]);

	// One finger travelling across the image; a second finger (pinch) voids the gesture.
	const swipe = useRef<{ x: number; y: number; pinch: boolean } | null>(null);
	const onPointerDown = (e: PointerEvent): void => {
		if (e.pointerType === "mouse") return;
		if (swipe.current) swipe.current.pinch = true;
		else swipe.current = { x: e.clientX, y: e.clientY, pinch: false };
	};
	const onPointerUp = (e: PointerEvent): void => {
		const start = swipe.current;
		swipe.current = null;
		// A zoomed page pans with the finger instead.
		if (!start || start.pinch || (window.visualViewport?.scale ?? 1) > 1.01) return;
		const dx = e.clientX - start.x;
		if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(e.clientY - start.y) * SWIPE_RATIO) step(dx < 0 ? 1 : -1);
	};
	const onPointerCancel = (): void => {
		swipe.current = null;
	};

	// Back from the viewer first; Escape and the backdrop then close the sheet.
	const close = useCallback((): void => {
		if (viewing !== null) setViewId(null);
		else onClose();
	}, [viewing, onClose]);

	return (
		<Sheet label="screens" size={viewing ? "full" : "wide"} onClose={close}>
			<div className="sh-sheet-head">
				{viewing !== null && (
					<button type="button" className="sh-btn sh-btn-icon" onClick={close} aria-label="back to all screens">
						<ArrowLeft size={16} />
					</button>
				)}
				<div className="sh-sheet-title">
					{viewing !== null
						? `${index + 1} / ${newest.length}`
						: `Screens${newest.length > 0 ? ` · ${newest.length}` : ""}`}
				</div>
				<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="close">
					<X size={16} />
				</button>
			</div>
			{viewing !== null ? (
				<>
					<div
						className="sh-screen-stage"
						onPointerDown={onPointerDown}
						onPointerUp={onPointerUp}
						onPointerCancel={onPointerCancel}
					>
						<img className="sh-screen-full" src={srcOf(viewing)} alt={caption(viewing)} draggable={false} />
						<button
							type="button"
							className="sh-btn sh-btn-icon sh-screen-nav sh-screen-nav-prev"
							onClick={() => step(-1)}
							disabled={index === 0}
							aria-label="newer screen"
						>
							<ChevronLeft size={18} />
						</button>
						<button
							type="button"
							className="sh-btn sh-btn-icon sh-screen-nav sh-screen-nav-next"
							onClick={() => step(1)}
							disabled={index === newest.length - 1}
							aria-label="older screen"
						>
							<ChevronRight size={18} />
						</button>
					</div>
					<div className="sh-screen-foot">
						<div className="sh-screen-foot-cap">{caption(viewing)}</div>
						<div className="sh-screen-actions">
							<button type="button" className="sh-btn" onClick={() => openImage(viewing.image)}>
								<ExternalLink size={14} /> Open original
							</button>
							<button
								type="button"
								className="sh-btn"
								onClick={() => {
									onClose();
									onJump(viewing.entryId);
								}}
							>
								<MessageSquare size={14} /> Jump to message
							</button>
						</div>
					</div>
				</>
			) : newest.length === 0 ? (
				<div className="sh-screen-empty">
					<div className="sh-screen-empty-title">No screens yet</div>
					Screens appear here when the agent takes screenshots or produces images. Ask it to screenshot the page it
					is working on, and they will show up as they land.
				</div>
			) : (
				<>
					<div className="sh-screen-grid">
						{newest.slice(0, shown).map(screen => (
							<Thumb key={screen.id} screen={screen} onOpen={setViewId} />
						))}
					</div>
					{newest.length > shown && (
						<button type="button" className="sh-btn" onClick={() => setShown(n => n + PAGE)}>
							Show more ({newest.length - shown})
						</button>
					)}
				</>
			)}
		</Sheet>
	);
}
