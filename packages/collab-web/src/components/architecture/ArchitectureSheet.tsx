import type { ReactNode } from "react";
import { useState } from "react";
import type { CompanionClient } from "../../lib/companion";
import { Sheet } from "../shell/Sheet";
import "./architecture.css";
import { MapList } from "./MapList";
import { MapScreen } from "./MapScreen";
import type { NewMapPreset } from "./NewMapForm";
import { NewMapForm } from "./NewMapForm";

/** What the sheet opens on. */
export type ArchitectureStart = { view: "home" } | { view: "new"; preset?: NewMapPreset };

export interface ArchitectureSheetProps {
	client: CompanionClient;
	/** The session's folder; null from the start screen, where every repository's maps are listed. */
	cwd: string | null;
	/** Host of the session on screen (reads its checkout so cited lines can open in the editor); null from the start screen. */
	instanceId: string | null;
	start: ArchitectureStart;
	/** Fetch a link for a hosting session and join it; rejects with a readable message. */
	onOpenHost(instanceId: string): Promise<void>;
	/** Show a file, scrolled to `line` when given. */
	onOpenFile?(path: string, line?: number): void;
	onClose(): void;
}

type Screen = { kind: "home" } | { kind: "new"; preset?: NewMapPreset } | { kind: "map"; id: string };

/**
 * Architecture maps: the list of a repository's maps, the form that starts one, and the viewer that opens
 * a finished map (see `MapViewer`). Progress of running maps arrives by push.
 */
export function ArchitectureSheet({
	client,
	cwd,
	instanceId,
	start,
	onOpenHost,
	onOpenFile,
	onClose,
}: ArchitectureSheetProps): ReactNode {
	const [screen, setScreen] = useState<Screen>(
		start.view === "new" ? { kind: "new", preset: start.preset } : { kind: "home" },
	);
	const home = (): void => setScreen({ kind: "home" });
	return (
		<Sheet label="architecture maps" size="full" onClose={onClose}>
			{screen.kind === "home" && (
				<MapList
					client={client}
					cwd={cwd}
					currentInstanceId={instanceId}
					onOpen={id => setScreen({ kind: "map", id })}
					onNew={() => setScreen({ kind: "new" })}
					onOpenHost={async id => {
						await onOpenHost(id);
						onClose();
					}}
				/>
			)}
			{screen.kind === "new" && (
				<NewMapForm
					client={client}
					cwd={cwd}
					preset={screen.preset}
					onBack={home}
					onStarted={home}
					onClose={onClose}
				/>
			)}
			{screen.kind === "map" && (
				<MapScreen
					client={client}
					id={screen.id}
					instanceId={instanceId}
					onOpenFile={onOpenFile}
					onBack={home}
					onClose={onClose}
				/>
			)}
		</Sheet>
	);
}
