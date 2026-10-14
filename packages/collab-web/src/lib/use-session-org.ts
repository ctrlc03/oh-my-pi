import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CompanionClient } from "./companion";
import type { ComputerHandle } from "./computers";
import { DEVICE_ORG, loadOrg, saveOrg } from "./org-storage";
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
	pruneOrg,
	restoreEntries,
	roomOrgKey,
	sameOrg,
	withSettings,
} from "./session-org";

/** Snoozes wake and the clock-driven views refresh this often. */
const CLOCK_MS = 30_000;

export interface SessionOrgControl {
	doc: OrgDoc;
	/** Wall clock, refreshed every {@link CLOCK_MS}: a snooze past it shows as active. */
	now: number;
	/** The document is kept on the computer and follows the user across devices. */
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
	/** The computer can end sessions when they settle ({@link CompanionSnapshot.canEndOnSettle}); the setting is only offered then. */
	canEndOnSettle: boolean;
	setSettings(patch: Partial<Pick<OrgSettings, "idleDays" | "settleOnPr" | "endOnSettle">>): void;
}

/** The organisation of every computer's sessions: each computer keeps its own document, and sessions no computer lists share the device's. */
export interface SessionOrgs {
	/** The control for a computer (its id), or for the device's own ({@link DEVICE_ORG}). */
	of(owner: string): SessionOrgControl;
}

/** What one document's control last showed, kept so an unchanged document hands out the same control. */
interface Cached {
	doc: OrgDoc;
	now: number;
	synced: boolean;
	extras: boolean;
	canEndOnSettle: boolean;
	control: SessionOrgControl;
}

/** The owner whose document a recent room belongs to. */
export function roomOwner(room: RecentRoom, computers: readonly Pick<ComputerHandle, "id">[]): string {
	return room.computerId !== undefined && computers.some(computer => computer.id === room.computerId)
		? room.computerId
		: DEVICE_ORG;
}

/**
 * The user's pin / snooze / settle choices. Kept in localStorage, one document per computer; with a computer that
 * keeps one they are merged into it (last writer wins per session), so every device shows the same organisation.
 * Idle auto-settle runs here for recent rooms, which the computer does not know; for its sessions the computer
 * applies it.
 */
export function useSessionOrgs(computers: readonly ComputerHandle[], rooms: readonly RecentRoom[]): SessionOrgs {
	const docs = useRef<Record<string, OrgDoc>>({});
	/** Local changes the computer has not acknowledged yet. */
	const dirty = useRef<Record<string, boolean>>({});
	const lastRev = useRef<Record<string, number | null>>({});
	const cache = useRef<Record<string, Cached>>({});
	const [version, setVersion] = useState(0);
	const [now, setNow] = useState(() => Date.now());
	const computersRef = useRef(computers);
	computersRef.current = computers;

	const docOf = useCallback((owner: string): OrgDoc => {
		if (!Object.hasOwn(docs.current, owner)) docs.current[owner] = loadOrg(owner);
		return docs.current[owner]!;
	}, []);

	const commit = useCallback(
		(owner: string, next: OrgDoc): void => {
			if (sameOrg(next, docOf(owner))) return;
			docs.current[owner] = next;
			saveOrg(owner, next);
			setVersion(v => v + 1);
		},
		[docOf],
	);

	const syncedClient = useCallback((owner: string): CompanionClient | null => {
		const computer = computersRef.current.find(candidate => candidate.id === owner);
		return computer?.snap.phase === "live" && computer.snap.sessionOrgRev !== null ? computer.client : null;
	}, []);

	const push = useCallback(
		async (owner: string, to: CompanionClient): Promise<void> => {
			dirty.current[owner] = false;
			try {
				const reply = await to.syncSessionOrg(docOf(owner));
				lastRev.current[owner] = reply.rev;
				commit(owner, pruneOrg(mergeOrg(docOf(owner), reply.doc), Date.now()));
			} catch {
				// Offline: the next connection or change sends it again.
				dirty.current[owner] = true;
			}
		},
		[commit, docOf],
	);

	const change = useCallback(
		(owner: string, next: OrgDoc): void => {
			if (next === docOf(owner)) return;
			commit(owner, next);
			dirty.current[owner] = true;
			const client = syncedClient(owner);
			if (client !== null) void push(owner, client);
		},
		[commit, docOf, push, syncedClient],
	);

	useEffect(() => {
		for (const computer of computers) {
			const client = syncedClient(computer.id);
			if (client === null) continue;
			docOf(computer.id);
			const known = Object.hasOwn(lastRev.current, computer.id) ? lastRev.current[computer.id] : undefined;
			if (dirty.current[computer.id] === true || computer.snap.sessionOrgRev !== known)
				void push(computer.id, client);
		}
	}, [computers, docOf, push, syncedClient]);

	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
		return () => clearInterval(timer);
	}, []);

	// A removed computer's document goes with it.
	useEffect(() => {
		const present = new Set<string>(computers.map(computer => computer.id));
		for (const owner of Object.keys(docs.current)) {
			if (owner === DEVICE_ORG || present.has(owner)) continue;
			delete docs.current[owner];
			delete dirty.current[owner];
			delete lastRev.current[owner];
			delete cache.current[owner];
		}
	}, [computers]);

	const idleDays = [DEVICE_ORG, ...computers.map(computer => computer.id)]
		.map(owner => docOf(owner).settings.idleDays)
		.join(",");
	useEffect(() => {
		const owners = new Set<string>([DEVICE_ORG, ...computersRef.current.map(computer => computer.id)]);
		for (const owner of owners) {
			const idle = rooms
				.filter(room => roomOwner(room, computersRef.current) === owner)
				.map(room => ({ key: roomOrgKey(room.roomId), lastActive: room.lastSeen, working: false }));
			change(owner, autoSettleIdle(docOf(owner), idle, now));
		}
	}, [rooms, now, idleDays, change, docOf]);

	const controlFor = useCallback(
		(owner: string): SessionOrgControl => {
			const doc = docOf(owner);
			const computer = computers.find(candidate => candidate.id === owner);
			const synced = syncedClient(owner) !== null;
			const extras = !synced || computer?.snap.canOrderSessions === true;
			const canEndOnSettle = synced && computer?.snap.canEndOnSettle === true;
			const hit = Object.hasOwn(cache.current, owner) ? cache.current[owner]! : null;
			if (
				hit !== null &&
				hit.doc === doc &&
				hit.now === now &&
				hit.synced === synced &&
				hit.extras === extras &&
				hit.canEndOnSettle === canEndOnSettle
			) {
				return hit.control;
			}
			// The actions read the document when they run: they stay the same through changes to it.
			const control: SessionOrgControl = {
				doc,
				now,
				synced,
				extras,
				canEndOnSettle,
				act: (key, action) => change(owner, applyOrg(docOf(owner), key, action, Date.now())),
				edit: run => {
					const next = run(docOf(owner), Date.now());
					const prev = changedEntries(docOf(owner), next);
					change(owner, next);
					return prev;
				},
				restore: prev => change(owner, restoreEntries(docOf(owner), prev, Date.now())),
				setSettings: patch => change(owner, withSettings(docOf(owner), patch, Date.now())),
			};
			cache.current[owner] = { doc, now, synced, extras, canEndOnSettle, control };
			return control;
		},
		[change, computers, docOf, now, syncedClient],
	);

	// `version` is what changes when a document does; the controls read the documents from the refs.
	return useMemo<SessionOrgs>(() => ({ of: controlFor }), [controlFor, version]);
}
