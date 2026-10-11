import {
	Archive,
	ArchiveRestore,
	ArrowDown,
	ArrowUp,
	ChevronDown,
	ChevronRight,
	Ellipsis,
	LoaderCircle,
	Moon,
	PanelRight,
	Pin,
	PinOff,
	Share2,
	SlidersHorizontal,
	Undo2,
	Users,
	X,
} from "lucide-react";
import type { DragEvent, PointerEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { CompanionHost, CompanionIdleSession } from "../../lib/companion";
import { relTime, shortenPath } from "../../lib/format";
import type { RecentRoom } from "../../lib/rooms";
import {
	moveTarget,
	type OrgEntry,
	type OrgSections,
	pinnedKeys,
	roomOrgKey,
	sectionize,
	snoozeChoices,
	statusOf,
	wakeLabel,
} from "../../lib/session-org";
import type { SessionOrgControl } from "../../lib/use-session-org";
import { HostState, hostTitle, SandboxedChip } from "./CompanionCard";
import { FanoutChip } from "./FanoutSheet";
import { Sheet } from "./Sheet";
import "./session-org.css";

/** Holding a row this long on a touch screen opens its menu. */
const LONG_PRESS_MS = 450;
/** A finger that travels further than this is scrolling, not holding. */
const LONG_PRESS_SLOP_PX = 10;
const UNDO_MS = 7000;
const IDLE_DAY_CHOICES = [3, 7, 14, 30];
/** Rows are dragged to reorder only with a mouse: on touch a long press opens the menu (and would start a native drag). */
const FINE_POINTER = typeof matchMedia === "function" && matchMedia("(hover: hover) and (pointer: fine)").matches;

type OrgItem =
	| { kind: "host"; key: string; host: CompanionHost }
	| { kind: "idle"; key: string; session: CompanionIdleSession }
	| { kind: "room"; key: string; room: RecentRoom };

function itemTitle(item: OrgItem): string {
	if (item.kind === "host") return hostTitle(item.host);
	if (item.kind === "idle") return hostTitle(item.session);
	return item.room.title;
}

const isWorking = (item: OrgItem): boolean =>
	item.kind === "host" ? item.host.busy === true : item.kind === "idle" && item.session.busy === true;

export interface OrgSessionsProps {
	hosts: readonly CompanionHost[];
	idle: readonly CompanionIdleSession[];
	/** Recent rooms other than the one on screen. */
	rooms: readonly RecentRoom[];
	org: SessionOrgControl;
	/** instanceId (or room) whose link is being fetched: disables every open. */
	joining: string | null;
	/** The computer is unreachable: its sessions cannot be opened. */
	disabled: boolean;
	currentSessionId: string | null;
	/** When the open session's usage limit resets; offered as a snooze time for it. */
	limitResetAt: number | null;
	onJoinHost(host: CompanionHost): void;
	onOpenHostBeside?: (host: CompanionHost) => void;
	onShare(session: CompanionIdleSession): void;
	onOpenRoom(room: RecentRoom): void;
	onOpenRoomBeside?: (room: RecentRoom) => void;
}

interface Undo {
	message: string;
	key: string;
	prev: OrgEntry | null;
}

/** Sessions sorted into Pinned, Working, Active, Snoozed and Settled, each row with a menu (⋯, right-click, long press). */
export function OrgSessions(props: OrgSessionsProps): ReactNode {
	const { hosts, idle, rooms, org, currentSessionId } = props;
	const { doc, now } = org;
	const [settledOpen, setSettledOpen] = useState(false);
	const [menu, setMenu] = useState<string | null>(null);
	const [undo, setUndo] = useState<Undo | null>(null);
	const [organising, setOrganising] = useState(false);
	const [dragging, setDragging] = useState<string | null>(null);
	const [over, setOver] = useState<string | null>(null);

	const items: OrgItem[] = [
		...hosts.map((host): OrgItem => ({ kind: "host", key: host.sessionId, host })),
		...idle.map((session): OrgItem => ({ kind: "idle", key: session.sessionId, session })),
		...rooms.map((room): OrgItem => ({ kind: "room", key: roomOrgKey(room.roomId), room })),
	];
	const sections = sectionize(items, item => item.key, isWorking, doc, now);
	const pinned = pinnedKeys(doc).filter(key => sections.pinned.some(item => item.key === key));
	const menuItem = menu === null ? undefined : items.find(item => item.key === menu);

	useEffect(() => {
		if (undo === null) return;
		const timer = setTimeout(() => setUndo(null), UNDO_MS);
		return () => clearTimeout(timer);
	}, [undo]);

	const apply = (item: OrgItem, action: Parameters<SessionOrgControl["act"]>[1], message: string): void => {
		const prev = Object.hasOwn(doc.entries, item.key) ? doc.entries[item.key] : null;
		org.act(item.key, action);
		setUndo(message === "" ? null : { message, key: item.key, prev });
		setMenu(null);
	};

	const drop = (target: string): void => {
		const from = dragging === null ? -1 : pinned.indexOf(dragging);
		setDragging(null);
		setOver(null);
		const to = pinned.indexOf(target);
		if (from === -1 || to === -1 || from === to) return;
		org.act(pinned[from], moveTarget(pinned, from, to));
	};

	const row = (item: OrgItem, section: keyof OrgSections<OrgItem>): ReactNode => (
		<OrgRow
			key={item.key}
			item={item}
			status={section}
			wake={section === "snoozed" ? wakeLabel(doc.entries[item.key].until ?? now, now) : null}
			settledBy={section === "settled" ? doc.entries[item.key].reason : undefined}
			current={item.kind === "host" && item.host.sessionId === currentSessionId}
			joining={props.joining}
			disabled={props.disabled}
			draggable={section === "pinned" && FINE_POINTER}
			dropping={over === item.key && dragging !== item.key}
			onDragStart={() => setDragging(item.key)}
			onDragOver={() => setOver(item.key)}
			onDragEnd={() => {
				setDragging(null);
				setOver(null);
			}}
			onDrop={() => drop(item.key)}
			onMenu={() => setMenu(item.key)}
			onJoinHost={props.onJoinHost}
			onOpenHostBeside={props.onOpenHostBeside}
			onShare={props.onShare}
			onOpenRoom={props.onOpenRoom}
			onOpenRoomBeside={props.onOpenRoomBeside}
		/>
	);

	const block = (title: string, section: Exclude<keyof OrgSections<OrgItem>, "settled">): ReactNode =>
		sections[section].length === 0 ? null : (
			<section className="sh-org-section" aria-label={title.toLowerCase()}>
				<h3 className="sh-recents-title sh-org-title">{title}</h3>
				<ul className="sh-recents-list">{sections[section].map(item => row(item, section))}</ul>
			</section>
		);

	return (
		<>
			{block("Pinned", "pinned")}
			{block("Working", "working")}
			{block("Active", "active")}
			{block("Snoozed", "snoozed")}
			{items.length > 0 && (
				<section className="sh-org-section" aria-label="settled">
					<h3 className="sh-recents-title sh-org-title">
						<button
							type="button"
							className="sh-org-fold"
							onClick={() => setSettledOpen(open => !open)}
							aria-expanded={settledOpen}
							disabled={sections.settled.length === 0}
						>
							{settledOpen && sections.settled.length > 0 ? (
								<ChevronDown size={13} />
							) : (
								<ChevronRight size={13} />
							)}
							Settled
							{sections.settled.length > 0 && <span className="sh-org-count">{sections.settled.length}</span>}
						</button>
						<button
							type="button"
							className="sh-btn sh-btn-icon sh-org-settings"
							onClick={() => setOrganising(true)}
							aria-label="auto-settle settings"
							title="auto-settle"
						>
							<SlidersHorizontal size={14} />
						</button>
					</h3>
					{settledOpen && sections.settled.length > 0 && (
						<ul className="sh-recents-list">{sections.settled.map(item => row(item, "settled"))}</ul>
					)}
				</section>
			)}
			{undo && (
				<div className="sh-org-undo" role="status">
					<span className="sh-org-undo-msg">{undo.message}</span>
					<button
						type="button"
						className="sh-btn"
						onClick={() => {
							org.act(undo.key, { type: "restore", entry: undo.prev });
							setUndo(null);
						}}
					>
						<Undo2 size={14} /> Undo
					</button>
				</div>
			)}
			{menuItem && (
				<OrgMenu
					title={itemTitle(menuItem)}
					status={statusOf(doc, menuItem.key, now)}
					pinIndex={pinned.indexOf(menuItem.key)}
					pinCount={pinned.length}
					limitResetAt={
						menuItem.kind === "host" && menuItem.host.sessionId === currentSessionId ? props.limitResetAt : null
					}
					now={now}
					onAct={(action, message) => apply(menuItem, action, message)}
					onMove={to => {
						org.act(menuItem.key, moveTarget(pinned, pinned.indexOf(menuItem.key), to));
						setMenu(null);
					}}
					onClose={() => setMenu(null)}
				/>
			)}
			{organising && <OrgSettingsSheet org={org} onClose={() => setOrganising(false)} />}
		</>
	);
}

interface OrgRowProps {
	item: OrgItem;
	status: keyof OrgSections<OrgItem>;
	/** Snoozed: when it wakes. */
	wake: string | null;
	/** Settled: who settled it. */
	settledBy: "user" | "idle" | "pr" | undefined;
	current: boolean;
	joining: string | null;
	disabled: boolean;
	draggable: boolean;
	dropping: boolean;
	onDragStart(): void;
	onDragOver(): void;
	onDragEnd(): void;
	onDrop(): void;
	onMenu(): void;
	onJoinHost(host: CompanionHost): void;
	onOpenHostBeside?: (host: CompanionHost) => void;
	onShare(session: CompanionIdleSession): void;
	onOpenRoom(room: RecentRoom): void;
	onOpenRoomBeside?: (room: RecentRoom) => void;
}

const SETTLED_BY: Record<"user" | "idle" | "pr", string> = { user: "settled", idle: "idle", pr: "pull request done" };

function OrgRow(props: OrgRowProps): ReactNode {
	const { item, current, joining, disabled } = props;
	const title = itemTitle(item);
	const timer = useRef<Timer | undefined>(undefined);
	/** Where a touch is down; null while none is. */
	const origin = useRef<{ x: number; y: number } | null>(null);
	/** The press became a long press: the menu opens on release, and the click that follows is not a tap. */
	const held = useRef(false);

	const cancelHold = (): void => {
		clearTimeout(timer.current);
		timer.current = undefined;
		origin.current = null;
	};
	useEffect(() => cancelHold, []);

	const onPointerDown = (e: PointerEvent<HTMLLIElement>): void => {
		if (e.pointerType === "mouse") return;
		held.current = false;
		origin.current = { x: e.clientX, y: e.clientY };
		timer.current = setTimeout(() => {
			held.current = true;
			navigator.vibrate?.(8);
		}, LONG_PRESS_MS);
	};
	const onPointerMove = (e: PointerEvent<HTMLLIElement>): void => {
		const start = origin.current;
		if (start && !held.current && Math.hypot(e.clientX - start.x, e.clientY - start.y) > LONG_PRESS_SLOP_PX)
			cancelHold();
	};
	/** Opening while the finger is still down would put the sheet's backdrop under it, and the release would tap the backdrop shut. */
	const onRelease = (): void => {
		const long = held.current;
		cancelHold();
		if (!long) return;
		setTimeout(props.onMenu, 0);
		setTimeout(() => {
			held.current = false;
		}, LONG_PRESS_MS);
	};
	const onDragStart = (e: DragEvent<HTMLLIElement>): void => {
		e.dataTransfer.effectAllowed = "move";
		e.dataTransfer.setData("text/plain", item.key);
		props.onDragStart();
	};
	const onDragOver = (e: DragEvent<HTMLLIElement>): void => {
		e.preventDefault();
		e.dataTransfer.dropEffect = "move";
		props.onDragOver();
	};

	return (
		<li
			className="sh-recent sh-org-row"
			data-status={props.status}
			data-dropping={props.dropping || undefined}
			draggable={props.draggable}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onRelease}
			onPointerCancel={onRelease}
			onClickCapture={e => {
				if (!held.current) return;
				held.current = false;
				e.preventDefault();
				e.stopPropagation();
			}}
			onContextMenu={e => {
				e.preventDefault();
				// A finger still down: open on release (see onRelease). A mouse right-click opens now.
				if (origin.current === null) props.onMenu();
				else held.current = true;
			}}
			onDragStart={props.draggable ? onDragStart : undefined}
			onDragOver={props.draggable ? onDragOver : undefined}
			onDragEnd={props.draggable ? props.onDragEnd : undefined}
			onDrop={
				props.draggable
					? e => {
							e.preventDefault();
							props.onDrop();
						}
					: undefined
			}
		>
			{item.kind === "host" && (
				<button
					type="button"
					className="sh-recent-join"
					onClick={() => props.onJoinHost(item.host)}
					disabled={joining !== null || disabled || current}
					aria-current={current || undefined}
					title={item.host.cwd}
				>
					<span className="sh-recent-title">
						<span className="sh-recent-name">{title}</span>
						{current && <span className="sh-chip">here</span>}
						{item.host.sandboxed && <SandboxedChip />}
						{item.host.fanout && <FanoutChip fanout={item.host.fanout} />}
						{joining === item.host.instanceId && <LoaderCircle size={13} className="sh-spin" />}
					</span>
					<span className="sh-recent-meta">
						{props.wake ? (
							<span className="sh-host-state">snoozed {props.wake}</span>
						) : (
							<HostState host={item.host} />
						)}
						{props.settledBy && <span className="sh-host-state">{SETTLED_BY[props.settledBy]}</span>}
						<span className="sh-recent-cwd">{shortenPath(item.host.cwd)}</span>
						{item.host.participants > 1 && (
							<span className="sh-companion-people">
								<Users size={11} /> {item.host.participants - 1}
							</span>
						)}
						<span>{relTime(item.host.startedAt)}</span>
					</span>
				</button>
			)}
			{item.kind === "idle" && (
				<div className="sh-recent-join sh-idle-info" title={item.session.cwd}>
					<span className="sh-recent-title">
						<span className="sh-recent-name">{title}</span>
						<span className="sh-chip">not sharing</span>
						{item.session.sandboxed && <SandboxedChip />}
					</span>
					<span className="sh-recent-meta">
						{props.wake && <span className="sh-host-state">snoozed {props.wake}</span>}
						{props.settledBy && <span className="sh-host-state">{SETTLED_BY[props.settledBy]}</span>}
						{item.session.busy && <span className="sh-host-state sh-host-state-busy">working</span>}
						<span className="sh-recent-cwd">{shortenPath(item.session.cwd)}</span>
						<span>{relTime(item.session.startedAt)}</span>
					</span>
				</div>
			)}
			{item.kind === "room" && (
				<button
					type="button"
					className="sh-recent-join"
					onClick={() => props.onOpenRoom(item.room)}
					disabled={joining !== null}
				>
					<span className="sh-recent-title">
						<span className="sh-recent-name">{title}</span>
						{item.room.readOnly && <span className="sh-chip">read-only</span>}
					</span>
					<span className="sh-recent-meta">
						{props.wake && <span className="sh-host-state">snoozed {props.wake}</span>}
						{props.settledBy && <span className="sh-host-state">{SETTLED_BY[props.settledBy]}</span>}
						{item.room.cwd && <span className="sh-recent-cwd">{shortenPath(item.room.cwd)}</span>}
						<span>{relTime(item.room.lastSeen)}</span>
					</span>
				</button>
			)}
			{item.kind === "idle" && (
				<button
					type="button"
					className="sh-btn sh-idle-share"
					onClick={() => props.onShare(item.session)}
					disabled={joining !== null || disabled}
					aria-label={`share ${title}`}
				>
					{joining === item.session.instanceId ? (
						<LoaderCircle size={14} className="sh-spin" />
					) : (
						<Share2 size={14} />
					)}
					Share
				</button>
			)}
			{item.kind === "host" && props.onOpenHostBeside !== undefined && (
				<button
					type="button"
					className="sh-btn sh-btn-icon"
					onClick={() => props.onOpenHostBeside?.(item.host)}
					disabled={joining !== null || disabled || current}
					aria-label={`open ${title} beside`}
					title="open beside"
				>
					<PanelRight size={15} />
				</button>
			)}
			{item.kind === "room" && props.onOpenRoomBeside !== undefined && (
				<button
					type="button"
					className="sh-btn sh-btn-icon"
					onClick={() => props.onOpenRoomBeside?.(item.room)}
					disabled={joining !== null}
					aria-label={`open ${title} beside`}
					title="open beside"
				>
					<PanelRight size={15} />
				</button>
			)}
			<button
				type="button"
				className="sh-btn sh-btn-icon sh-org-more"
				onClick={props.onMenu}
				aria-label={`organise ${title}`}
				title="pin, snooze or settle"
				aria-haspopup="dialog"
			>
				<Ellipsis size={15} />
			</button>
		</li>
	);
}

