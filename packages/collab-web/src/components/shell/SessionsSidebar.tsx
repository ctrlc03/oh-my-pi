import {
	ChartColumn,
	ChevronDown,
	ChevronRight,
	Ellipsis,
	GripVertical,
	LayoutList,
	Laptop,
	Plus,
	Search,
	X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useId, useState } from "react";
import { dropIndex } from "../../lib/computer-order";
import { type ComputerHandle, stateWord } from "../../lib/computers";
import type { CompanionHost, CompanionIdleSession, PairingLink, SessionOverview } from "../../lib/companion";
import { withoutPersonal } from "../../lib/personal";
import { DEVICE_ORG } from "../../lib/org-storage";
import { extractLink, type RecentRoom } from "../../lib/rooms";
import { deleteOffered } from "../../lib/session-delete";
import { endedSettledKeys, matchRooms, organisedByUser, roomOrgKey } from "../../lib/session-org";
import { useEndedSettled } from "../../lib/use-ended-settled";
import { roomOwner, type SessionOrgControl, type SessionOrgs } from "../../lib/use-session-org";
import type { BesideControl } from "../../lib/use-split";
import { AddComputer } from "./AddComputer";
import { ComputerMenu } from "./ComputerMenu";
import { useDeleteSessions } from "./DeleteSessions";
import { hostTitle, PowerNote } from "./CompanionCard";
import { FanoutGroups } from "./FanoutSheet";
import { InboxEntry } from "./InboxSheet";
import { useOpenElsewhere } from "./OpenElsewhere";
import { OrgSessions } from "./OrgSessions";
import { SchedulesEntry } from "./SchedulesSheet";
import { FreshVmBadge } from "./FreshVmBadge";
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
	/** Put a computer's group at an index of the arranged order (dragging its heading, or its menu); without it the groups are not arranged. */
	onMoveComputer?: (id: string, to: number) => void;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Rooms of the device's own group stand for no listed session. */
const NO_TWINS: ReadonlyMap<string, readonly RecentRoom[]> = new Map();

/** Whether every word of the search query appears somewhere in a session's title or folder (an empty query matches all). */
function matchesQuery(query: string, ...texts: readonly (string | null | undefined)[]): boolean {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return true;
	const haystack = texts.join(" ").toLowerCase();
	return words.every(word => haystack.includes(word));
}

/** What arranging one computer's group takes: where it stands, the menu, and the heading's part in a drag. */
interface GroupReorder {
	name: string;
	index: number;
	count: number;
	/** This group is the one being dragged. */
	dragging: boolean;
	/** Where the dragged group would land relative to this one. */
	drop: "before" | "after" | null;
	onMove(to: number): void;
	onDragStart(): void;
	/** Another group is dragged over this one, over its lower half when `after`; false when nothing is dragged. */
	onDragOver(after: boolean): boolean;
	onDrop(): void;
	onDragEnd(): void;
}

interface GroupHeadProps {
	label: ReactNode;
	/** Chevron button that folds the group; null: a plain heading. */
	toggle: { open: boolean; controls: string; onToggle(): void } | null;
	/** Opens the arrange menu; the heading is what a mouse drags. Null: the group is not arranged. */
	reorder: GroupReorder | null;
	onMenu(): void;
}

