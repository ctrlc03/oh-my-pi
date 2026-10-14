import { ChartColumn, ChevronDown, ChevronRight, LayoutList, Laptop, Plus, X } from "lucide-react";
import type { ReactNode } from "react";
import { useId, useState } from "react";
import { type ComputerHandle, stateWord } from "../../lib/computers";
import type { CompanionHost, CompanionIdleSession, PairingLink, SessionOverview } from "../../lib/companion";
import { withoutPersonal } from "../../lib/personal";
import { DEVICE_ORG } from "../../lib/org-storage";
import { extractLink, type RecentRoom } from "../../lib/rooms";
import { endedSettledKeys, matchRooms } from "../../lib/session-org";
import { useEndedSettled } from "../../lib/use-ended-settled";
import { roomOwner, type SessionOrgControl, type SessionOrgs } from "../../lib/use-session-org";
import type { BesideControl } from "../../lib/use-split";
import { AddComputer } from "./AddComputer";
import { PowerNote } from "./CompanionCard";
import { FanoutGroups } from "./FanoutSheet";
import { InboxEntry } from "./InboxSheet";
import { useOpenElsewhere } from "./OpenElsewhere";
import { OrgSessions } from "./OrgSessions";
import { SchedulesEntry } from "./SchedulesSheet";
import { StartSessionSheet } from "./StartSessionSheet";
import { PersonalSlot } from "./PersonalEntry";

