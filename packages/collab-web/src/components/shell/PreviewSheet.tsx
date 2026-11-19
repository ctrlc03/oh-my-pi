import { type LucideIcon, LoaderCircle, Monitor, MousePointerClick, RefreshCw, Smartphone, Tablet, X } from "lucide-react";
import type { FormEvent, MouseEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type CompanionClient,
	PREVIEW_SCALE,
	type PreviewPick,
	type PreviewShot,
	type PreviewTarget,
	type PreviewViewport,
} from "../../lib/companion";
import { relTime } from "../../lib/format";
import { loadPreviewPrefs, savePreviewPrefs } from "../../lib/preview";
import { pickCropFile, pickPrompt, shotPoint } from "../../lib/preview-pick";
import { openImage } from "../../tool-render";
import { Sheet, SheetPlacementButton } from "./Sheet";
import "./preview.css";

/** The agent often saves several files in a row, and the dev server needs a moment to rebuild after the last one. */
const AUTO_DEBOUNCE_MS = 2_000;
const SCHEME_RE = /^[a-z][a-z\d+.-]*:\/\//i;

const VIEWPORTS: { id: PreviewViewport; label: string; Icon: LucideIcon }[] = [
	{ id: "phone", label: "Phone", Icon: Smartphone },
	{ id: "tablet", label: "Tablet", Icon: Tablet },
	{ id: "desktop", label: "Desktop", Icon: Monitor },
];

interface Target {
	url: string;
	viewport: PreviewViewport;
}

/** The last click in design mode: where it is being resolved, what was found, or why nothing was. */
type PickState =
	| { status: "loading"; url: string; viewport: PreviewViewport; point: { x: number; y: number } }
	| { status: "ready"; pick: PreviewPick }
	| { status: "error"; message: string };

export interface PreviewSheetProps {
	client: CompanionClient;
	/** Companion host of the session whose dev server is shown. */
	instanceId: string;
	/** The session's own id: what is remembered (page, screen size, auto refresh) is kept per session. */
	sessionId: string;
	/** Completed file edits in the transcript so far; each increase re-captures the page while auto refresh is on. */
	edits: number;
	/** Puts files and a note into the message box of this session; null when this guest cannot send. */
	onAddToPrompt: ((files: File[], note: string) => void) | null;
	onClose(): void;
}

/**
 * Screenshot of a page on the paired computer (a dev server the session runs), taken by headless Chrome there at a
 * phone, tablet or desktop size. It re-captures when the agent finishes editing files, while this sheet is open and
 * the page is visible, and keeps the last image on screen while the next one loads.
 */
