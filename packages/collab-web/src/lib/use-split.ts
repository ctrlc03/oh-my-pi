/**
 * Split view: a second live session beside the main one, and the editor docked beside it.
 * The second pane owns its own {@link GuestClient} (socket, room, replica) here, above
 * the main `Session`, so switching the main session does not drop it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useMedia } from "../components/codemap/shared";
import { GuestClient } from "./client";
import { computerById, type ComputerHandle } from "./computers";
import { extractLink, forgetRoom, moveRoom, type RecentRoom, roomIdOf } from "./rooms";
import { suspendsHiddenPages } from "./socket";
import { readJson, writeJson } from "./storage";

/** Desktop windows from 1200px, and tablets held landscape (an iPad is 1024px+ wide there). */
export const SPLIT_QUERY =
	"(min-width: 1200px), (min-width: 1024px) and (orientation: landscape) and (hover: none) and (pointer: coarse)";
/** Room for the docked editor and a second session at once; below it the session pane takes the dock. */
export const TWO_PANES_QUERY = "(min-width: 1500px)";
/** Docked editor preference (boolean, per device); absent: the editor opens as a sheet. */
export const IDE_DOCK_KEY = "omp.collab.ide-dock";

export function loadIdeDock(): boolean {
	return readJson(IDE_DOCK_KEY) === true;
}

export function saveIdeDock(docked: boolean): void {
	writeJson(IDE_DOCK_KEY, docked ? true : null);
}

/** Why `next` cannot open beside the main session, or null. One room cannot have two clients: both would send its queued prompts. */
export function besideConflict(mainLink: string | null, next: string): string | null {
	const room = roomIdOf(next);
	if (room === null) return "That is not a session link.";
	if (mainLink !== null && roomIdOf(mainLink) === room) return "That session is already open.";
	return null;
}

/** Which split pane the user last touched; shortcuts act on that one only. */
export type PaneName = "main" | "beside" | "editor";

let activePane: PaneName = "main";

export function focusedPane(): PaneName {
	return activePane;
}

/** Elements marked `data-pane="beside"|"editor"` claim focus; everything else belongs to the main session. */
function paneOf(target: EventTarget | null): PaneName | null {
	if (!(target instanceof Element)) return null;
	// Sheets are portaled outside every pane: opening one leaves the focus where it was.
	if (target.closest('[role="dialog"]') !== null) return null;
	const marked = target.closest("[data-pane]")?.getAttribute("data-pane");
	return marked === "beside" || marked === "editor" ? marked : "main";
}

function trackFocus(): () => void {
	const update = (e: Event): void => {
		const next = paneOf(e.target);
		if (next !== null) activePane = next;
	};
	document.addEventListener("pointerdown", update, true);
	document.addEventListener("focusin", update, true);
	return () => {
		document.removeEventListener("pointerdown", update, true);
		document.removeEventListener("focusin", update, true);
		activePane = "main";
	};
}

/**
 * Back from the background: reconnect now, not when the backoff expires; on phones and tablets,
 * whose OS suspends hidden pages, also replace a connection it may have killed silently.
 * Network back: replace the connection on every device.
 * Going to the background: save the transcript now, as the OS may kill the app there.
 */
export function useClientWake(client: GuestClient | null): void {
	useEffect(() => {
		if (!client) return;
		const wake = (): void => {
			if (document.visibilityState === "visible") client.resume();
			else {
				client.persist();
				if (suspendsHiddenPages()) client.suspend();
			}
		};
		const online = (): void => client.resume("online");
		document.addEventListener("visibilitychange", wake);
		window.addEventListener("online", online);
		window.addEventListener("pageshow", wake);
		return () => {
			document.removeEventListener("visibilitychange", wake);
			window.removeEventListener("online", online);
			window.removeEventListener("pageshow", wake);
		};
	}, [client]);
}

export interface BesidePane {
	link: string;
	client: GuestClient;
}