export interface SessionsSidebarProps {
	/** Every paired computer, live or not. */
	computers: readonly ComputerHandle[];
	rooms: readonly RecentRoom[];
	/** Pin / snooze / settle state of every session, one document per computer. */
	orgs: SessionOrgs;
	/** Session on screen: its row is highlighted wherever it sits (pinned or not), and stays in place. */
	currentSessionId: string | null;
	currentRoomId: string | null;
	/** Fetch a link for a companion host of a computer and join it; rejects with a readable message. */
	onOpenHost(computerId: string, instanceId: string): Promise<void>;
	onOpenLink(link: string): void;
	/** Usage and all-sessions screens; null when no computer is paired. */
	onOpenUsage: (() => void) | null;
	onOpenSessions: (() => void) | null;
	/** Split view: sessions can open in a second pane beside the transcript. null where the screen has no room. */
	beside?: Pick<BesideControl, "openHost" | "openLink"> | null;
	/** When the open session's usage limit resets (ms): offered as a snooze time for it. */
	limitResetAt?: number | null;
	onClose(): void;
	/** Pair another computer: offered under the groups once there are several. */
	onPair?: (link: PairingLink) => void;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Rooms of the device's own group stand for no listed session. */
const NO_TWINS: ReadonlyMap<string, readonly RecentRoom[]> = new Map();

interface GroupHeadProps {
	label: ReactNode;
	/** Chevron button that folds the group; null: a plain heading. */
	toggle: { open: boolean; controls: string; onToggle(): void } | null;
}

/** The heading of one group of sessions: a button when the group can be folded. */
function GroupHead({ label, toggle }: GroupHeadProps): ReactNode {
	if (toggle === null) return <h2 className="sh-recents-title">{label}</h2>;
	return (
		<h2 className="sh-recents-title sh-group-title">
			<button
				type="button"
				className="sh-group-toggle"
				aria-expanded={toggle.open}
				aria-controls={toggle.controls}
				onClick={toggle.onToggle}
			>
				{toggle.open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
				{label}
			</button>
		</h2>
	);
}

interface ComputerGroupProps {
	computer: ComputerHandle;
	/** Several computers: this one gets a heading naming it, which folds its sessions. */
	grouped: boolean;
	open: boolean;
	onToggle(): void;
	/** Recent rooms of this computer, the one on screen too. */
	rooms: readonly RecentRoom[];
	org: SessionOrgControl;
	currentSessionId: string | null;
	currentRoomId: string | null;
	limitResetAt: number | null;
	beside: Pick<BesideControl, "openHost" | "openLink"> | null;
	onOpenHost(computerId: string, instanceId: string): Promise<void>;
	onOpenLink(link: string): void;
}

/** One computer's sessions: its hosts, idle sessions, ended settled ones and recent rooms, with its own joining and error state. */
function ComputerGroup({
	computer,
	grouped,
	open,
	onToggle,
	rooms,
	org,
	currentSessionId,
	currentRoomId,
	limitResetAt,
	beside,
	onOpenHost,
	onOpenLink,
}: ComputerGroupProps): ReactNode {
	const [joining, setJoining] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const bodyId = useId();
	const { client, snap } = computer;
	const live = snap.phase === "live";
	const liveIds = new Set([...snap.hosts, ...snap.idle].map(session => session.sessionId));
	// A room of a process the computer lists is that session's row, not a second one (the Personal session's included).
	const { alone, twins } = matchRooms(rooms, [...snap.hosts, ...snap.idle]);
	// Sessions that ended while settled (the computer ends them when they settle, if asked) stay under Settled.
	const ended = useEndedSettled(client, live, endedSettledKeys(org.doc, liveIds));
	const openElsewhere = useOpenElsewhere();

	/** Resume an ended session with the all-sessions list's own request, then open it when `open`; false (with the reason shown) when it did not come back. */
	const resumeEnded = async (session: SessionOverview, openIt: boolean, force = false): Promise<boolean> => {
		if (!client) return false;
		setJoining(session.sessionId);
		setError(null);
		openElsewhere.dismiss();
		try {
			const instanceId = await client.startSession(session.folder, {
				resume: session.sessionId,
				agent: session.agent?.id,
				force: force || undefined,
			});
			if (openIt) await onOpenHost(computer.id, instanceId);
			return true;
		} catch (err) {
			if (!openElsewhere.intercept(err, () => void resumeEnded(session, openIt, true))) setError(errorText(err));
			return false;
		} finally {
			setJoining(null);
		}
	};

	const join = (host: CompanionHost): void => {
		setJoining(host.instanceId);
		setError(null);
		onOpenHost(computer.id, host.instanceId).catch((err: unknown) => {
			setError(errorText(err));
			setJoining(null);
		});
	};

	/** Open a companion host in the second pane; the sidebar stays as it is. */
	const joinBeside = (host: CompanionHost): void => {
		if (beside === null) return;
		setJoining(host.instanceId);
		setError(null);
		beside
			.openHost(computer.id, host.instanceId)
			.catch((err: unknown) => setError(errorText(err)))
			.finally(() => setJoining(null));
	};

	const openRoomBeside = (link: string): void => {
		if (beside === null) return;
		setError(beside.openLink(link));
	};

	/** Make an idle session host collab, then open its control link. */
	const share = async (session: CompanionIdleSession): Promise<void> => {
		if (!client || joining) return;
		setJoining(session.instanceId);
		setError(null);
		try {
			const link = extractLink(await client.shareSession(session.instanceId));
			if (!link) throw new Error("the computer returned an unreadable link");
			onOpenLink(link);
		} catch (err) {
			setError(errorText(err));
			setJoining(null);
		}
	};

	const name = grouped ? computer.name : (snap.machine ?? "Your computer");
	const state = grouped && !live ? stateWord(snap.phase) : null;
	const label = (
		<>
			<Laptop size={14} />
			{name}
			<span className={`sh-dot${live ? " sh-dot-live" : ""}`} role="img" aria-label={live ? "Online" : "Offline"} />
			{state !== null && <span className="sh-group-state">{state}</span>}
		</>
	);
	// The Personal agent's live session is pinned above the sessions (PersonalSlot), not listed among them.
	const listed = withoutPersonal(snap.hosts);
	const status = (
		<>
			{live && <PowerNote power={snap.power} />}
			{listed.length === 0 && snap.idle.length === 0 && (
				<div className="sh-companion-empty">
					{snap.phase === "unpaired"
						? snap.error
						: snap.phase === "offline"
							? (snap.error ?? "Your computer is unreachable.")
							: snap.phase === "connecting"
								? "Connecting…"
								: "No session is sharing."}
				</div>
			)}
		</>
	);
	const shown = error ?? computer.error;
	const sessions = (
		<>
			<PersonalSlot
				computer={computer}
				grouped={grouped}
				currentSessionId={currentSessionId}
				onOpenHost={onOpenHost}
			/>
			{client && live && <FanoutGroups hosts={listed} client={client} onOpen={id => onOpenHost(computer.id, id)} />}
			<OrgSessions
				hosts={listed}
				idle={snap.idle}
				rooms={alone}
				twins={twins}
				org={org}
				joining={joining}
				disabled={!live}
				currentSessionId={currentSessionId}
				currentRoomId={currentRoomId}
				limitResetAt={limitResetAt}
				onJoinHost={join}
				onOpenHostBeside={beside === null ? undefined : joinBeside}
				onShare={share}
				onOpenRoom={room => onOpenLink(room.link)}
				onOpenRoomBeside={beside === null ? undefined : room => openRoomBeside(room.link)}
				ended={ended}
				canResume={snap.canStart && live}
				onResumeEnded={resumeEnded}
			/>
			{openElsewhere.notice}
			{shown && <div className="sh-connect-error">{shown}</div>}
		</>
	);

	if (!grouped) {
		return (
			<>
				<section className="sh-switch-section" aria-label="Sessions on your computer">
					<GroupHead label={label} toggle={null} />
					{status}
				</section>
				{sessions}
			</>
		);
	}
	return (
		<section className="sh-switch-section sh-computer-group" aria-label={`Sessions on ${computer.name}`}>
			<GroupHead label={label} toggle={{ open, controls: bodyId, onToggle }} />
			<div id={bodyId} className="sh-computer-group-body" hidden={!open}>
				{open && (
					<>
						{status}
						{sessions}
					</>
				)}
			</div>
		</section>
	);
}

interface DeviceGroupProps {
	/** Name the group (and fold it when `collapsible`): there are computers whose groups it follows. */
	grouped: boolean;
	collapsible: boolean;
	open: boolean;
	onToggle(): void;
	rooms: readonly RecentRoom[];
	org: SessionOrgControl;
	currentSessionId: string | null;
	currentRoomId: string | null;
	limitResetAt: number | null;
	beside: Pick<BesideControl, "openHost" | "openLink"> | null;
	onOpenLink(link: string): void;
}

/** Recent rooms no paired computer lists: kept on this device only. */
function DeviceGroup({
	grouped,
	collapsible,
	open,
	onToggle,
	rooms,
	org,
	currentSessionId,
	currentRoomId,
	limitResetAt,
	beside,
	onOpenLink,
}: DeviceGroupProps): ReactNode {
	const [error, setError] = useState<string | null>(null);
	const bodyId = useId();
	const list = (
		<>
			<OrgSessions
				hosts={[]}
				idle={[]}
				rooms={rooms}
				twins={NO_TWINS}
				org={org}
				joining={null}
				disabled={false}
				currentSessionId={currentSessionId}
				currentRoomId={currentRoomId}
				limitResetAt={limitResetAt}
				onJoinHost={() => {}}
				onShare={() => {}}
				onOpenRoom={room => onOpenLink(room.link)}
				onOpenRoomBeside={beside === null ? undefined : room => setError(beside.openLink(room.link))}
				ended={[]}
				canResume={false}
				onResumeEnded={() => Promise.resolve(false)}
			/>
			{error && <div className="sh-connect-error">{error}</div>}
		</>
	);
	if (!grouped) return list;
	return (
		<section className="sh-switch-section sh-computer-group" aria-label="Other sessions">
			<GroupHead label="Other sessions" toggle={collapsible ? { open, controls: bodyId, onToggle } : null} />
			<div id={bodyId} className="sh-computer-group-body" hidden={!open}>
				{open && list}
			</div>
		</section>
	);
}

/**
 * Every session one tap away: docked beside the transcript on wide screens, a
 * slide-over drawer (with a close button and backdrop) below the dock breakpoint.
 * One group per paired computer (headed by its name once there are several), then the rooms no computer lists.
 */
export function SessionsSidebar({
	computers,
	rooms,
	orgs,
	currentSessionId,
	currentRoomId,
	onOpenHost,
	onOpenLink,
	onOpenUsage,
	onOpenSessions,
	onClose,
	onPair,
	beside = null,
	limitResetAt = null,
}: SessionsSidebarProps): ReactNode {
	const [starting, setStarting] = useState(false);
	const [adding, setAdding] = useState(false);
	/** Groups folded shut: a computer's id, or {@link DEVICE_ORG}. */
	const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
	const several = computers.length > 1;
	const deviceRooms = rooms.filter(room => roomOwner(room, computers) === DEVICE_ORG);
	const anyLive = computers.some(computer => computer.snap.phase === "live");
	const canStart = computers.some(computer => computer.snap.phase === "live" && computer.snap.canStart);
	const currentComputer =
		currentSessionId === null
			? null
			: (computers.find(computer =>
					[...computer.snap.hosts, ...computer.snap.idle].some(session => session.sessionId === currentSessionId),
				) ?? null);

	const toggle = (id: string): void =>
		setFolded(prev => {
			const next = new Set(prev);
			if (!next.delete(id)) next.add(id);
			return next;
		});

	return (
		<nav className="sh-sidebar" aria-label="Sessions">
			<div className="sh-sidebar-head">
				<span className="sh-sidebar-title">Sessions</span>
				<button
					type="button"
					className="sh-btn sh-btn-icon sh-sidebar-close"
					onClick={onClose}
					aria-label="Close sessions"
					title="Close sessions"
				>
					<X size={16} />
				</button>
			</div>
			<div className="sh-sidebar-body">
				{computers.map(computer => (
					<ComputerGroup
						key={computer.id}
						computer={computer}
						grouped={several}
						open={!folded.has(computer.id)}
						onToggle={() => toggle(computer.id)}
						rooms={rooms.filter(room => roomOwner(room, computers) === computer.id)}
						org={orgs.of(computer.id)}
						currentSessionId={currentSessionId}
						currentRoomId={currentRoomId}
						limitResetAt={limitResetAt}
						beside={beside}
						onOpenHost={onOpenHost}
						onOpenLink={onOpenLink}
					/>
				))}
				{deviceRooms.length > 0 && (
					<DeviceGroup
						grouped={computers.length > 0}
						collapsible={several}
						open={!folded.has(DEVICE_ORG)}
						onToggle={() => toggle(DEVICE_ORG)}
						rooms={deviceRooms}
						org={orgs.of(DEVICE_ORG)}
						currentSessionId={currentSessionId}
						currentRoomId={currentRoomId}
						limitResetAt={limitResetAt}
						beside={beside}
						onOpenLink={onOpenLink}
					/>
				)}
				{computers.length === 0 && rooms.length === 0 && (
					<div className="sh-companion-empty">
						No other sessions yet. Pair your computer from the start screen to list all of them here.
					</div>
				)}
				{several && onPair && (
					<div className="sh-sidebar-add">
						<button
							type="button"
							className="sh-btn"
							aria-expanded={adding}
							onClick={() => setAdding(open => !open)}
						>
							<Plus size={15} /> Add a computer
						</button>
						{adding && <AddComputer onPair={onPair} onPaired={() => setAdding(false)} />}
					</div>
				)}
			</div>
			{anyLive && (
				<div className="sh-sidebar-foot">
					{canStart && (
						<button type="button" className="sh-btn" onClick={() => setStarting(true)}>
							<Plus size={15} /> Start session
						</button>
					)}
					{onOpenUsage && (
						<button
							type="button"
							className="sh-btn sh-btn-icon"
							onClick={onOpenUsage}
							aria-label="Usage"
							title="Usage"
						>
							<ChartColumn size={15} />
						</button>
					)}
					{onOpenSessions && (
						<button
							type="button"
							className="sh-btn sh-btn-icon"
							onClick={onOpenSessions}
							aria-label="All sessions"
							title="All sessions"
						>
							<LayoutList size={15} />
						</button>
					)}
					<InboxEntry computers={computers} onOpenHost={onOpenHost} variant="icon" />
					<SchedulesEntry computers={computers} onOpenHost={onOpenHost} variant="icon" />
				</div>
			)}
			{starting && (
				<StartSessionSheet
					computers={computers}
					currentComputerId={currentComputer?.id ?? null}
					onOpen={onOpenHost}
					onClose={() => setStarting(false)}
				/>
			)}
		</nav>
	);
}
