import { LoaderCircle, Pencil, RefreshCw, Save, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CompanionClient, FileContent } from "../../lib/companion";
import { FileChangedError } from "../../lib/companion";
import { openCanvas } from "../../lib/diagram-store";
import { diagramFileKind } from "../../lib/diagrams";
import { parseScene } from "../../lib/excalidraw-scene";
import { standaloneSvg, svgSize } from "../../lib/svg";
import { useRequest } from "../../lib/use-request";
import { DownloadButton } from "../shell/DownloadButton";
import { Sheet } from "../shell/Sheet";
import { type CanvasSave, CanvasSheet } from "./CanvasSheet";
import { PanZoom } from "./PanZoom";
import { useDiagram } from "./use-diagram";

/** How long typing in a Mermaid file pauses before the preview renders. */
const PREVIEW_DELAY_MS = 400;
const FALLBACK_SIZE = { width: 800, height: 600 };

export interface DiagramFileSheetProps {
	client: CompanionClient;
	instanceId: string;
	/** Absolute, or relative to the session's working directory. */
	path: string;
	/** This device may change files on the computer: the app's editor is available and the link is not view-only. */
	canWrite: boolean;
	/** Puts files and a note into the message box; null when this guest cannot send. */
	onAttach: ((files: File[], note: string) => void) | null;
	onClose(): void;
}

function baseName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

/** Why `file` cannot be saved from here, or null when it can. */
function unsavable(file: FileContent, canWrite: boolean): string | null {
	if (!canWrite) return "Saving needs the editor on a paired computer with a writer link: download the file instead.";
	if (!file.writable)
		return "This file cannot be saved from here (it is read-only, truncated or sandboxed): download it instead.";
	return null;
}

/** A diagram file of the session's repository: `.excalidraw` opens on the canvas, `.mmd` / `.mermaid` in a source editor with a preview. */
export function DiagramFileSheet({
	client,
	instanceId,
	path,
	canWrite,
	onAttach,
	onClose,
}: DiagramFileSheetProps): ReactNode {
	const load = useCallback(() => client.requestFile(instanceId, path), [client, instanceId, path]);
	const { state, reload } = useRequest(load);
	if (state.status === "ready") {
		const common = { client, instanceId, path, file: state.value, canWrite, onAttach, onClose };
		return diagramFileKind(path) === "excalidraw" ? <SceneFile {...common} /> : <MermaidFile {...common} />;
	}
	return (
		<Sheet label="diagram file" size="full" onClose={onClose}>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title sh-file-path" title={path}>
					{baseName(path)}
				</div>
				<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="close">
					<X size={16} />
				</button>
			</div>
			{state.status === "loading" && (
				<div className="sh-companion-empty sh-file-status">
					<LoaderCircle size={14} className="sh-spin" /> Loading…
				</div>
			)}
			{state.status === "error" && (
				<div className="sh-tree-error">
					<div className="sh-connect-error">{state.message}</div>
					<button type="button" className="sh-btn" onClick={reload}>
						<RefreshCw size={14} /> Retry
					</button>
				</div>
			)}
		</Sheet>
	);
}

interface LoadedFileProps extends DiagramFileSheetProps {
	file: FileContent;
}

/** Writes through the paired computer's file save, tracking the version it hands back so a second save is not refused as a conflict. */
function useSaver({ client, instanceId, path, file, canWrite }: LoadedFileProps): {
	run: ((text: string) => Promise<void>) | null;
	reason: string | undefined;
} {
	const version = useRef(file.version);
	const reason = unsavable(file, canWrite);
	const run = useCallback(
		async (text: string): Promise<void> => {
			try {
				version.current = await client.writeFile(instanceId, path, text, version.current);
			} catch (error) {
				if (error instanceof FileChangedError) {
					throw new Error(
						"The file changed on the computer since it was opened. Download your version and reopen the file.",
					);
				}
				throw error;
			}
		},
		[client, instanceId, path],
	);
	return { run: reason === null ? run : null, reason: reason ?? undefined };
}

function SceneFile(props: LoadedFileProps): ReactNode {
	const { file, path, onAttach, onClose } = props;
	const saver = useSaver(props);
	const parsed = useMemo(
		() => (file.text === null || file.text.trim() === "" ? null : parseScene(file.text)),
		[file.text],
	);
	const source = useMemo(
		() => (parsed?.ok ? { kind: "scene" as const, scene: parsed.scene } : { kind: "blank" as const }),
		[parsed],
	);
	if (file.text === null || (parsed !== null && !parsed.ok)) {
		return (
			<Sheet label="diagram file" size="full" onClose={onClose}>
				<div className="sh-sheet-head">
					<div className="sh-sheet-title sh-file-path" title={path}>
						{baseName(path)}
					</div>
					<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="close">
						<X size={16} />
					</button>
				</div>
				<div className="sh-connect-error">
					{file.text === null
						? "Binary file, not shown."
						: `This is not a usable Excalidraw file: ${parsed?.ok === false ? parsed.error : ""}`}
				</div>
			</Sheet>
		);
	}
	const save: CanvasSave = {
		fileName: baseName(path),
		run: saver.run,
		reason: saver.reason,
	};
	return (
		<CanvasSheet
			title={baseName(path)}
			name={baseName(path).replace(/\.excalidraw$/i, "")}
			source={source}
			onAttach={onAttach}
			save={save}
			onClose={onClose}
		/>
	);
}

