import {
	Archive,
	ArchiveRestore,
	ChevronDown,
	ChevronRight,
	Moon,
	Pin,
	PinOff,
	SlidersHorizontal,
	Sun,
	Undo2,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CompanionHost, CompanionIdleSession, SessionOverview } from "../../lib/companion";
import type { RecentRoom } from "../../lib/rooms";
import {
	applyMany,
	applyOrg,
	arrangeActive,
	autoSettles,
	type DropIntent,
	type DropLayout,
	type DropZone,
	dropIntent,
	dropSession,
	moveTarget,
	type OrgAction,
	type OrgDoc,
	type OrgEntry,
	type OrgSection,
	pinnedKeys,
	placeKey,
	roomOrgKey,
	sectionize,
	type SnoozeChoice,
	statusOf,
	wakeLabel,
} from "../../lib/session-org";
import type { SessionOrgControl } from "../../lib/use-session-org";
import { OrgMenu, OrgSettingsSheet, OrgSnoozeSheet } from "./OrgMenu";
import { isWorking, itemTitle, OrgRow, type OrgItem, type OrgMode } from "./OrgRow";
import { type RangeAction, useOrgDrag } from "./use-org-drag";
import "./session-org.css";

const UNDO_MS = 7000;

type EndedItem = Extract<OrgItem, { kind: "ended" }>;

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
	/** Sessions that ended while settled (the computer ended them when they settled), newest first; the ones still running are not among them. */
	ended: readonly SessionOverview[];
	/** The computer can start sessions, so an ended one can be resumed. */
	canResume: boolean;
	/**
	 * Resume an ended session (and open it when `open`); resolves with whether it came back. Called when one is
	 * opened or moved back to active; shows its own error when it fails.
	 */
	onResumeEnded(session: SessionOverview, open: boolean): Promise<boolean>;
}

/** One undo for the last change, however many sessions it touched: the entries as they were. */
interface Undo {
	message: string;
	prev: Record<string, OrgEntry | null>;
}

const DROP_MESSAGE: Record<Exclude<DropIntent, "reorder">, (title: string) => string> = {
	pin: title => `Pinned ${title}`,
	unpin: title => `Unpinned ${title}`,
	settle: title => `Settled ${title}`,
	unsettle: title => `Moved ${title} back`,
	wake: title => `Woke ${title}`,
};

const RANGE: Record<RangeAction, { action: OrgAction; past: string }> = {
	settle: { action: { type: "settle" }, past: "Settled" },
	unsettle: { action: { type: "unsettle" }, past: "Moved" },
	wake: { action: { type: "wake" }, past: "Woke" },
};

/** What a drop does, as the badge on the dragged row names it. */
export const INTENT_BADGE: Record<Exclude<DropIntent, "reorder">, { label: string; Icon: typeof Pin }> = {
	pin: { label: "Pin", Icon: Pin },
	unpin: { label: "Unpin", Icon: PinOff },
	settle: { label: "Settle", Icon: Archive },
	unsettle: { label: "Un-settle", Icon: ArchiveRestore },
	wake: { label: "Wake", Icon: Sun },
};

const RANGE_BADGE: Record<RangeAction, { label: string; Icon: typeof Pin }> = {
	settle: INTENT_BADGE.settle,
	unsettle: INTENT_BADGE.unsettle,
	wake: INTENT_BADGE.wake,
};

/** "Settled Foo" for one session, "Settled 3 sessions" for several (`Moved 3 sessions back` for un-settle). */
function bulkMessage(past: string, titles: readonly string[]): string {
	if (titles.length === 1) return `${past} ${titles[0]}${past === "Moved" ? " back" : ""}`;
	return `${past} ${titles.length} sessions${past === "Moved" ? " back" : ""}`;
}

const quickOf = (section: OrgSection): RangeAction =>
	section === "settled" ? "unsettle" : section === "snoozed" ? "wake" : "settle";

/** A text field has its own undo: leave ⌘Z to it. */
function isTextTarget(target: EventTarget | null): boolean {
	return (
		target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
	);
}

