import {
	Archive,
	ArchiveRestore,
	Circle,
	CircleCheck,
	Ellipsis,
	GripVertical,
	LoaderCircle,
	PanelRight,
	Share2,
	Sun,
	TimerOff,
	Users,
} from "lucide-react";
import type { MouseEvent, PointerEvent, ReactNode } from "react";
import { useEffect, useRef } from "react";
import type { CompanionHost, CompanionIdleSession, SessionOverview } from "../../lib/companion";
import { relTime, shortenPath } from "../../lib/format";
import type { RecentRoom } from "../../lib/rooms";
import type { OrgSection } from "../../lib/session-org";
import { HostState, hostTitle, SandboxedChip } from "./CompanionCard";
import { AgentChip } from "./AgentChip";
import { FanoutChip } from "./FanoutSheet";
import { HighStakesMark } from "./StakesControl";
import type { DragSpec, RangeAction } from "./use-org-drag";

/** Holding a row this long on a touch screen opens its menu. */
const LONG_PRESS_MS = 450;
/** A finger that travels further than this is scrolling, not holding. */
const LONG_PRESS_SLOP_PX = 10;

export type OrgItem =
	| { kind: "host"; key: string; host: CompanionHost }
	| { kind: "idle"; key: string; session: CompanionIdleSession }
	| { kind: "room"; key: string; room: RecentRoom }
	/** A session that ended while settled (the computer may end it when it settles): listed from its history, resumed when opened. */
	| { kind: "ended"; key: string; session: SessionOverview };

export function itemTitle(item: OrgItem): string {
	if (item.kind === "host") return hostTitle(item.host);
	if (item.kind === "idle") return hostTitle(item.session);
	if (item.kind === "ended") return hostTitle({ sessionName: item.session.title, cwd: item.session.folder });
	return item.room.title;
}

export const isWorking = (item: OrgItem): boolean =>
	item.kind === "host" ? item.host.busy === true : item.kind === "idle" && item.session.busy === true;

/** `idle`: rows open and carry their buttons. `arrange`: rows carry a drag handle and open nothing. `select`: a tap picks the row. */
export type OrgMode = "idle" | "arrange" | "select";

export interface OrgRowProps {
	item: OrgItem;
	section: OrgSection;
	mode: OrgMode;
	/** Snoozed: when it wakes. */
	wake: string | null;
	/** Settled: who settled it. */
	settledBy: "user" | "idle" | "pr" | undefined;
	current: boolean;
	joining: string | null;
	disabled: boolean;
	/** Picked in select mode. */
	selected: boolean;
	/** The row is being dragged: its place stays, empty, until it lands. */
	lifted: boolean;
	/** The row is inside the sweep of a bulk button drag. */
	swept: boolean;
	/** The idle and pull request rules leave this session alone. */
	autoSettleOff: boolean;
	/** What the row's one-press button does (mouse: press and drag to apply it to the rows swept over). */
	quick: RangeAction;
	onQuick(): void;
	onDrag(e: PointerEvent, spec: DragSpec): void;
	/** A click with Shift or ⌘ (select mode: a plain click too); `range` for Shift. */
	onPick(range: boolean): void;
	onMenu(): void;
	onJoinHost(host: CompanionHost): void;
	onOpenHostBeside?: (host: CompanionHost) => void;
	onShare(session: CompanionIdleSession): void;
	onOpenRoom(room: RecentRoom): void;
	onOpenRoomBeside?: (room: RecentRoom) => void;
	/** The computer can start sessions, so an ended one can be resumed. */
	resumable: boolean;
	/** Open an ended session: it is resumed first. */
	onResumeEnded(session: SessionOverview): void;
}

const SETTLED_BY: Record<"user" | "idle" | "pr", string> = { user: "settled", idle: "idle", pr: "pull request done" };

const QUICK: Record<RangeAction, { label: string; Icon: typeof Archive }> = {
	settle: { label: "Settle", Icon: Archive },
	unsettle: { label: "Un-settle", Icon: ArchiveRestore },
	wake: { label: "Wake", Icon: Sun },
};