interface OrgMenuProps {
	title: string;
	status: "active" | "pinned" | "snoozed" | "settled";
	/** Position among the pinned, -1 when not pinned. */
	pinIndex: number;
	pinCount: number;
	limitResetAt: number | null;
	now: number;
	onAct(action: Parameters<SessionOrgControl["act"]>[1], message: string): void;
	onMove(to: number): void;
	onClose(): void;
}

function OrgMenu(props: OrgMenuProps): ReactNode {
	const { status, pinIndex, pinCount, now } = props;
	const [snoozing, setSnoozing] = useState(false);
	return (
		<Sheet label={`organise ${props.title}`} onClose={props.onClose}>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title">{props.title}</div>
				<button type="button" className="sh-btn sh-btn-icon" onClick={props.onClose} aria-label="close">
					<X size={16} />
				</button>
			</div>
			<div className="sh-org-menu">
				{snoozing ? (
					snoozeChoices(now, props.limitResetAt).map(choice => (
						<button
							key={choice.id}
							type="button"
							className="sh-btn sh-org-menu-item"
							onClick={() => props.onAct({ type: "snooze", until: choice.until }, `Snoozed ${props.title}`)}
						>
							<Moon size={15} /> {choice.label}
						</button>
					))
				) : (
					<>
						{status === "pinned" ? (
							<button
								type="button"
								className="sh-btn sh-org-menu-item"
								onClick={() => props.onAct({ type: "unpin" }, `Unpinned ${props.title}`)}
							>
								<PinOff size={15} /> Unpin
							</button>
						) : (
							<button
								type="button"
								className="sh-btn sh-org-menu-item"
								onClick={() => props.onAct({ type: "pin" }, `Pinned ${props.title}`)}
							>
								<Pin size={15} /> Pin to top
							</button>
						)}
						{status === "pinned" && pinIndex > 0 && (
							<button
								type="button"
								className="sh-btn sh-org-menu-item"
								onClick={() => props.onMove(pinIndex - 1)}
							>
								<ArrowUp size={15} /> Move up
							</button>
						)}
						{status === "pinned" && pinIndex < pinCount - 1 && (
							<button
								type="button"
								className="sh-btn sh-org-menu-item"
								onClick={() => props.onMove(pinIndex + 1)}
							>
								<ArrowDown size={15} /> Move down
							</button>
						)}
						{status === "snoozed" ? (
							<button
								type="button"
								className="sh-btn sh-org-menu-item"
								onClick={() => props.onAct({ type: "wake" }, `Woke ${props.title}`)}
							>
								<Moon size={15} /> Wake now
							</button>
						) : (
							<button type="button" className="sh-btn sh-org-menu-item" onClick={() => setSnoozing(true)}>
								<Moon size={15} /> Snooze…
							</button>
						)}
						{status === "settled" ? (
							<button
								type="button"
								className="sh-btn sh-org-menu-item"
								onClick={() => props.onAct({ type: "unsettle" }, `Moved ${props.title} back`)}
							>
								<ArchiveRestore size={15} /> Move back to active
							</button>
						) : (
							<button
								type="button"
								className="sh-btn sh-org-menu-item"
								onClick={() => props.onAct({ type: "settle" }, `Settled ${props.title}`)}
							>
								<Archive size={15} /> Settle
							</button>
						)}
					</>
				)}
			</div>
		</Sheet>
	);
}

