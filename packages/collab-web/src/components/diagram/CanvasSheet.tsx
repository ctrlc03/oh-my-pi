import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { Download, FileImage, LoaderCircle, RefreshCw, Save, SendHorizontal, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasSource } from "../../lib/diagram-store";
import { saveBlob } from "../../lib/download";
import { loadExcalidraw } from "../../lib/excalidraw-load";
import { compactScene, parseScene, sceneNote } from "../../lib/excalidraw-scene";
import { MAX_INLINE_BYTES } from "../../lib/files";
import { useSystemTheme } from "../../lib/theme";
import { Sheet } from "../shell/Sheet";
import { buildCanvasInit, type CanvasInit, type ExcalidrawEngine } from "./canvas-data";

/** Room kept under the inline limit for the fence and file name the composer wraps the scene text in. */
const FENCE_ALLOWANCE = 512;

/** A diagram file the canvas edits in place. */
export interface CanvasSave {
	/** Name on the paired computer, for the title and for downloads. */
	fileName: string;
	/** Writes the scene JSON back to the file; null when the file cannot be saved from here (the reason is shown). */
	run: ((json: string) => Promise<void>) | null;
	reason?: string;
}

export interface CanvasSheetProps {
	title: string;
	/** Base name of what the canvas produces (`sketch` → `sketch.png`, `sketch.excalidraw`). */
	name: string;
	source: CanvasSource;
	/** Puts files and a note into the message box; null when this guest cannot send. */
	onAttach: ((files: File[], note: string) => void) | null;
	save?: CanvasSave;
	onClose(): void;
}

type Load =
	| { status: "loading" }
	| { status: "ready"; engine: ExcalidrawEngine; init: CanvasInit }
	| { status: "error"; message: string };

