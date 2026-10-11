import type { SessionCommand } from "@oh-my-pi/pi-wire";
import { Maximize2, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ConnectionPhase, GuestClient } from "../../lib/client";
import { blobToBase64 } from "../../lib/images";
import { type RecentRoom, roomIdOf } from "../../lib/rooms";
import { focusedPane } from "../../lib/use-split";
import type { CompanionHandle } from "../../lib/use-companion";
import { useGuestSnapshot } from "../../lib/use-guest";
import { useHostRecovery } from "../../lib/use-host-recovery";
import { useNewSince } from "../../lib/new-since";
import { Transcript } from "../transcript/Transcript";
import { Composer, type ComposerHandle } from "./Composer";
import { useComposerExtras } from "./composer-extras";
import { useEditPrompt } from "./EditPromptSheet";
import { useTurnChanges } from "./TurnChangesSheet";
import "./split.css";

const PHASE_LABEL: Record<ConnectionPhase, string> = {
	connecting: "Connecting",
	waiting: "Joining",
	live: "Live",
	reconnecting: "Reconnecting",
	ended: "Ended",
};

export interface SplitPaneProps {
	client: GuestClient;
	link: string;
	companion: CompanionHandle | null;
	/** Chat view preference of the main session, shared so both panes read alike. */
	chat: boolean;
	onClose(): void;
	/** Reconnect to the same room with a fresh client. */
	onRejoin(): void;
	/** Make this session the main one (the pane closes). */
	onMakeMain(link: string): void;
	onRemember(room: Omit<RecentRoom, "lastSeen">): void;
	rooms: readonly RecentRoom[];
	/** The host replaced the room: follow it. */
	onReplaced(link: string): void;
	onRoomGone(roomId: string): void;
}

/**
 * A second, fully live session beside the main one: compact header, transcript and
 * composer on its own client. It has no agents rail, find or task bar; those stay
 * with the main session.
 */
