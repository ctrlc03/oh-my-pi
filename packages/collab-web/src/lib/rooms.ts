/**
 * Recent collab rooms, persisted in localStorage so an installed (home-screen)
 * client can rejoin without a link in the URL. A home-screen launch opens
 * `start_url` with no fragment, so this is the only way back into a session.
 *
 * Entries hold the full join link, room key and write token included. They stay on
 * this origin only and become useless once the host's room closes. Callers drop
 * a room when the relay reports it gone.
 */

import { parseCollabLink } from "./link";

const ROOMS_KEY = "omp.collab.rooms";
const ACTIVE_KEY = "omp.collab.active";
const MAX_ROOMS = 12;

export interface RecentRoom {
	roomId: string;
	link: string;
	title: string;
	cwd: string | null;
	readOnly: boolean;
	/** epoch ms of the last successful join. */
	lastSeen: number;
}

function readJson(key: string): unknown {
	try {
		const raw = localStorage.getItem(key);
		return raw === null ? null : JSON.parse(raw);
	} catch {
		return null;
	}
}

function writeRaw(key: string, value: string | null): void {
	try {
		if (value === null) localStorage.removeItem(key);
		else localStorage.setItem(key, value);
	} catch {
		// storage unavailable (private mode, quota) — recents are best-effort
	}
}

function isRoom(value: unknown): value is RecentRoom {
	if (typeof value !== "object" || value === null) return false;
	const r = value as Record<string, unknown>;
	return (
		typeof r.roomId === "string" &&
		typeof r.link === "string" &&
		typeof r.title === "string" &&
		(r.cwd === null || typeof r.cwd === "string") &&
		typeof r.readOnly === "boolean" &&
		typeof r.lastSeen === "number"
	);
}

/** Newest first. */
export function loadRooms(): RecentRoom[] {
	const raw = readJson(ROOMS_KEY);
	if (!Array.isArray(raw)) return [];
	return raw.filter(isRoom).sort((a, b) => b.lastSeen - a.lastSeen);
}

/** Room id of a link, or null when it does not parse. */
export function roomIdOf(link: string): string | null {
	const parsed = parseCollabLink(link);
	return "error" in parsed ? null : parsed.roomId;
}

/** Insert or refresh a room, which then moves to the top. */
export function rememberRoom(room: Omit<RecentRoom, "lastSeen">): RecentRoom[] {
	const next = [{ ...room, lastSeen: Date.now() }, ...loadRooms().filter(r => r.roomId !== room.roomId)].slice(
		0,
		MAX_ROOMS,
	);
	writeRaw(ROOMS_KEY, JSON.stringify(next));
	return next;
}

export function forgetRoom(roomId: string): RecentRoom[] {
	const next = loadRooms().filter(r => r.roomId !== roomId);
	writeRaw(ROOMS_KEY, JSON.stringify(next));
	if (roomIdOf(activeLink() ?? "") === roomId) setActiveLink(null);
	return next;
}

/**
 * The link of the session the client was showing when it last ran. It is cleared
 * on an explicit leave, so a relaunch after the OS killed the app resumes the
 * session and a relaunch after "leave" shows the connect screen.
 */
export function activeLink(): string | null {
	const raw = readJson(ACTIVE_KEY);
	return typeof raw === "string" ? raw : null;
}

export function setActiveLink(link: string | null): void {
	writeRaw(ACTIVE_KEY, link === null ? null : JSON.stringify(link));
}

/**
 * Pull a collab link out of free text: a pasted message, a share-sheet payload,
 * or a scanned QR code. Accepts any form `parseCollabLink` accepts, including
 * `https://web/#<link>` browser deep links. Returns the first candidate that parses.
 */
export function extractLink(text: string): string | null {
	const trimmed = text.trim();
	if (!trimmed) return null;
	if (!("error" in parseCollabLink(trimmed))) return trimmed;
	for (const token of trimmed.split(/\s+/)) {
		const candidate = token.replace(/^[<("'`]+|[>)"'`.,;]+$/g, "");
		if (candidate && !("error" in parseCollabLink(candidate))) return candidate;
	}
	return null;
}