export interface BesideControl {
	/** The screen has room for a second pane; false: nothing opens beside, and an open pane has collapsed. */
	available: boolean;
	/** The session open beside the main one. */
	pane: BesidePane | null;
	/** Open `link` beside; returns a readable refusal, or null. */
	openLink(link: string): string | null;
	/** Fetch a link for a host of a computer (instance ids are only unique per computer) and open it beside; rejects with a readable message. */
	openHost(computerId: string, instanceId: string): Promise<void>;
	/** Reconnect the pane to its room with a fresh client. */
	rejoin(): void;
	/** The host replaced the pane's room: follow it, carrying the draft and queued prompts. */
	replace(next: string): void;
	/** The relay no longer knows the pane's room: close it and forget the room. */
	gone(roomId: string): void;
	close(): void;
}

/**
 * The second pane's client lifecycle: at most one, closed when the pane closes, the screen
 * narrows (the room stays in recents: it was remembered once it welcomed us), the app
 * returns to the connect screen, or the main session switches to the same room.
 */
export function useBesideSession(
	mainLink: string | null,
	computers: readonly ComputerHandle[],
	displayName: () => string,
	onRooms: (rooms: RecentRoom[]) => void,
): BesideControl {
	const available = useMedia(SPLIT_QUERY);
	const [pane, setPane] = useState<BesidePane | null>(null);
	const paneRef = useRef<BesidePane | null>(null);
	const mainRef = useRef(mainLink);
	mainRef.current = mainLink;

	useEffect(trackFocus, []);

	const install = useCallback((next: BesidePane | null): void => {
		paneRef.current?.client.close();
		paneRef.current = next;
		setPane(next);
	}, []);

	const connect = useCallback(
		(link: string): BesidePane | string => {
			let client: GuestClient;
			try {
				client = new GuestClient(link, displayName());
			} catch (err) {
				return err instanceof Error ? err.message : String(err);
			}
			client.connect();
			return { link, client };
		},
		[displayName],
	);

	const openLink = useCallback(
		(link: string): string | null => {
			const conflict = besideConflict(mainRef.current, link);
			if (conflict !== null) return conflict;
			const current = paneRef.current;
			if (current !== null && roomIdOf(current.link) === roomIdOf(link)) return null;
			const next = connect(link);
			if (typeof next === "string") return next;
			install(next);
			return null;
		},
		[connect, install],
	);

	const openHost = useCallback(
		async (computerId: string, instanceId: string): Promise<void> => {
			const client = computerById(computers, computerId)?.client ?? null;
			if (client === null) throw new Error("that computer is not paired");
			const link = extractLink(await client.requestLink(instanceId));
			if (link === null) throw new Error("the computer returned an unreadable link");
			const refusal = openLink(link);
			if (refusal !== null) throw new Error(refusal);
		},
		[computers, openLink],
	);

	const rejoin = useCallback((): void => {
		const current = paneRef.current;
		if (current === null) return;
		const next = connect(current.link);
		if (typeof next !== "string") install(next);
	}, [connect, install]);

	const replace = useCallback(
		(link: string): void => {
			const current = paneRef.current;
			if (current === null) return;
			const from = roomIdOf(current.link);
			const to = roomIdOf(link);
			if (from !== null && to !== null) onRooms(moveRoom(from, to));
			const next = connect(link);
			install(typeof next === "string" ? null : next);
		},
		[connect, install, onRooms],
	);

	const close = useCallback((): void => install(null), [install]);

	const gone = useCallback(
		(roomId: string): void => {
			onRooms(forgetRoom(roomId));
			install(null);
		},
		[install, onRooms],
	);

	const mainRoom = mainLink === null ? null : roomIdOf(mainLink);
	useEffect(() => {
		const current = paneRef.current;
		if (current === null) return;
		if (!available || mainRoom === null || roomIdOf(current.link) === mainRoom) install(null);
	}, [available, mainRoom, pane, install]);

	useEffect(
		() => () => {
			paneRef.current?.client.close();
			paneRef.current = null;
		},
		[],
	);

	useClientWake(pane?.client ?? null);

	return { available, pane, openLink, openHost, rejoin, replace, gone, close };
}