export function SplitPane({
	client,
	link,
	companion,
	chat,
	onClose,
	onRejoin,
	onMakeMain,
	onRemember,
	rooms,
	onReplaced,
	onRoomGone,
}: SplitPaneProps): ReactNode {
	const snap = useGuestSnapshot(client);
	const roomId = useMemo(() => roomIdOf(link), [link]);
	const live = snap.phase === "live";
	const sessionId = snap.header?.id ?? null;
	const title = snap.state?.sessionName ?? snap.header?.title ?? "session";
	const cwd = snap.state?.cwd ?? snap.header?.cwd ?? null;
	const companionClient = companion?.client ?? null;
	const hostId = companion?.snap.hosts.find(host => host.sessionId === sessionId)?.instanceId ?? null;
	const storedInstance = rooms.find(room => room.roomId === roomId)?.instanceId;
	const instanceId = hostId ?? storedInstance ?? null;
	const composerExtras = useComposerExtras(
		snap,
		companionClient,
		hostId,
		companionClient !== null && hostId !== null && companion?.snap.canGithub === true,
	);

	// Remember the room, so a collapsed or closed pane's session stays one tap away in recents.
	useEffect(() => {
		if (live && roomId !== null)
			onRemember({ roomId, link, title, cwd, readOnly: snap.readOnly, instanceId: instanceId ?? undefined });
	}, [live, roomId, link, title, cwd, snap.readOnly, instanceId, onRemember]);

	const recovery = useHostRecovery(companion, instanceId, snap.phase, roomId, onReplaced);
	const ended = snap.phase === "ended" && recovery === "absent";
	const gone = ended && snap.endedReason === "no such room";
	useEffect(() => {
		if (gone && roomId !== null) onRoomGone(roomId);
	}, [gone, roomId, onRoomGone]);

	const composerRef = useRef<ComposerHandle>(null);
	const editPrompt = useEditPrompt(client, snap, composerRef);
	const turnChanges = useTurnChanges(client, snap, sessionId, composerRef);
	const sendToAgent = useCallback((text: string) => composerRef.current?.insert(text), []);
	const { newSince, seen: newSeen, markSeen, markTail } = useNewSince(client, roomId, snap.entries, live);
	const sendSessionCommand = useCallback(
		(cmd: SessionCommand, arg?: string) => client.sendSessionCommand(cmd, arg),
		[client],
	);
	const cancelQueued = useCallback((id: string) => client.cancelQueued(id), [client]);

	// Attachments the composer cannot inline are saved on the computer that hosts this session.
	const companionPhase = companion?.snap.phase;
	const canUpload = companion?.snap.canUpload === true;
	const upload = useMemo(
		() =>
			companionClient !== null &&
			hostId !== null &&
			canUpload &&
			!snap.readOnly &&
			(companionPhase === "live" || companionPhase === "connecting")
				? async (file: File): Promise<string> =>
						companionClient.uploadFile(hostId, file.name, await blobToBase64(file))
				: null,
		[companionClient, hostId, canUpload, snap.readOnly, companionPhase],
	);

	// Esc stops this pane's running turn while the pane has the focus (the main session's handler stands down).
	const working = snap.working;
	const readOnly = snap.readOnly;
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key !== "Escape" || e.isComposing || e.defaultPrevented) return;
			if (focusedPane() !== "beside" || document.querySelector('[role="dialog"]') !== null) return;
			if (live && !readOnly && working) client.sendAbort();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [client, live, readOnly, working]);

	const status = snap.uiRequest !== null ? "Needs input" : snap.working ? "Working" : PHASE_LABEL[snap.phase];

	return (
		<section className="sh-panel sh-split-pane" data-pane="beside" aria-label={`${title} beside`}>
			<header className="sh-split-head">
				<span className="sh-title sh-split-title" title={cwd ?? title}>
					{title}
				</span>
				<span className={`sh-status sh-status-${snap.phase}`} title={`Connection: ${snap.phase}`}>
					<span className={`sh-dot sh-dot-${snap.phase}`} />
					{status}
				</span>
				{snap.readOnly && <span className="sh-chip">read-only</span>}
				<span className="sh-split-actions">
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={() => onMakeMain(link)}
						aria-label="Open as main session"
						title="Open as main session"
					>
						<Maximize2 size={15} />
					</button>
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={onClose}
						aria-label="Close pane"
						title="Close pane"
					>
						<X size={16} />
					</button>
				</span>
			</header>
			{ended && (
				<div className="sh-split-ended" role="alert">
					<span>Session ended{snap.endedReason ? `: ${snap.endedReason}` : ""}</span>
					<button type="button" className="sh-btn" onClick={onRejoin}>
						Rejoin
					</button>
				</div>
			)}
			<div className="sh-transcript">
				<Transcript
					entries={snap.entries}
					stream={snap.stream}
					streamDone={snap.streamDone}
					activeTools={snap.activeTools}
					working={snap.working}
					phase={snap.phase}
					chat={chat}
					newSince={newSince ?? undefined}
					newSeen={newSeen}
					onNewSeen={markSeen}
					onTail={markTail}
					queued={snap.queued}
					onCancelQueued={cancelQueued}
					onEditPrompt={editPrompt.onEditPrompt}
					onTurnChanges={turnChanges.onTurnChanges}
					onSendToAgent={snap.readOnly ? undefined : sendToAgent}
					sessionModel={snap.state?.model?.id}
				/>
			</div>
			{editPrompt.sheet}
			{turnChanges.sheet}
			<Composer
				ref={composerRef}
				key={roomId}
				client={client}
				phase={snap.phase}
				readOnly={snap.readOnly}
				uiRequest={snap.uiRequest}
				working={snap.working}
				queuedMessageCount={snap.state?.queuedMessageCount ?? 0}
				followUp={Object.hasOwn(snap.features, "follow-up") && !snap.readOnly}
				approvalGrants={Object.hasOwn(snap.features, "approval-grants")}
				followUps={snap.followUps}
				followUpIds={composerExtras.followUpIds}
				queueEdit={composerExtras.queueEdit}
				mentions={composerExtras.mentions}
				upload={upload}
				voice={null}
				draftKey={roomId}
				models={snap.models}
				model={snap.state?.model}
				thinkingLevel={snap.state?.thinkingLevel}
				thinkingLevels={snap.state?.thinkingLevels}
				profiles={Object.hasOwn(snap.features, "profiles") ? snap.profiles : null}
				profile={snap.state?.profile}
				followsRoom={companionClient !== null && instanceId !== null}
				promptModel={Object.hasOwn(snap.features, "prompt-model") && !snap.readOnly && snap.models !== null}
				onSessionCommand={sendSessionCommand}
			/>
		</section>
	);
}

export interface DockPaneProps {
	/** Accessible name. */
	label: string;
	children: ReactNode;
}

/** A panel docked beside the transcript (the editor), framed like the session panels. Marks its focus as `editor`. */
export function DockPane({ label, children }: DockPaneProps): ReactNode {
	return (
		<aside className="sh-panel sh-split-pane sh-split-dock" data-pane="editor" aria-label={label}>
			{children}
		</aside>
	);
}