/** The heading of one group of sessions: a button when the group can be folded. */
function GroupHead({ label, toggle, reorder, onMenu }: GroupHeadProps): ReactNode {
	if (toggle === null) return <h2 className="sh-recents-title">{label}</h2>;
	return (
		<h2
			className="sh-recents-title sh-group-title"
			draggable={reorder !== null}
			onDragStart={
				reorder === null
					? undefined
					: e => {
							// Firefox starts no drag without data.
							e.dataTransfer.setData("text/plain", reorder.name);
							e.dataTransfer.effectAllowed = "move";
							reorder.onDragStart();
						}
			}
			onDragEnd={reorder?.onDragEnd}
		>
			{reorder !== null && <GripVertical size={13} className="sh-group-grip" aria-hidden />}
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
			{reorder !== null && (
				<button
					type="button"
					className="sh-btn sh-btn-icon sh-group-more"
					onClick={onMenu}
					aria-label={`Arrange ${reorder.name}`}
					aria-haspopup="dialog"
				>
					<Ellipsis size={15} />
				</button>
			)}
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
	/** What the search field holds: only sessions matching it are listed. */
	query: string;
	org: SessionOrgControl;
	currentSessionId: string | null;
	currentRoomId: string | null;
	limitResetAt: number | null;
	beside: Pick<BesideControl, "openHost" | "openLink"> | null;
	/** Arranging the groups; null with one computer, or where the groups are not arranged. */
	reorder: GroupReorder | null;
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
	query,
	org,
	currentSessionId,
	currentRoomId,
	limitResetAt,
	beside,
	reorder,
	onOpenHost,
	onOpenLink,
}: ComputerGroupProps): ReactNode {
	const [menu, setMenu] = useState(false);
	const [joining, setJoining] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const bodyId = useId();
	const { client, snap } = computer;
	const live = snap.phase === "live";
	const liveIds = new Set([...snap.hosts, ...snap.idle, ...snap.hibernated].map(session => session.sessionId));
	// A room of a process the computer lists is that session's row, not a second one (the Personal session's included).
	// Once the computer is live its listing is complete, so a room of a process it no longer has shows no row either,
	// unless it is the one on screen or the user pinned, snoozed or settled it: that room is there because they chose it.
	const matched = matchRooms(rooms, [...snap.hosts, ...snap.idle, ...snap.hibernated], { complete: live });
	const { twins } = matched;
	const alone = [
		...matched.alone,
		...matched.stale.filter(
			room => room.roomId === currentRoomId || organisedByUser(org.doc, roomOrgKey(room.roomId)),
		),
	];
	// Sessions that ended while settled (the computer ends them when they settle, if asked) stay under Settled.
	const ended = useEndedSettled(client, live, endedSettledKeys(org.doc, liveIds), snap.sessionCardsRev);
	const openElsewhere = useOpenElsewhere();
	const deleter = useDeleteSessions();

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

	const join = (host: Pick<CompanionHost, "instanceId">): void => {
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

	/** Hibernate a running session now; the computer's refusal (it is working, someone has it open…) shows as the error. */
	const hibernate = (host: CompanionHost): void => {
		if (!client) return;
		setError(null);
		client.hibernateNow(host.instanceId).catch((err: unknown) => setError(errorText(err)));
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
			{computer.fresh !== undefined && <FreshVmBadge />}
			{state !== null && <span className="sh-group-state">{state}</span>}
		</>
	);
	// The Personal agent's live session is pinned above the sessions (PersonalSlot), not listed among them.
	const unfiltered = withoutPersonal(snap.hosts);
	const searching = query.trim() !== "";
	const listed = unfiltered.filter(host => matchesQuery(query, hostTitle(host), host.cwd));
	const idle = snap.idle.filter(session => matchesQuery(query, hostTitle(session), session.cwd));
	const hibernated = snap.hibernated.filter(session => matchesQuery(query, hostTitle(session), session.cwd));
	const shownRooms = alone.filter(room => matchesQuery(query, room.title, room.cwd));
	const shownEnded = ended.filter(session => matchesQuery(query, session.title, session.folder));
	const nothingMatches =
		listed.length === 0 &&
		idle.length === 0 &&
		hibernated.length === 0 &&
		shownRooms.length === 0 &&
		shownEnded.length === 0;
	const status = (
		<>
			{live && <PowerNote power={snap.power} />}
			{!searching && unfiltered.length === 0 && snap.idle.length === 0 && snap.hibernated.length === 0 && (
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
			{searching && nothingMatches && <div className="sh-companion-empty">No sessions match.</div>}
		</>
	);
	const shown = error ?? computer.error;
	const sessions = (
		<>
			{!searching && (
				<PersonalSlot
					computer={computer}
					grouped={grouped}
					currentSessionId={currentSessionId}
					onOpenHost={onOpenHost}
				/>
			)}
			{client && live && !searching && (
				<FanoutGroups hosts={listed} client={client} onOpen={id => onOpenHost(computer.id, id)} />
			)}
			<OrgSessions
				computerId={computer.id}
				hosts={listed}
				idle={idle}
				rooms={shownRooms}
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
				ended={shownEnded}
				canResume={snap.canStart && live}
				onResumeEnded={resumeEnded}
				hibernated={hibernated}
				onOpenHibernated={join}
				onHibernate={client !== null && live && snap.canHibernate ? hibernate : null}
				onDelete={
					deleter !== null && deleteOffered(snap)
						? sessions => deleter.request({ computerId: computer.id, sessions, openSessionId: currentSessionId })
						: null
				}
				onSetCard={client !== null && snap.canSessionCards ? (id, card) => client.setSessionCard(id, card) : null}
			/>
			{openElsewhere.notice}
			{shown && <div className="sh-connect-error">{shown}</div>}
		</>
	);

	if (!grouped) {
		return (
			<>
				<section className="sh-switch-section" aria-label="Sessions on your computer">
					<GroupHead label={label} toggle={null} reorder={null} onMenu={() => {}} />
					{status}
				</section>
				{sessions}
			</>
		);
	}
	return (
		<section
			className={`sh-switch-section sh-computer-group${reorder?.dragging ? " sh-group-dragging" : ""}${reorder?.drop ? ` sh-group-drop-${reorder.drop}` : ""}`}
			aria-label={`Sessions on ${computer.name}`}
			onDragOver={
				reorder === null
					? undefined
					: e => {
							const rect = e.currentTarget.getBoundingClientRect();
							if (reorder.onDragOver(e.clientY > rect.top + rect.height / 2)) e.preventDefault();
						}
			}
			onDrop={
				reorder === null
					? undefined
					: e => {
							e.preventDefault();
							reorder.onDrop();
						}
			}
		>
			<GroupHead
				label={label}
				toggle={{ open, controls: bodyId, onToggle }}
				reorder={reorder}
				onMenu={() => setMenu(true)}
			/>
			<div id={bodyId} className="sh-computer-group-body" hidden={!open}>
				{open && (
					<>
						{status}
						{sessions}
					</>
				)}
			</div>
			{menu && reorder !== null && (
				<ComputerMenu
					name={reorder.name}
					place={{ index: reorder.index, count: reorder.count }}
					onMove={reorder.onMove}
					onClose={() => setMenu(false)}
				/>
			)}
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
	query: string;
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
	query,
	org,
	currentSessionId,
	currentRoomId,
	limitResetAt,
	beside,
	onOpenLink,
}: DeviceGroupProps): ReactNode {
	const [error, setError] = useState<string | null>(null);
	const bodyId = useId();
	const shown = rooms.filter(room => matchesQuery(query, room.title, room.cwd));
	const list = (
		<>
			{query.trim() !== "" && shown.length === 0 && <div className="sh-companion-empty">No sessions match.</div>}
			<OrgSessions
				computerId={null}
				hosts={[]}
				idle={[]}
				rooms={shown}
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
				hibernated={[]}
				onOpenHibernated={() => {}}
				onHibernate={null}
				onResumeEnded={() => Promise.resolve(false)}
				onDelete={null}
				onSetCard={null}
			/>
			{error && <div className="sh-connect-error">{error}</div>}
		</>
	);
	if (!grouped) return list;
	return (
		<section className="sh-switch-section sh-computer-group" aria-label="Other sessions">
			<GroupHead
				label="Other sessions"
				toggle={collapsible ? { open, controls: bodyId, onToggle } : null}
				reorder={null}
				onMenu={() => {}}
			/>
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
	onMoveComputer,
	beside = null,
	limitResetAt = null,
}: SessionsSidebarProps): ReactNode {
	const [starting, setStarting] = useState(false);
	const [adding, setAdding] = useState(false);
	const [query, setQuery] = useState("");
	/** Groups folded shut: a computer's id, or {@link DEVICE_ORG}. */
	const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
	/** The group being dragged and where it would land: the one under the pointer, and which side of it. */
	const [drag, setDrag] = useState<{ id: string; over: { id: string; after: boolean } | null } | null>(null);
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

	const reorderOf = (computer: ComputerHandle, index: number): GroupReorder | null => {
		if (!several || onMoveComputer === undefined) return null;
		const over = drag?.over?.id === computer.id ? drag.over : null;
		return {
			name: computer.name,
			index,
			count: computers.length,
			dragging: drag?.id === computer.id,
			drop: over === null ? null : over.after ? "after" : "before",
			onMove: to => onMoveComputer(computer.id, to),
			onDragStart: () => setDrag({ id: computer.id, over: null }),
			onDragOver: after => {
				if (drag === null || drag.id === computer.id) return false;
				if (drag.over?.id !== computer.id || drag.over.after !== after)
					setDrag({ ...drag, over: { id: computer.id, after } });
				return true;
			},
			onDrop: () => {
				if (drag?.over?.id === computer.id) {
					const from = computers.findIndex(other => other.id === drag.id);
					onMoveComputer(drag.id, dropIndex(from, index, drag.over.after));
				}
				setDrag(null);
			},
			onDragEnd: () => setDrag(null),
		};
	};

	return (
		<nav className="sh-sidebar" aria-label="Sessions">
			<div className="sh-sidebar-top">
				<div className="sh-sidebar-actions">
					{canStart && (
						<button type="button" className="sh-btn sh-sidebar-new" onClick={() => setStarting(true)}>
							<Plus size={16} /> Start session
						</button>
					)}
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
				<label className="sh-sidebar-search">
					<Search size={15} aria-hidden />
					<input
						type="text"
						role="searchbox"
						value={query}
						onChange={e => setQuery(e.target.value)}
						onKeyDown={e => {
							if (e.key === "Escape" && query !== "") {
								e.stopPropagation();
								setQuery("");
							}
						}}
						placeholder="Search sessions"
						aria-label="Search sessions"
						spellCheck={false}
						autoComplete="off"
						autoCapitalize="off"
						autoCorrect="off"
					/>
					{query !== "" && (
						<button
							type="button"
							className="sh-sidebar-search-clear"
							onClick={() => setQuery("")}
							aria-label="Clear search"
						>
							<X size={14} />
						</button>
					)}
				</label>
			</div>
			<div className="sh-sidebar-body">
				{computers.map((computer, index) => (
					<ComputerGroup
						key={computer.id}
						computer={computer}
						grouped={several}
						open={!folded.has(computer.id)}
						onToggle={() => toggle(computer.id)}
						rooms={rooms.filter(room => roomOwner(room, computers) === computer.id)}
						query={query}
						org={orgs.of(computer.id)}
						currentSessionId={currentSessionId}
						currentRoomId={currentRoomId}
						limitResetAt={limitResetAt}
						beside={beside}
						reorder={reorderOf(computer, index)}
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
						query={query}
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
						{adding && <AddComputer computers={computers} onPair={onPair} onPaired={() => setAdding(false)} />}
					</div>
				)}
			</div>
			{anyLive && (
				<div className="sh-sidebar-foot">
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
