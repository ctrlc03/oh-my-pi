import type { ReactNode } from "react";
import { useState } from "react";
import { computerById, type ComputerHandle } from "../../lib/computers";
import { Sheet } from "../shell/Sheet";
import "./architecture.css";
import { MapList } from "./MapList";
import { MapScreen } from "./MapScreen";
import type { NewMapPreset } from "./NewMapForm";
import { NewMapForm } from "./NewMapForm";

/** What the sheet opens on. */
export type ArchitectureStart = { view: "home" } | { view: "new"; preset?: NewMapPreset };

export interface ArchitectureSheetProps {
	computers: readonly ComputerHandle[];
	/** The computer of the session on screen; null from the start screen, where every computer's maps are listed. */
	computerId: string | null;
	/** The session's folder (on `computerId`); null from the start screen, where every repository's maps are listed. */
	cwd: string | null;
	/** Host of the session on screen, on `computerId` (reads its checkout so cited lines can open in the editor); null from the start screen. */
	instanceId: string | null;
	start: ArchitectureStart;
	/** Fetch a link for a hosting session on a computer and join it; rejects with a readable message. */
	onOpenHost(computerId: string, instanceId: string): Promise<void>;
	/** Show a file of the session's checkout, scrolled to `line` when given. */
	onOpenFile?(path: string, line?: number): void;
	onClose(): void;
}

type Screen =
	| { kind: "home" }
	| { kind: "new"; preset?: NewMapPreset }
	| { kind: "map"; computerId: string; id: string };

/**
 * Architecture maps: the list of a repository's maps (those of every computer that makes them), the form that
 * starts one, and the viewer that opens a finished map (see `MapViewer`). Progress of running maps arrives by push.
 */
export function ArchitectureSheet({
	computers,
	computerId,
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
	const mapClient = screen.kind === "map" ? (computerById(computers, screen.computerId)?.client ?? null) : null;
	// The open session's checkout is only on its own computer: a map of another computer cannot open its lines there.
	const onSessionComputer = screen.kind === "map" && screen.computerId === computerId;
	return (
		<Sheet label="architecture maps" size="full" onClose={onClose}>
			{screen.kind === "home" && (
				<MapList
					computers={computers}
					computerId={computerId}
					cwd={cwd}
					currentInstanceId={instanceId}
					onOpen={(mapComputerId, id) => setScreen({ kind: "map", computerId: mapComputerId, id })}
					onNew={() => setScreen({ kind: "new" })}
					onOpenHost={async (hostComputerId, id) => {
						await onOpenHost(hostComputerId, id);
						onClose();
					}}
				/>
			)}
			{screen.kind === "new" && (
				<NewMapForm
					computers={computers}
					computerId={computerId}
					cwd={cwd}
					preset={screen.preset}
					onBack={home}
					onStarted={home}
					onClose={onClose}
				/>
			)}
			{screen.kind === "map" && mapClient !== null && (
				<MapScreen
					client={mapClient}
					id={screen.id}
					instanceId={onSessionComputer ? instanceId : null}
					onOpenFile={onSessionComputer ? onOpenFile : undefined}
					onBack={home}
					onClose={onClose}
				/>
			)}
			{screen.kind === "map" && mapClient === null && (
				<div className="ar-viewer-host">
					<div className="ar-status ar-status-center ar-error" role="alert">
						This computer is not connected.
						<button type="button" className="ar-btn" onClick={home}>
							Back to the maps
						</button>
					</div>
				</div>
			)}
		</Sheet>
	);
}
