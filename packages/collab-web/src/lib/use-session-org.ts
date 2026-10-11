import { useCallback, useEffect, useRef, useState } from "react";
import type { CompanionClient } from "./companion";
import type { RecentRoom } from "./rooms";
import {
	applyOrg,
	autoSettleIdle,
	changedEntries,
	mergeOrg,
	type OrgAction,
	type OrgDoc,
	type OrgEntry,
	type OrgSettings,
	parseOrg,
	pruneOrg,
	restoreEntries,
	roomOrgKey,
	sameOrg,
	withSettings,
} from "./session-org";
import { readJson, writeJson } from "./storage";

const STORAGE_KEY = "omp.collab.session-org";
/** Snoozes wake and the clock-driven views refresh this often. */
const CLOCK_MS = 30_000;

export interface SessionOrgControl {
	doc: OrgDoc;
	/** Wall clock, refreshed every {@link CLOCK_MS}: a snooze past it shows as active. */
	now: number;
	/** The document is kept on the paired computer and follows the user across devices. */
	synced: boolean;
	act(key: string, action: OrgAction): void;
	/**
	 * Change the document with `edit` (given the document and the clock); resolves to the entries it changed as
	 * they were, for {@link restore}. Empty when nothing changed.
	 */
	edit(edit: (doc: OrgDoc, now: number) => OrgDoc): Record<string, OrgEntry | null>;
	/** Put entries back as {@link edit} reported them. */
	restore(prev: Readonly<Record<string, OrgEntry | null>>): void;
	/** The active order and the per-session auto-settle choice are kept: always on this device, and with a paired computer only when it keeps them too. */
	extras: boolean;
	setSettings(patch: Partial<Pick<OrgSettings, "idleDays" | "settleOnPr">>): void;
}

export interface SessionOrgSource {
	client: CompanionClient | null;
	/** The computer answers, and keeps a document ({@link CompanionSnapshot.sessionOrgRev}). */
	live: boolean;
	orgRev: number | null;
	/** The computer keeps the active order and the auto-settle choice ({@link CompanionSnapshot.canOrderSessions}). */
	orderSessions: boolean;
}

/**
 * The user's pin / snooze / settle choices. Kept in localStorage; with a paired
 * computer that keeps a document they are merged into it (last writer wins per
 * session), so every device shows the same organisation. Idle auto-settle runs
 * here for recent rooms, which the computer does not know; for its sessions the
 * computer applies it.
 */
export function useSessionOrg(source: SessionOrgSource, rooms: readonly RecentRoom[]): SessionOrgControl {
	const { client, live, orgRev, orderSessions } = source;
	const [doc, setDoc] = useState<OrgDoc>(() => parseOrg(readJson(STORAGE_KEY)));
	const [now, setNow] = useState(() => Date.now());
	const docRef = useRef(doc);
	/** Local changes the computer has not acknowledged yet. */
	const dirty = useRef(false);
	const lastRev = useRef<number | null>(null);
	const synced = live && orgRev !== null && client !== null;

	const commit = useCallback((next: OrgDoc): void => {
		if (sameOrg(next, docRef.current)) return;
		docRef.current = next;
		setDoc(next);
		writeJson(STORAGE_KEY, next);
	}, []);

	const push = useCallback(
		async (to: CompanionClient): Promise<void> => {
			dirty.current = false;
			try {
				const reply = await to.syncSessionOrg(docRef.current);
				lastRev.current = reply.rev;
				commit(pruneOrg(mergeOrg(docRef.current, reply.doc), Date.now()));
			} catch {
				// Offline: the next connection or change sends it again.
				dirty.current = true;
			}
		},
		[commit],
	);

	const change = useCallback(
		(next: OrgDoc): void => {
			if (next === docRef.current) return;
			commit(next);
			dirty.current = true;
			if (synced && client) void push(client);
		},
		[commit, push, synced, client],
	);

	useEffect(() => {
		if (!synced || !client) return;
		if (dirty.current || orgRev !== lastRev.current) void push(client);
	}, [synced, client, orgRev, push]);

	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
		return () => clearInterval(timer);
	}, []);

	useEffect(() => {
		const idle = rooms.map(room => ({ key: roomOrgKey(room.roomId), lastActive: room.lastSeen, working: false }));
		change(autoSettleIdle(docRef.current, idle, now));
	}, [rooms, now, doc.settings.idleDays, change]);

	const act = useCallback(
		(key: string, action: OrgAction): void => change(applyOrg(docRef.current, key, action, Date.now())),
		[change],
	);
	const edit = useCallback(
		(run: (doc: OrgDoc, at: number) => OrgDoc): Record<string, OrgEntry | null> => {
			const next = run(docRef.current, Date.now());
			const prev = changedEntries(docRef.current, next);
			change(next);
			return prev;
		},
		[change],
	);
	const restore = useCallback(
		(prev: Readonly<Record<string, OrgEntry | null>>): void =>
			change(restoreEntries(docRef.current, prev, Date.now())),
		[change],
	);
	const setSettings = useCallback(
		(patch: Partial<Pick<OrgSettings, "idleDays" | "settleOnPr">>): void =>
			change(withSettings(docRef.current, patch, Date.now())),
		[change],
	);

	return { doc, now, synced, act, edit, restore, extras: !synced || orderSessions, setSettings };
}