export function PreviewSheet({
	client,
	instanceId,
	sessionId,
	edits,
	onAddToPrompt,
	onClose,
}: PreviewSheetProps): ReactNode {
	const [prefs] = useState(() => loadPreviewPrefs(sessionId));
	const [input, setInput] = useState(prefs.url ?? "");
	const [active, setActive] = useState<string | null>(prefs.url);
	const [viewport, setViewport] = useState(prefs.viewport);
	const [auto, setAuto] = useState(prefs.auto);
	const [full, setFull] = useState(prefs.full);
	const [targets, setTargets] = useState<PreviewTarget[] | null>(null);
	const [shot, setShot] = useState<PreviewShot | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [, setTick] = useState(0);
	const [picking, setPicking] = useState(false);
	const [pickState, setPickState] = useState<PickState | null>(null);
	/** A pick asked for while another is still being resolved: the newest wins. */
	const pickSeq = useRef(0);
	const imgRef = useRef<HTMLImageElement>(null);
	const viewRef = useRef<HTMLDivElement>(null);
	const closed = useRef(false);
	const inFlight = useRef(false);
	/** A capture asked for while one runs: the newest ask wins and runs when the current one ends. */
	const queued = useRef<Target | null>(null);
	const latest = useRef({ active, viewport, auto, full });
	/** The agent changed files since the last capture and nothing re-captured yet (page hidden, auto refresh off). */
	const stale = useRef(false);
	const seenEdits = useRef(edits);
	const debounce = useRef<Timer | undefined>(undefined);

	useEffect(() => {
		latest.current = { active, viewport, auto, full };
	});

	// One capture at a time: Chrome on the computer is busy for a second or more, and the companion queues the rest.
	const capture = useCallback(
		async (first: Target): Promise<void> => {
			if (inFlight.current) {
				queued.current = first;
				return;
			}
			inFlight.current = true;
			setLoading(true);
			stale.current = false;
			let next: Target | null = first;
			while (next !== null && !closed.current) {
				try {
					const taken = await client.requestPreview(instanceId, next.url, next.viewport, latest.current.full);
					if (closed.current) break;
					setShot(taken);
					setError(null);
					savePreviewPrefs(sessionId, { url: next.url });
				} catch (err) {
					if (closed.current) break;
					setError(err instanceof Error ? err.message : String(err));
				}
				next = queued.current;
				queued.current = null;
			}
			inFlight.current = false;
			if (!closed.current) setLoading(false);
		},
		[client, instanceId, sessionId],
	);

	const loadTargets = useCallback(async (): Promise<PreviewTarget[]> => {
		try {
			const found = await client.requestPreviewTargets(instanceId);
			if (!closed.current) setTargets(found);
			return found;
		} catch (err) {
			if (!closed.current) {
				setTargets([]);
				setError(err instanceof Error ? err.message : String(err));
			}
			return [];
		}
	}, [client, instanceId]);

	const show = useCallback(
		(url: string, size: PreviewViewport): void => {
			const next = SCHEME_RE.test(url) ? url : `http://${url}`;
			setInput(next);
			setActive(next);
			void capture({ url: next, viewport: size });
		},
		[capture],
	);

	useEffect(() => {
		closed.current = false;
		void loadTargets().then(found => {
			// Nothing remembered for this session: start with the first dev server it runs.
			const first = found[0];
			if (prefs.url === null && first !== undefined && !closed.current) show(first.url, prefs.viewport);
		});
		if (prefs.url !== null) void capture({ url: prefs.url, viewport: prefs.viewport });
		return () => {
			closed.current = true;
			clearTimeout(debounce.current);
		};
	}, [capture, loadTargets, show, prefs]);

	// Re-capture after the agent's edits, once they stop for a moment.
	useEffect(() => {
		if (edits === seenEdits.current) return;
		seenEdits.current = edits;
		stale.current = true;
		clearTimeout(debounce.current);
		debounce.current = setTimeout(() => {
			const { active: url, viewport: size, auto: on } = latest.current;
			if (on && url !== null && document.visibilityState === "visible") void capture({ url, viewport: size });
		}, AUTO_DEBOUNCE_MS);
	}, [edits, capture]);

	// Changes that landed while the page was hidden show up as soon as it is back.
	useEffect(() => {
		const onVisible = (): void => {
			const { active: url, viewport: size, auto: on } = latest.current;
			if (document.visibilityState === "visible" && stale.current && on && url !== null) {
				void capture({ url, viewport: size });
			}
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => document.removeEventListener("visibilitychange", onVisible);
	}, [capture]);

	// "Captured 12s ago" ticks while the sheet is open.
	useEffect(() => {
		const timer = setInterval(() => setTick(t => t + 1), 1_000);
		return () => clearInterval(timer);
	}, []);

	const src = useMemo(() => (shot === null ? null : `data:${shot.mimeType};base64,${shot.data}`), [shot]);

	const onSubmit = (e: FormEvent): void => {
		e.preventDefault();
		const url = input.trim();
		if (url !== "") show(url, viewport);
	};
	const pickViewport = (id: PreviewViewport): void => {
		setViewport(id);
		savePreviewPrefs(sessionId, { viewport: id });
		if (active !== null) void capture({ url: active, viewport: id });
	};
	const toggleAuto = (): void => {
		const on = !auto;
		setAuto(on);
		savePreviewPrefs(sessionId, { auto: on });
		if (on && stale.current && active !== null) void capture({ url: active, viewport });
	};
	const toggleFull = (): void => {
		const on = !full;
		setFull(on);
		// The capture below reads it before the next render updates the ref.
		latest.current.full = on;
		savePreviewPrefs(sessionId, { full: on });
		if (active !== null) void capture({ url: active, viewport });
	};
	const refresh = (): void => {
		void loadTargets();
		if (active !== null) void capture({ url: active, viewport });
	};

	// Design mode: Esc leaves it (before the sheet sees the key and closes), P toggles it outside text fields.
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.defaultPrevented) return;
			if (e.key === "Escape") {
				if (!picking) return;
				e.preventDefault();
				setPicking(false);
				return;
			}
			if (e.key.toLowerCase() !== "p" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat) return;
			const target = e.target;
			if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)))
				return;
			// With sheets stacked, only the top one answers.
			const sheet = viewRef.current?.closest(".sh-sheet");
			const floating = document.querySelectorAll(".sh-sheet:not(.sh-sheet-docked)");
			if (sheet && !sheet.classList.contains("sh-sheet-docked") && floating[floating.length - 1] !== sheet) return;
			e.preventDefault();
			setPicking(on => !on);
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [picking]);

	// A click on the screenshot asks the computer for the element at that point of the page: the screenshot's own page and
	// screen size, so the point means what the image shows.
	const pickAt = (e: MouseEvent<HTMLElement>): void => {
		const img = imgRef.current;
		if (shot === null || img === null) return;
		const point = shotPoint(
			{ x: e.clientX, y: e.clientY },
			img.getBoundingClientRect(),
			{ width: shot.width / PREVIEW_SCALE, height: shot.height / PREVIEW_SCALE },
		);
		if (point === null) return;
		const seq = ++pickSeq.current;
		setPickState({ status: "loading", url: shot.url, viewport: shot.viewport, point });
		client.requestPreviewPick(instanceId, shot.url, shot.viewport, point.x, point.y).then(
			pick => {
				if (!closed.current && seq === pickSeq.current) setPickState({ status: "ready", pick });
			},
			err => {
				if (closed.current || seq !== pickSeq.current) return;
				setPickState({ status: "error", message: err instanceof Error ? err.message : String(err) });
			},
		);
	};
	const dismissPick = (): void => {
		pickSeq.current++;
		setPickState(null);
	};
	const addToPrompt = (pick: PreviewPick): void => {
		if (onAddToPrompt === null) return;
		onAddToPrompt([pickCropFile(pick)], pickPrompt(pick));
		onClose();
	};

	return (
		<Sheet label="preview" size="full" pane="preview" onClose={onClose}>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title">Preview</div>
				<span className="sh-file-actions">
					<button
						type="button"
						className={auto ? "sh-btn sh-btn-on" : "sh-btn"}
						onClick={toggleAuto}
						aria-pressed={auto}
						title="Capture again when the agent changes files"
					>
						Auto {auto ? "on" : "off"}
					</button>
					<button
						type="button"
						className={full ? "sh-btn sh-btn-on" : "sh-btn"}
						onClick={toggleFull}
						aria-pressed={full}
						title="Capture the whole page, not just the first screen"
					>
						Full page
					</button>
					<button
						type="button"
						className={picking ? "sh-btn sh-btn-on" : "sh-btn"}
						onClick={() => setPicking(on => !on)}
						aria-pressed={picking}
						aria-label="Pick element"
						title="Pick an element on the page and add it to the prompt (P; Esc to leave)"
					>
						<MousePointerClick size={14} /> <span className="sh-btn-label">Pick element</span>
					</button>
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={refresh}
						disabled={loading}
						aria-label="Refresh preview"
						title="Refresh"
					>
						<RefreshCw size={15} className={loading ? "sh-spin" : undefined} />
					</button>
					<SheetPlacementButton />
					<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="Close">
						<X size={16} />
					</button>
				</span>
			</div>
			<form className="sh-preview-url" onSubmit={onSubmit}>
				<input
					className="sh-input sh-input-mono"
					value={input}
					onChange={e => setInput(e.currentTarget.value)}
					placeholder="http://localhost:3000"
					inputMode="url"
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
					aria-label="Page address"
				/>
				<button type="submit" className="sh-btn" disabled={input.trim() === ""}>
					Go
				</button>
			</form>
			<div className="sh-preview-bar">
				<div className="sh-segmented" role="radiogroup" aria-label="Screen size">
					{VIEWPORTS.map(({ id, label, Icon }) => (
						<button
							key={id}
							type="button"
							role="radio"
							aria-checked={viewport === id}
							className={viewport === id ? "sh-segment sh-segment-on" : "sh-segment"}
							onClick={() => pickViewport(id)}
						>
							<Icon size={14} /> {label}
						</button>
					))}
				</div>
				{targets?.map(target => (
					<button
						key={target.port}
						type="button"
						className="sh-chip sh-preview-target"
						aria-pressed={active === target.url}
						onClick={() => show(target.url, viewport)}
						title={target.url}
					>
						:{target.port} {target.command}
					</button>
				))}
			</div>
			{error !== null && <div className="sh-connect-error">{error}</div>}
			<div className="sh-preview-view" ref={viewRef}>
				{shot !== null && src !== null ? (
					<div className="sh-preview-stage" style={{ maxWidth: shot.width / PREVIEW_SCALE }}>
						{picking ? (
							// Not a button: a keyboard press has no point on the page to resolve.
							<div
								className="sh-preview-shot sh-preview-shot-pick"
								onClick={pickAt}
								role="application"
								aria-label="Click the page to pick an element"
							>
								<img
									ref={imgRef}
									src={src}
									width={shot.width / PREVIEW_SCALE}
									height={shot.height / PREVIEW_SCALE}
									alt={`Preview of ${shot.url}`}
									draggable={false}
								/>
							</div>
						) : (
							<button
								type="button"
								className="sh-preview-shot"
								onClick={() => openImage({ type: "image", data: shot.data, mimeType: shot.mimeType })}
								aria-label="Open the preview full size"
							>
								<img
									ref={imgRef}
									src={src}
									width={shot.width / PREVIEW_SCALE}
									height={shot.height / PREVIEW_SCALE}
									alt={`Preview of ${shot.url}`}
								/>
							</button>
						)}
						{pickState?.status === "ready" && pickState.pick.url === shot.url && pickState.pick.viewport === shot.viewport && (
							<div
								className="sh-preview-box"
								style={{
									left: `${(pickState.pick.box.x / (shot.width / PREVIEW_SCALE)) * 100}%`,
									top: `${(pickState.pick.box.y / (shot.height / PREVIEW_SCALE)) * 100}%`,
									width: `${(pickState.pick.box.width / (shot.width / PREVIEW_SCALE)) * 100}%`,
									height: `${(pickState.pick.box.height / (shot.height / PREVIEW_SCALE)) * 100}%`,
								}}
							/>
						)}
						{pickState?.status === "loading" && pickState.url === shot.url && pickState.viewport === shot.viewport && (
							<div
								className="sh-preview-marker"
								style={{
									left: `${(pickState.point.x / (shot.width / PREVIEW_SCALE)) * 100}%`,
									top: `${(pickState.point.y / (shot.height / PREVIEW_SCALE)) * 100}%`,
								}}
							/>
						)}
					</div>
				) : (
					<div className="sh-companion-empty sh-file-status">
						{loading ? (
							<>
								<LoaderCircle size={14} className="sh-spin" /> Capturing the page…
							</>
						) : targets !== null && targets.length === 0 ? (
							"No dev server found in this session's folder. Start one, or enter its address above."
						) : (
							"Enter the address of a page on your computer."
						)}
					</div>
				)}
			</div>
			{pickState !== null && (
				<div className="sh-preview-pick" role="status">
					{pickState.status === "loading" ? (
						<>
							<LoaderCircle size={14} className="sh-spin" /> Finding the element…
						</>
					) : pickState.status === "error" ? (
						<>
							<span className="sh-connect-error">{pickState.message}</span>
							<button type="button" className="sh-btn sh-btn-icon" onClick={dismissPick} aria-label="Dismiss">
								<X size={14} />
							</button>
						</>
					) : (
						<>
							<img
								className="sh-preview-pick-crop"
								src={`data:${pickState.pick.crop.mimeType};base64,${pickState.pick.crop.data}`}
								alt={`The picked ${pickState.pick.tag} element`}
							/>
							<div className="sh-preview-pick-info">
								<div className="sh-preview-pick-head">
									<span className="sh-chip sh-preview-pick-tag">&lt;{pickState.pick.tag}&gt;</span>
									<span className="sh-preview-pick-size">
										{Math.round(pickState.pick.box.width)}×{Math.round(pickState.pick.box.height)}
									</span>
								</div>
								<code className="sh-preview-pick-selector" title={pickState.pick.selector}>
									{pickState.pick.selector}
								</code>
							</div>
							<button
								type="button"
								className="sh-btn sh-btn-primary"
								onClick={() => addToPrompt(pickState.pick)}
								disabled={onAddToPrompt === null}
								title={onAddToPrompt === null ? "This session is read-only" : "Attach its picture and details to the message box"}
							>
								Add to prompt
							</button>
							<button type="button" className="sh-btn sh-btn-icon" onClick={dismissPick} aria-label="Dismiss">
								<X size={14} />
							</button>
						</>
					)}
				</div>
			)}
			{shot !== null && (
				<div className="sh-preview-foot">
					{loading ? (
						<>
							<LoaderCircle size={12} className="sh-spin" /> Capturing…
						</>
					) : (
						`Captured ${relTime(shot.at)} · ${shot.url}`
					)}
				</div>
			)}
		</Sheet>
	);
}
