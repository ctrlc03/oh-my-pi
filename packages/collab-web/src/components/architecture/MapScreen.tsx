import type { Blueprint, BlueprintExcerpt } from "@oh-my-pi/pi-wire/blueprint";
import { ChevronLeft, LoaderCircle, RefreshCw, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CompanionClient } from "../../lib/companion";
import { HIGHLIGHT_MAX_CHARS, languageOf, loadHighlighter } from "../../lib/highlight";
import { useRequest } from "../../lib/use-request";
import type { EditorAccess, MapSource } from "./DetailPanel";
import { ExportMenu } from "./ExportMenu";
import { MapViewer } from "./MapViewer";
import { EXCERPT_BATCH, getBlueprint, getExcerpts } from "./blueprint-api";
import type { MapLocation } from "./blueprint-model";
import { rootDiagram } from "./blueprint-model";

export interface MapScreenProps {
	client: CompanionClient;
	id: string;
	/** Host of the session on screen, for reading its checkout's git state; null from the start screen. */
	instanceId: string | null;
	/** Show a file of the session's repository, scrolled to `line`. Absent when the computer cannot edit files. */
	onOpenFile?(path: string, line?: number): void;
	onBack(): void;
	onClose(): void;
}

/** Where each map was last looked at, so closing the sheet and coming back resumes. */
const lastLocation = new Map<string, MapLocation>();

/** The app's highlighter over an excerpt's lines; undefined where the file type has no grammar. */
async function highlightExcerpt(excerpt: { path: string; lines: string[] }): Promise<string | undefined> {
	const language = languageOf(excerpt.path);
	const text = excerpt.lines.join("\n");
	if (language === undefined || text.length > HIGHLIGHT_MAX_CHARS) return undefined;
	const hljs = await loadHighlighter();
	return hljs.highlight(text, { language, ignoreIllegals: true }).value;
}

/**
 * The cited lines can be opened in the editor only when the map was made from the checkout that is open: the same
 * commit is checked out there (so the lines are where the map says), or, for a map of uncommitted work, the same folder.
 */
function useEditorAccess(
	client: CompanionClient,
	instanceId: string | null,
	map: Blueprint,
	onOpenFile: ((path: string, line?: number) => void) | undefined,
): EditorAccess | null {
	const [access, setAccess] = useState<EditorAccess | null>(null);
	const headCommit = map.head.commit;
	const headRef = map.head.ref;
	const repoRoot = map.repo.root;
	useEffect(() => {
		setAccess(null);
		if (onOpenFile === undefined || instanceId === null) return;
		let live = true;
		client.requestGit(instanceId).then(
			git => {
				if (!live) return;
				const head = git.commits[0]?.hash ?? "";
				const sameCommit = head !== "" && (head.startsWith(headCommit) || headCommit.startsWith(head));
				const worktree = headRef === "@worktree" && git.root === repoRoot;
				if (!sameCommit && !worktree) return;
				const note = worktree
					? "Opens the file as it is now: it may have changed since the map was made."
					: git.files.length > 0
						? "This checkout has uncommitted changes, so a line may have moved."
						: undefined;
				setAccess({ note, open: ref => onOpenFile(`${git.root}/${ref.path}`, ref.line) });
			},
			// No git state: the code stays readable in the panel, only the editor shortcut is withheld.
			() => {},
		);
		return () => {
			live = false;
		};
	}, [client, instanceId, headCommit, headRef, repoRoot, onOpenFile]);
	return access;
}

/** A stored map in the viewer, with the sheet's back and close controls and the HTML export. */
export function MapScreen({ client, id, instanceId, onOpenFile, onBack, onClose }: MapScreenProps): ReactNode {
	const load = useCallback(() => getBlueprint(client, id), [client, id]);
	const { state, reload } = useRequest(load);
	const back = (
		<button type="button" className="ar-btn ar-btn-icon" onClick={onBack} aria-label="Back to the maps">
			<ChevronLeft size={16} />
		</button>
	);
	if (state.status !== "ready") {
		return (
			<div className="ar-viewer-host">
				<div className="ar-bar">
					<div className="ar-bar-main">{back}</div>
					<button type="button" className="ar-btn ar-btn-icon" onClick={onClose} aria-label="Close">
						<X size={16} />
					</button>
				</div>
				{state.status === "loading" ? (
					<div className="ar-status ar-status-center">
						<LoaderCircle size={14} className="ar-spin" /> Opening the map…
					</div>
				) : (
					<div className="ar-status ar-status-center ar-error" role="alert">
						{state.message}
						<button type="button" className="ar-btn" onClick={reload}>
							<RefreshCw size={14} /> Retry
						</button>
					</div>
				)}
			</div>
		);
	}
	return (
		<LoadedMap
			client={client}
			map={state.value}
			instanceId={instanceId}
			onOpenFile={onOpenFile}
			leading={back}
			onClose={onClose}
		/>
	);
}

function LoadedMap({
	client,
	map,
	instanceId,
	onOpenFile,
	leading,
	onClose,
}: {
	client: CompanionClient;
	map: Blueprint;
	instanceId: string | null;
	onOpenFile?: (path: string, line?: number) => void;
	leading: ReactNode;
	onClose(): void;
}): ReactNode {
	const [location, setLocation] = useState<MapLocation>(
		() => lastLocation.get(map.id) ?? { diagram: rootDiagram(map)?.id ?? "" },
	);
	const move = useCallback(
		(next: MapLocation): void => {
			lastLocation.set(map.id, next);
			setLocation(next);
		},
		[map.id],
	);
	const source = useMemo<MapSource>(
		() => ({
			// A map's citations can number thousands: ask in batches the companion answers promptly.
			excerpts: async refs => {
				const out: (BlueprintExcerpt | null)[] = [];
				for (let at = 0; at < refs.length; at += EXCERPT_BATCH) {
					out.push(...(await getExcerpts(client, map.id, refs.slice(at, at + EXCERPT_BATCH))));
				}
				return out;
			},
			highlight: highlightExcerpt,
		}),
		[client, map.id],
	);
	const editor = useEditorAccess(client, instanceId, map, onOpenFile);
	return (
		<div className="ar-viewer-host">
			<MapViewer
				map={map}
				source={source}
				location={location}
				onLocation={move}
				leading={leading}
				editor={editor}
				actions={
					<>
						<ExportMenu map={map} source={source} />
						<button type="button" className="ar-btn ar-btn-icon" onClick={onClose} aria-label="Close">
							<X size={16} />
						</button>
					</>
				}
			/>
		</div>
	);
}