/**
 * Sessions sorted into Pinned, Working, Active, Snoozed and Settled, each row with a menu (⋯, right-click, long
 * press). Rows are dragged between the sections with a mouse, or in arrange mode with a finger; several can be
 * picked in select mode. Every change shows one Undo (⌘Z too).
 */
export function OrgSessions(props: OrgSessionsProps): ReactNode {
	const { hosts, idle, rooms, org, currentSessionId } = props;
	const { doc, now } = org;
	const [settledOpen, setSettledOpen] = useState(false);
	const [menu, setMenu] = useState<string | null>(null);
	const [undo, setUndo] = useState<Undo | null>(null);
	const [organising, setOrganising] = useState(false);
	const [mode, setMode] = useState<OrgMode>("idle");
	const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
	const [snoozingPicked, setSnoozingPicked] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	/** Where Shift-click picking extends from. */
	const anchor = useRef<string | null>(null);

	const items: OrgItem[] = [
		...hosts.map((host): OrgItem => ({ kind: "host", key: host.sessionId, host })),
		...idle.map((session): OrgItem => ({ kind: "idle", key: session.sessionId, session })),
		...rooms.map((room): OrgItem => ({ kind: "room", key: roomOrgKey(room.roomId), room })),
		...props.ended.map((session): OrgItem => ({ kind: "ended", key: session.sessionId, session })),
	];
	const sections = sectionize(items, item => item.key, isWorking, doc, now);
	const keysOf = (list: readonly OrgItem[]): string[] => list.map(item => item.key);
	const pinned = pinnedKeys(doc).filter(key => sections.pinned.some(item => item.key === key));
	const activeKeys = keysOf(sections.active);
	/** Rows as listed on screen, top to bottom (settled ones only while that shelf is open). */
	const shown = [
		...pinned,
		...keysOf(sections.working),
		...activeKeys,
		...keysOf(sections.snoozed),
		...(settledOpen ? keysOf(sections.settled) : []),
	];
	const menuItem = menu === null ? undefined : items.find(item => item.key === menu);
	const pickedKeys = shown.filter(key => picked.has(key));
	const titleOf = (key: string): string => {
		const item = items.find(candidate => candidate.key === key);
		return item === undefined ? key : itemTitle(item);
	};
	const layout: DropLayout = { pinned, active: org.extras ? activeKeys : null };
	const endedOf = (keys: readonly string[]): EndedItem[] =>
		items.filter((item): item is EndedItem => item.kind === "ended" && keys.includes(item.key));

	/**
	 * Change the document and offer one Undo for everything the change touched. `resuming`: ended sessions the change
	 * moves back to active; they are resumed first, and the change waits for it (a refusal leaves them settled).
	 */
	const commit = (
		message: string,
		run: (doc: OrgDoc, at: number) => OrgDoc,
		resuming: readonly EndedItem[] = [],
	): void => {
		const apply = (): void => {
			const prev = org.edit(run);
			if (message !== "" && Object.keys(prev).length > 0) setUndo({ message, prev });
		};
		if (resuming.length === 0) apply();
		else
			void Promise.all(resuming.map(item => props.onResumeEnded(item.session, false))).then(resumed => {
				if (resumed.every(Boolean)) apply();
			});
	};

	const drag = useOrgDrag({
		rootRef,
		ordered: org.extras,
		onDrop: (key, from, zone: DropZone, index) => {
			const intent = dropIntent(from, zone, org.extras);
			if (intent === null) return;
			const resuming = endedOf([key]);
			// An ended session only goes back to active, which resumes it: anywhere else it would drop out of the list.
			if (resuming.length > 0 && intent !== "unsettle") return;
			const message = intent === "reorder" ? "" : DROP_MESSAGE[intent](titleOf(key));
			commit(message, (current, at) => dropSession(current, key, from, zone, index, layout, at), resuming);
		},
		onRange: (action, keys) => {
			const { action: apply, past } = RANGE[action];
			commit(
				bulkMessage(past, keys.map(titleOf)),
				(current, at) => applyMany(current, keys, apply, at),
				action === "unsettle" ? endedOf(keys) : [],
			);
		},
	});
	const view = drag.view;

	useEffect(() => {
		if (undo === null) return;
		const timer = setTimeout(() => setUndo(null), UNDO_MS);
		const onKey = (e: KeyboardEvent): void => {
			if (e.key.toLowerCase() !== "z" || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
			if (isTextTarget(e.target)) return;
			e.preventDefault();
			org.restore(undo.prev);
			setUndo(null);
		};
		window.addEventListener("keydown", onKey);
		return () => {
			clearTimeout(timer);
			window.removeEventListener("keydown", onKey);
		};
	}, [undo, org]);

	const leaveMode = (): void => {
		setMode("idle");
		setPicked(new Set());
		setSnoozingPicked(false);
		anchor.current = null;
	};

	const pick = (key: string, range: boolean): void => {
		const next = new Set(picked);
		const from = range && anchor.current !== null ? shown.indexOf(anchor.current) : -1;
		const to = shown.indexOf(key);
		if (from !== -1 && to !== -1)
			for (const between of shown.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(between);
		else if (next.has(key)) next.delete(key);
		else next.add(key);
		anchor.current = key;
		setMode("select");
		setPicked(next);
	};

	const act = (item: OrgItem, action: OrgAction, message: string): void => {
		commit(
			message,
			(current, at) => applyOrg(current, item.key, action, at),
			action.type === "unsettle" ? endedOf([item.key]) : [],
		);
		setMenu(null);
	};

	/** The same change for every picked session, then back to the plain list with its Undo showing. */
	const actPicked = (action: OrgAction, past: string): void => {
		const keys = pickedKeys;
		commit(
			bulkMessage(past, keys.map(titleOf)),
			(current, at) => applyMany(current, keys, action, at),
			action.type === "unsettle" ? endedOf(keys) : [],
		);
		leaveMode();
	};

	const move = (item: OrgItem, to: number): void => {
		const section = sections.pinned.includes(item) ? "pinned" : "active";
		if (section === "pinned") {
			commit("", (current, at) => applyOrg(current, item.key, moveTarget(pinned, pinned.indexOf(item.key), to), at));
		} else {
			commit("", (current, at) => arrangeActive(current, placeKey(activeKeys, item.key, to), at));
		}
		setMenu(null);
	};

	const row = (item: OrgItem, section: OrgSection): ReactNode => (
		<OrgRow
			key={item.key}
			item={item}
			section={section}
			mode={mode}
			wake={section === "snoozed" ? wakeLabel(doc.entries[item.key].until ?? now, now) : null}
			settledBy={section === "settled" ? doc.entries[item.key].reason : undefined}
			current={item.kind === "host" && item.host.sessionId === currentSessionId}
			joining={props.joining}
			disabled={props.disabled}
			selected={picked.has(item.key)}
			lifted={view?.kind === "move" && view.key === item.key}
			swept={view?.kind === "range" && view.keys.includes(item.key)}
			autoSettleOff={!autoSettles(doc, item.key)}
			quick={quickOf(section)}
			onQuick={() => {
				const { action, past } = RANGE[quickOf(section)];
				commit(
					bulkMessage(past, [itemTitle(item)]),
					(current, at) => applyOrg(current, item.key, action, at),
					action.type === "unsettle" ? endedOf([item.key]) : [],
				);
			}}
			onDrag={drag.begin}
			onPick={range => pick(item.key, range)}
			onMenu={() => setMenu(item.key)}
			onJoinHost={props.onJoinHost}
			onOpenHostBeside={props.onOpenHostBeside}
			onShare={props.onShare}
			onOpenRoom={props.onOpenRoom}
			onOpenRoomBeside={props.onOpenRoomBeside}
			resumable={props.canResume}
			onResumeEnded={session => void props.onResumeEnded(session, true)}
		/>
	);

	const over = (section: OrgSection): true | undefined =>
		view?.kind === "move" && view.over === section && view.intent !== null ? true : undefined;
	/** Empty Pinned and Active still take drops: they show where, while a row is dragged or the arrange mode is on. */
	const offerEmpty = view?.kind === "move" || mode === "arrange";
	const EMPTY_HINT: Partial<Record<OrgSection, string>> = { pinned: "Drop here to pin", active: "Drop here" };

	const block = (title: string, section: Exclude<OrgSection, "settled">): ReactNode => {
		const empty = sections[section].length === 0;
		if (empty && !(offerEmpty && (section === "pinned" || section === "active"))) return null;
		return (
			<section
				className="sh-org-section"
				aria-label={title}
				data-org-zone=""
				data-org-section={section}
				data-over={over(section)}
			>
				<h3 className="sh-recents-title sh-org-title" data-org-slide="">
					{title}
				</h3>
				{empty ? (
					<div className="sh-org-empty">{EMPTY_HINT[section]}</div>
				) : (
					<ul className="sh-recents-list">{sections[section].map(item => row(item, section))}</ul>
				)}
			</section>
		);
	};

	const settledCount = sections.settled.length;
	const allPickedPinned = pickedKeys.length > 0 && pickedKeys.every(key => statusOf(doc, key, now) === "pinned");
	const allPickedSettled = pickedKeys.length > 0 && pickedKeys.every(key => statusOf(doc, key, now) === "settled");
	const anyPickedSnoozed = pickedKeys.some(key => statusOf(doc, key, now) === "snoozed");
	/** An ended session can only be moved back to active (which resumes it): pinning or snoozing it would hide it. */
	const anyPickedEnded = endedOf(pickedKeys).length > 0;

	const menuStatus = menuItem === undefined ? "active" : statusOf(doc, menuItem.key, now);
	const menuPlace =
		menuItem === undefined
			? null
			: sections.pinned.includes(menuItem)
				? { index: pinned.indexOf(menuItem.key), count: pinned.length }
				: org.extras && sections.active.includes(menuItem)
					? { index: activeKeys.indexOf(menuItem.key), count: activeKeys.length }
					: null;

	return (
		<div ref={rootRef} className="sh-org" data-mode={mode}>
			{block("Pinned", "pinned")}
			{block("Working", "working")}
			{block("Active", "active")}
			{block("Snoozed", "snoozed")}
			{items.length > 0 && (
				<section
					className="sh-org-section"
					aria-label="Settled"
					data-org-zone=""
					data-org-section="settled"
					data-over={over("settled")}
				>
					<h3 className="sh-recents-title sh-org-title" data-org-slide="">
						<button
							type="button"
							className="sh-org-fold"
							onClick={() => setSettledOpen(open => !open)}
							aria-expanded={settledOpen}
							disabled={settledCount === 0}
						>
							{settledOpen && settledCount > 0 ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
							Settled
							{settledCount > 0 && <span className="sh-org-count">{settledCount}</span>}
						</button>
						<button
							type="button"
							className="sh-btn sh-btn-icon sh-org-settings"
							onClick={() => setOrganising(true)}
							aria-label="Auto-settle settings"
						>
							<SlidersHorizontal size={14} />
						</button>
					</h3>
					{settledOpen && settledCount > 0 && (
						<ul className="sh-recents-list">{sections.settled.map(item => row(item, "settled"))}</ul>
					)}
				</section>
			)}
			{(undo !== null || mode !== "idle") && (
				<div className="sh-org-dock">
					{undo && (
						<div className="sh-org-undo" role="status">
							<span className="sh-org-undo-msg">{undo.message}</span>
							<button
								type="button"
								className="sh-btn"
								onClick={() => {
									org.restore(undo.prev);
									setUndo(null);
								}}
							>
								<Undo2 size={14} /> Undo
							</button>
						</div>
					)}
					{mode === "arrange" && (
						<div className="sh-org-bar" role="group" aria-label="Arrange sessions">
							<span className="sh-org-bar-msg">
								<strong>Arrange sessions</strong>
								<span>Drag a handle. Each drop saves.</span>
							</span>
							<button type="button" className="sh-btn sh-btn-primary" onClick={leaveMode}>
								Done
							</button>
						</div>
					)}
					{mode === "select" && (
						<div className="sh-org-bar" role="group" aria-label="Selected sessions">
							<span className="sh-org-bar-msg">
								<strong>{pickedKeys.length} selected</strong>
							</span>
							<span className="sh-org-bar-actions">
								<button
									type="button"
									className="sh-btn"
									disabled={pickedKeys.length === 0 || anyPickedEnded}
									onClick={() =>
										actPicked(
											{ type: allPickedPinned ? "unpin" : "pin" },
											allPickedPinned ? "Unpinned" : "Pinned",
										)
									}
								>
									{allPickedPinned ? <PinOff size={14} /> : <Pin size={14} />}{" "}
									{allPickedPinned ? "Unpin" : "Pin"}
								</button>
								<button
									type="button"
									className="sh-btn"
									disabled={pickedKeys.length === 0 || anyPickedEnded}
									onClick={() => setSnoozingPicked(true)}
								>
									<Moon size={14} /> Snooze
								</button>
								<button
									type="button"
									className="sh-btn"
									disabled={pickedKeys.length === 0}
									onClick={() =>
										actPicked(
											{ type: allPickedSettled ? "unsettle" : "settle" },
											allPickedSettled ? "Moved" : "Settled",
										)
									}
								>
									{allPickedSettled ? <ArchiveRestore size={14} /> : <Archive size={14} />}{" "}
									{allPickedSettled ? "Un-settle" : "Settle"}
								</button>
								{anyPickedSnoozed && (
									<button type="button" className="sh-btn" onClick={() => actPicked({ type: "wake" }, "Woke")}>
										<Sun size={14} /> Wake
									</button>
								)}
							</span>
							<button type="button" className="sh-btn sh-btn-primary" onClick={leaveMode}>
								Done
							</button>
						</div>
					)}
				</div>
			)}
			{menuItem && (
				<OrgMenu
					title={itemTitle(menuItem)}
					status={menuStatus}
					place={menuPlace}
					autoSettle={
						menuStatus === "settled" || !(org.extras || menuItem.kind === "room")
							? null
							: autoSettles(doc, menuItem.key)
					}
					limitResetAt={
						menuItem.kind === "host" && menuItem.host.sessionId === currentSessionId ? props.limitResetAt : null
					}
					ended={menuItem.kind === "ended"}
					now={now}
					onAct={(action, message) => act(menuItem, action, message)}
					onMove={to => move(menuItem, to)}
					onArrange={() => {
						leaveMode();
						setMode("arrange");
						setMenu(null);
					}}
					onSelect={() => {
						leaveMode();
						pick(menuItem.key, false);
						setMenu(null);
					}}
					onClose={() => setMenu(null)}
				/>
			)}
			{snoozingPicked && (
				<OrgSnoozeSheet
					title={`Snooze ${pickedKeys.length} sessions`}
					now={now}
					onPick={(choice: SnoozeChoice) => actPicked({ type: "snooze", until: choice.until }, "Snoozed")}
					onClose={() => setSnoozingPicked(false)}
				/>
			)}
			{organising && <OrgSettingsSheet org={org} onClose={() => setOrganising(false)} />}
			{view !== null &&
				createPortal(
					<div ref={drag.ghost} className="sh-org-ghost" data-kind={view.kind}>
						{view.kind === "move" ? (
							<>
								<span className="sh-org-ghost-title">{titleOf(view.key)}</span>
								{view.intent !== null && view.intent !== "reorder" && (
									<GhostBadge badge={INTENT_BADGE[view.intent]} />
								)}
							</>
						) : (
							view.action !== null && (
								<GhostBadge
									badge={RANGE_BADGE[view.action]}
									count={view.keys.length > 1 ? view.keys.length : undefined}
								/>
							)
						)}
					</div>,
					document.body,
				)}
		</div>
	);
}

function GhostBadge({ badge, count }: { badge: { label: string; Icon: typeof Pin }; count?: number }): ReactNode {
	return (
		<span className="sh-org-badge">
			<badge.Icon size={13} /> {badge.label}
			{count !== undefined && ` ${count}`}
		</span>
	);
}