function OrgSettingsSheet({ org, onClose }: { org: SessionOrgControl; onClose(): void }): ReactNode {
	const { settings } = org.doc;
	return (
		<Sheet label="auto-settle" onClose={onClose}>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title">Auto-settle</div>
				<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="close">
					<X size={16} />
				</button>
			</div>
			<div className="sh-org-settings-body">
				<label className="sh-field">
					<span className="sh-field-label">Settle sessions that sit idle</span>
					<select
						className="sh-input"
						value={settings.idleDays ?? ""}
						onChange={e =>
							org.setSettings({ idleDays: e.currentTarget.value === "" ? null : Number(e.currentTarget.value) })
						}
					>
						<option value="">Never</option>
						{IDLE_DAY_CHOICES.map(days => (
							<option key={days} value={days}>
								for {days} days
							</option>
						))}
					</select>
					<span className="sh-field-hint">Pinned and snoozed sessions are left alone.</span>
				</label>
				{org.synced && (
					<label className="sh-org-check">
						<input
							type="checkbox"
							checked={settings.settleOnPr}
							onChange={e => org.setSettings({ settleOnPr: e.currentTarget.checked })}
						/>
						<span>Settle when the session's pull request merges or closes</span>
					</label>
				)}
				<span className="sh-field-hint">
					{org.synced
						? "Pins, snoozes and settled sessions follow you across devices through your computer."
						: "Kept on this device. Pair your computer to share it across devices."}
				</span>
			</div>
		</Sheet>
	);
}