export function OrgRow(props: OrgRowProps): ReactNode {
	const { item, current, joining, disabled, mode, section } = props;
	const title = itemTitle(item);
	const timer = useRef<Timer | undefined>(undefined);
	/** Where a touch is down; null while none is. */
	const origin = useRef<{ x: number; y: number } | null>(null);
	/** The press became a long press: the menu opens on release, and the click that follows is not a tap. */
	const held = useRef(false);
	const quick = QUICK[props.quick];

	const cancelHold = (): void => {
		clearTimeout(timer.current);
		timer.current = undefined;
		origin.current = null;
	};
	useEffect(() => cancelHold, []);

	const onPointerDown = (e: PointerEvent<HTMLLIElement>): void => {
		if (mode === "select") return;
		if (e.pointerType === "mouse") {
			if (!(e.target as HTMLElement).closest("[data-org-nodrag]"))
				props.onDrag(e, { kind: "move", key: item.key, section });
			return;
		}
		if (mode !== "idle") return;
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
	const onClickCapture = (e: MouseEvent<HTMLLIElement>): void => {
		const swallow = (): void => {
			e.preventDefault();
			e.stopPropagation();
		};
		if (held.current) {
			held.current = false;
			swallow();
			return;
		}
		if (mode === "arrange") {
			swallow();
			return;
		}
		if (mode === "select") {
			swallow();
			props.onPick(e.shiftKey);
			return;
		}
		if ((e.shiftKey || e.metaKey || e.ctrlKey) && !(e.target as HTMLElement).closest("[data-org-nodrag]")) {
			swallow();
			props.onPick(e.shiftKey);
		}
	};

	return (
		<li
			className="sh-recent sh-org-row"
			data-status={section}
			data-mode={mode}
			data-org-key={item.key}
			data-org-section={section}
			data-org-slide=""
			data-lifted={props.lifted || undefined}
			data-swept={props.swept || undefined}
			data-selected={props.selected || undefined}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onRelease}
			onPointerCancel={onRelease}
			onClickCapture={onClickCapture}
			onContextMenu={e => {
				e.preventDefault();
				if (mode !== "idle") return;
				// A finger still down: open on release (see onRelease). A mouse right-click opens now.
				if (origin.current === null) props.onMenu();
				else held.current = true;
			}}
		>
			{mode === "arrange" && (
				<span
					className="sh-org-handle"
					data-org-nodrag=""
					aria-hidden
					onPointerDown={e => {
						e.stopPropagation();
						props.onDrag(e, { kind: "move", key: item.key, section });
					}}
				>
					<GripVertical size={16} />
				</span>
			)}
			{mode === "select" &&
				(props.selected ? (
					<CircleCheck size={18} className="sh-org-check-mark sh-org-check-on" aria-hidden />
				) : (
					<Circle size={18} className="sh-org-check-mark" aria-hidden />
				))}
			{item.kind === "host" && (
				<button
					type="button"
					className="sh-recent-join"
					onClick={() => props.onJoinHost(item.host)}
					disabled={joining !== null || disabled || current}
					aria-current={current || undefined}
					aria-pressed={mode === "select" ? props.selected : undefined}
					title={item.host.cwd}
				>
					<span className="sh-recent-title">
						<span className="sh-recent-name">{title}</span>
						{current && <span className="sh-chip">here</span>}
						{item.host.sandboxed && <SandboxedChip />}
						{item.host.highStakes === true && <HighStakesMark />}
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
						<AgentChip agent={item.host.agent} variant="mark" />
						{props.autoSettleOff && <AutoSettleOff />}
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
						{item.session.sandboxed && <SandboxedChip />}
						{item.session.highStakes === true && <HighStakesMark />}
					</span>
					<span className="sh-recent-meta">
						{props.wake && <span className="sh-host-state">snoozed {props.wake}</span>}
						{props.settledBy && <span className="sh-host-state">{SETTLED_BY[props.settledBy]}</span>}
						<span className={`sh-host-state${item.session.busy ? " sh-host-state-busy" : ""}`}>
							{item.session.busy ? "working" : "not sharing"}
						</span>
						<AgentChip agent={item.session.agent} variant="mark" />
						{props.autoSettleOff && <AutoSettleOff />}
						<span className="sh-recent-cwd">{shortenPath(item.session.cwd)}</span>
						<span>{relTime(item.session.startedAt)}</span>
					</span>
				</div>
			)}
			{item.kind === "ended" && (
				<button
					type="button"
					className="sh-recent-join"
					onClick={() => props.onResumeEnded(item.session)}
					disabled={joining !== null || props.disabled || !props.resumable}
					aria-pressed={mode === "select" ? props.selected : undefined}
					title={`${item.session.folder}: opening it resumes the session`}
				>
					<span className="sh-recent-title">
						<span className="sh-recent-name">{title}</span>
						{joining === item.key && <LoaderCircle size={13} className="sh-spin" />}
					</span>
					<span className="sh-recent-meta">
						<span className="sh-host-state">ended</span>
						{props.settledBy && <span className="sh-host-state">{SETTLED_BY[props.settledBy]}</span>}
						<AgentChip agent={item.session.agent} variant="mark" />
						{props.autoSettleOff && <AutoSettleOff />}
						<span className="sh-recent-cwd">{shortenPath(item.session.folder)}</span>
						<span>{relTime(item.session.endedAt ?? item.session.startedAt)}</span>
					</span>
				</button>
			)}
			{item.kind === "room" && (
				<button
					type="button"
					className="sh-recent-join"
					onClick={() => props.onOpenRoom(item.room)}
					disabled={joining !== null || current}
					aria-current={current || undefined}
					aria-pressed={mode === "select" ? props.selected : undefined}
				>
					<span className="sh-recent-title">
						<span className="sh-recent-name">{title}</span>
						{current && <span className="sh-chip">here</span>}
						{item.room.readOnly && <span className="sh-chip">read-only</span>}
					</span>
					<span className="sh-recent-meta">
						{props.wake && <span className="sh-host-state">snoozed {props.wake}</span>}
						{props.settledBy && <span className="sh-host-state">{SETTLED_BY[props.settledBy]}</span>}
						{props.autoSettleOff && <AutoSettleOff />}
						{item.room.cwd && <span className="sh-recent-cwd">{shortenPath(item.room.cwd)}</span>}
						<span>{relTime(item.room.lastSeen)}</span>
					</span>
				</button>
			)}
			{mode === "idle" && (
				<>
					<button
						type="button"
						className="sh-btn sh-btn-icon sh-org-quick"
						data-org-nodrag=""
						onPointerDown={e => {
							if (e.pointerType !== "mouse") return;
							e.stopPropagation();
							props.onDrag(e, { kind: "range", key: item.key, section, action: props.quick });
						}}
						onClick={props.onQuick}
						aria-label={`${quick.label} ${title}`}
					>
						<quick.Icon size={15} />
					</button>
					{item.kind === "idle" && (
						<button
							type="button"
							className="sh-btn sh-btn-icon"
							data-org-nodrag=""
							onClick={() => props.onShare(item.session)}
							disabled={joining !== null || disabled}
							aria-label={`Share ${title}`}
						>
							{joining === item.session.instanceId ? (
								<LoaderCircle size={15} className="sh-spin" />
							) : (
								<Share2 size={15} />
							)}
						</button>
					)}
					{item.kind === "host" && props.onOpenHostBeside !== undefined && (
						<button
							type="button"
							className="sh-btn sh-btn-icon"
							data-org-nodrag=""
							onClick={() => props.onOpenHostBeside?.(item.host)}
							disabled={joining !== null || disabled || current}
							aria-label={`Open ${title} beside`}
						>
							<PanelRight size={15} />
						</button>
					)}
					{item.kind === "room" && props.onOpenRoomBeside !== undefined && (
						<button
							type="button"
							className="sh-btn sh-btn-icon"
							data-org-nodrag=""
							onClick={() => props.onOpenRoomBeside?.(item.room)}
							disabled={joining !== null || current}
							aria-label={`Open ${title} beside`}
						>
							<PanelRight size={15} />
						</button>
					)}
					<button
						type="button"
						className="sh-btn sh-btn-icon sh-org-more"
						data-org-nodrag=""
						onClick={props.onMenu}
						aria-label={`Pin, snooze or settle ${title}`}
						aria-haspopup="dialog"
					>
						<Ellipsis size={15} />
					</button>
				</>
			)}
		</li>
	);
}

function AutoSettleOff(): ReactNode {
	return (
		<span className="sh-org-note" role="img" aria-label="Auto-settle off">
			<TimerOff size={11} />
		</span>
	);
}