/** The Excalidraw canvas in a sheet: edit or sketch, then send to the agent, save to the file, or download. */
export function CanvasSheet({ title, name, source, onAttach, save, onClose }: CanvasSheetProps): ReactNode {
	const theme = useSystemTheme();
	const [load, setLoad] = useState<Load>({ status: "loading" });
	const [attempt, setAttempt] = useState(0);
	const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
	const [drawn, setDrawn] = useState(false);
	const [busy, setBusy] = useState<string | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	// Version of the scene as loaded, and the latest; they differ once the user has changed something.
	const baseline = useRef<number | null>(null);
	const latestVersion = useRef(0);
	// Read by the load below: the theme only colours the Mermaid image fallback and must not rebuild the canvas.
	const themeRef = useRef(theme);
	themeRef.current = theme;
	const [dirty, setDirty] = useState(false);

	useEffect(() => {
		let stale = false;
		setLoad({ status: "loading" });
		loadExcalidraw()
			.then(async engine => ({ engine, init: await buildCanvasInit(engine, source, themeRef.current) }))
			.then(
				ready => {
					if (stale) return;
					baseline.current = ready.engine.getSceneVersion(ready.init.elements);
					setDrawn(ready.init.elements.some(element => !element.isDeleted));
					setLoad({ status: "ready", ...ready });
				},
				(error: unknown) => {
					if (!stale)
						setLoad({ status: "error", message: error instanceof Error ? error.message : String(error) });
				},
			);
		return () => {
			stale = true;
		};
	}, [source, attempt]);

	const requestClose = useCallback((): void => {
		if (dirty && !confirm("Discard your changes to this drawing?")) return;
		onClose();
	}, [dirty, onClose]);

	/** The drawing as JSON (the whole scene) and PNG. */
	const exportParts = async (engine: ExcalidrawEngine): Promise<{ json: string; png: Blob }> => {
		if (api === null) throw new Error("the canvas is not ready");
		const elements = api.getSceneElements();
		const appState = api.getAppState();
		const files = api.getFiles();
		const json = engine.serializeAsJSON(elements, appState, files, "local");
		const png = await engine.exportToBlob({
			elements,
			appState: { ...appState, exportBackground: true, exportWithDarkMode: theme === "dark" },
			files,
			mimeType: "image/png",
			exportPadding: 24,
		});
		return { json, png };
	};

	const run = async (what: string, job: () => Promise<void>): Promise<void> => {
		if (busy !== null) return;
		setBusy(what);
		setProblem(null);
		try {
			await job();
		} catch (error) {
			setProblem(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(null);
		}
	};

	const send = (engine: ExcalidrawEngine): Promise<void> =>
		run("send", async () => {
			if (onAttach === null) return;
			const { json, png } = await exportParts(engine);
			const parsed = parseScene(json);
			if (!parsed.ok) throw new Error(parsed.error);
			const compact = compactScene(parsed.scene, MAX_INLINE_BYTES - FENCE_ALLOWANCE);
			if (!compact.ok) throw new Error(compact.error);
			const picture = `${name}.png`;
			const scene = `${name}.excalidraw`;
			const sceneFile = new File([compact.json], scene, { type: "application/json" });
			// Characters were budgeted; non-ASCII text makes the file larger than that.
			if (sceneFile.size > MAX_INLINE_BYTES) throw new Error("the drawing is too large to attach as a scene");
			onAttach([new File([png], picture, { type: "image/png" }), sceneFile], sceneNote(picture, scene));
			onClose();
		});

	const download = (engine: ExcalidrawEngine, format: "scene" | "png"): Promise<void> =>
		run(format, async () => {
			const { json, png } = await exportParts(engine);
			if (format === "png") await saveBlob(png, `${name}.png`);
			else await saveBlob(new Blob([json], { type: "application/json" }), save?.fileName ?? `${name}.excalidraw`);
		});

	const writeBack = (engine: ExcalidrawEngine): Promise<void> =>
		run("save", async () => {
			if (save?.run == null) return;
			const { json } = await exportParts(engine);
			await save.run(json);
			baseline.current = latestVersion.current;
			setDirty(false);
			setSaved(true);
		});

	const ready = load.status === "ready" ? load : null;
	const sketching = source.kind === "blank";
	return (
		<Sheet label="canvas" size="full" onClose={requestClose}>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title">{title}</div>
				<span className="sh-diagram-actions">
					{ready !== null && onAttach !== null && (
						<button
							type="button"
							className="sh-btn sh-btn-primary"
							onClick={() => void send(ready.engine)}
							disabled={busy !== null || !drawn || api === null}
							title="attach the drawing and its scene to your message"
						>
							{busy === "send" ? <LoaderCircle size={15} className="sh-spin" /> : <SendHorizontal size={15} />}{" "}
							<span className="sh-btn-label">{sketching ? "Done" : "Send to agent"}</span>
						</button>
					)}
					{ready !== null && save?.run != null && (
						<button
							type="button"
							className="sh-btn sh-btn-primary"
							onClick={() => void writeBack(ready.engine)}
							disabled={busy !== null || !dirty || api === null}
							title={`save ${save.fileName}`}
						>
							{busy === "save" ? <LoaderCircle size={15} className="sh-spin" /> : <Save size={15} />}{" "}
							<span className="sh-btn-label">{saved && !dirty ? "Saved" : "Save"}</span>
						</button>
					)}
					{ready !== null && (
						<>
							<button
								type="button"
								className="sh-btn sh-btn-icon"
								onClick={() => void download(ready.engine, "scene")}
								disabled={busy !== null || api === null}
								aria-label="download the scene"
								title={`download ${save?.fileName ?? `${name}.excalidraw`}`}
							>
								<Download size={15} />
							</button>
							<button
								type="button"
								className="sh-btn sh-btn-icon"
								onClick={() => void download(ready.engine, "png")}
								disabled={busy !== null || api === null || !drawn}
								aria-label="download PNG"
								title="download PNG"
							>
								<FileImage size={15} />
							</button>
						</>
					)}
					<button type="button" className="sh-btn sh-btn-icon" onClick={requestClose} aria-label="close">
						<X size={16} />
					</button>
				</span>
			</div>
			{save !== undefined && save.run === null && save.reason !== undefined && (
				<div className="sh-file-note">{save.reason}</div>
			)}
			{ready?.init.notice !== undefined && <div className="sh-file-note">{ready.init.notice}</div>}
			{problem !== null && <div className="sh-connect-error">{problem}</div>}
			{load.status === "loading" && (
				<div className="sh-companion-empty sh-file-status">
					<LoaderCircle size={14} className="sh-spin" /> Opening the canvas…
				</div>
			)}
			{load.status === "error" && (
				<div className="sh-tree-error">
					<div className="sh-connect-error">Could not open the canvas: {load.message}</div>
					<button type="button" className="sh-btn" onClick={() => setAttempt(n => n + 1)}>
						<RefreshCw size={14} /> Retry
					</button>
				</div>
			)}
			{ready !== null && (
				// Keys typed on the canvas are the canvas's: the app's single-key shortcuts must not see them.
				<div className="sh-canvas" onKeyDown={e => e.stopPropagation()}>
					<ready.engine.Excalidraw
						excalidrawAPI={setApi}
						initialData={{
							elements: ready.init.elements,
							files: ready.init.files,
							appState: ready.init.viewBackgroundColor
								? { viewBackgroundColor: ready.init.viewBackgroundColor }
								: undefined,
							scrollToContent: true,
						}}
						theme={theme}
						handleKeyboardGlobally={false}
						onChange={elements => {
							const version = ready.engine.getSceneVersion(elements);
							latestVersion.current = version;
							setDrawn(elements.some(element => !element.isDeleted));
							setDirty(baseline.current !== null && version !== baseline.current);
						}}
						UIOptions={{
							canvasActions: {
								loadScene: false,
								saveToActiveFile: false,
								export: false,
								saveAsImage: false,
								toggleTheme: false,
							},
						}}
					>
						<ready.engine.MainMenu>
							<ready.engine.MainMenu.DefaultItems.ClearCanvas />
							<ready.engine.MainMenu.DefaultItems.ChangeCanvasBackground />
							<ready.engine.MainMenu.DefaultItems.Help />
						</ready.engine.MainMenu>
					</ready.engine.Excalidraw>
				</div>
			)}
		</Sheet>
	);
}