function MermaidFile(props: LoadedFileProps): ReactNode {
	const { client, instanceId, file, path, onClose } = props;
	const saver = useSaver(props);
	const [text, setText] = useState(file.text ?? "");
	const [shown, setShown] = useState(text);
	const [dirty, setDirty] = useState(false);
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	useEffect(() => {
		const timer = setTimeout(() => setShown(text), PREVIEW_DELAY_MS);
		return () => clearTimeout(timer);
	}, [text]);
	const { state, retry } = useDiagram("mermaid", shown);
	const ready = state.status === "ready" ? state.svg : null;
	const size = useMemo(() => (ready === null ? FALLBACK_SIZE : (svgSize(ready) ?? FALLBACK_SIZE)), [ready]);
	const display = useMemo(() => (ready === null ? "" : standaloneSvg(ready, size)), [ready, size]);

	const requestClose = (): void => {
		if (dirty && !confirm(`Discard unsaved changes to ${baseName(path)}?`)) return;
		onClose();
	};
	const writable = saver.run !== null;
	const save = async (): Promise<void> => {
		if (saver.run === null || busy) return;
		setBusy(true);
		setProblem(null);
		try {
			await saver.run(text);
			setDirty(false);
		} catch (error) {
			setProblem(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Sheet label="diagram file" size="full" onClose={requestClose}>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title sh-file-path" title={path}>
					{baseName(path)}
					{dirty && <span className="sh-ide-dot sh-ide-dot-on" aria-label="unsaved" />}
				</div>
				<span className="sh-diagram-actions">
					{writable && (
						<button
							type="button"
							className="sh-btn sh-btn-primary"
							onClick={() => void save()}
							disabled={!dirty || busy}
							title={`save ${baseName(path)}`}
						>
							{busy ? <LoaderCircle size={15} className="sh-spin" /> : <Save size={15} />}{" "}
							<span className="sh-btn-label">Save</span>
						</button>
					)}
					<button
						type="button"
						className="sh-btn"
						onClick={() =>
							openCanvas(`Edit ${baseName(path)}`, baseName(path).replace(/\.[^.]+$/, ""), {
								kind: "mermaid",
								source: text,
							})
						}
						disabled={ready === null}
						title="edit on the canvas: the result is sent to the agent or downloaded, not saved over this file"
					>
						<Pencil size={14} /> <span className="sh-btn-label">Canvas</span>
					</button>
					<DownloadButton client={client} instanceId={instanceId} path={path} />
					<button type="button" className="sh-btn sh-btn-icon" onClick={requestClose} aria-label="close">
						<X size={16} />
					</button>
				</span>
			</div>
			{saver.reason !== undefined && <div className="sh-file-note">{saver.reason}</div>}
			{props.file.truncated && (
				<div className="sh-file-note">Showing the start of the file only: it is larger than the viewer reads.</div>
			)}
			{problem !== null && <div className="sh-connect-error">{problem}</div>}
			<div className="sh-mmd">
				<textarea
					className="sh-input sh-mmd-source"
					value={text}
					readOnly={!writable}
					onChange={e => {
						setText(e.target.value);
						setDirty(true);
					}}
					onKeyDown={e => e.stopPropagation()}
					spellCheck={false}
					aria-label="Mermaid source"
				/>
				<div className="sh-mmd-preview">
					{state.status === "loading" && (
						<div className="sh-companion-empty sh-file-status">
							<LoaderCircle size={14} className="sh-spin" /> Rendering…
						</div>
					)}
					{(state.status === "error" || state.status === "unavailable") && (
						<div className="sh-tree-error">
							<div className="sh-connect-error">
								{state.status === "unavailable"
									? `The renderer could not be loaded: ${state.message}`
									: state.message}
							</div>
							{state.status === "unavailable" && (
								<button type="button" className="sh-btn" onClick={retry}>
									<RefreshCw size={14} /> Retry
								</button>
							)}
						</div>
					)}
					{ready !== null && (
						<PanZoom size={size}>
							<div className="sh-diagram-art" dangerouslySetInnerHTML={{ __html: display }} />
						</PanZoom>
					)}
				</div>
			</div>
		</Sheet>
	);
}
