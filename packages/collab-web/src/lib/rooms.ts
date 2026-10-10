/**
 * Recent collab rooms, persisted in localStorage so an installed (home-screen)
 * client can rejoin without a link in the URL. A home-screen launch opens
 * `start_url` with no fragment, so this is the only way back into a session.
 *
 * Entries hold the full join link, room key and write token included. They stay on
 * this origin only and become useless once the host's room closes. Callers drop
 * a room when the relay reports it gone.
 */

import type { ImageContent } from "@oh-my-pi/pi-wire";
import { parseCollabLink } from "./link";
import { replicaStore } from "./replica-cache";
import { readJson, writeJson } from "./storage";

const ROOMS_KEY = "omp.collab.rooms";
const ACTIVE_KEY = "omp.collab.active";
const DRAFT_PREFIX = "omp.collab.draft.";
const MAX_ROOMS = 12;
const QUEUE_PREFIX = "omp.collab.queue.";
const SEEN_KEY = "omp.collab.seen";
const MAX_SEEN_ROOMS = 50;

export interface RecentRoom {
	roomId: string;
	link: string;
	title: string;
	cwd: string | null;
	readOnly: boolean;
	/** omp process the paired computer lists for this room; absent from rooms never seen through a companion. */
	instanceId?: string;
	/** epoch ms of the last successful join. */
	lastSeen: number;
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
		(r.instanceId === undefined || typeof r.instanceId === "string") &&
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
	writeJson(ROOMS_KEY, next);
	return next;
}

export function forgetRoom(roomId: string): RecentRoom[] {
	const next = loadRooms().filter(r => r.roomId !== roomId);
	writeJson(ROOMS_KEY, next);
	writeJson(DRAFT_PREFIX + roomId, null);
	writeJson(QUEUE_PREFIX + roomId, null);
	writeJson(
		SEEN_KEY,
		loadSeenMap().filter(seen => seen.roomId !== roomId),
	);
	if (roomIdOf(activeLink() ?? "") === roomId) setActiveLink(null);
	replicaStore()
		?.forget(roomId)
		.catch(err => console.warn("collab: forgetting the saved transcript failed", err));
	return next;
}

/**
 * The host replaced room `from` with `to` for the same omp process (session switch,
 * relaunch after a relay drop, access upgrade): carry the unsent draft, queued
 * prompts and saved transcript over, then forget `from`. Call before the client for
 * `to` is created, which loads its queue on construction and its transcript on connect.
 */
export function moveRoom(from: string, to: string): RecentRoom[] {
	const draft = loadDraft(from);
	if (draft && !loadDraft(to)) saveDraft(to, draft);
	const queue = loadPromptQueue(from);
	if (queue.length > 0) savePromptQueue(to, [...loadPromptQueue(to), ...queue]);
	replicaStore()
		?.move(from, to)
		.catch(err => console.warn("collab: moving the saved transcript failed", err));
	return forgetRoom(from);
}

/**
 * Unsent composer text for a room. Saved on every keystroke so it survives the
 * OS killing a backgrounded home-screen app, cleared on send and on forget.
 */
export function loadDraft(roomId: string): string {
	const raw = readJson(DRAFT_PREFIX + roomId);
	return typeof raw === "string" ? raw : "";
}

export function saveDraft(roomId: string, text: string): void {
	writeJson(DRAFT_PREFIX + roomId, text ? text : null);
}

/** A prompt typed while the connection was down, waiting to be handed to the socket once live. */
export interface QueuedPrompt {
	id: string;
	text: string;
	images?: ImageContent[];
}

function isQueuedPrompt(value: unknown): value is QueuedPrompt {
	if (typeof value !== "object" || value === null) return false;
	const q = value as Record<string, unknown>;
	return typeof q.id === "string" && typeof q.text === "string" && (q.images === undefined || Array.isArray(q.images));
}

/** Prompts queued offline for a room; persisted so an app kill keeps them. */
export function loadPromptQueue(roomId: string): QueuedPrompt[] {
	const raw = readJson(QUEUE_PREFIX + roomId);
	return Array.isArray(raw) ? raw.filter(isQueuedPrompt) : [];
}

export function savePromptQueue(roomId: string, queue: readonly QueuedPrompt[]): void {
	writeJson(QUEUE_PREFIX + roomId, queue.length > 0 ? queue : null);
}

/**
 * Queue a prompt for a room the app has not joined yet; the client created for that room
 * loads the queue and sends it, in order, once the session is live.
 */
export function enqueuePrompt(roomId: string, text: string): void {
	savePromptQueue(roomId, [...loadPromptQueue(roomId), { id: crypto.randomUUID(), text }]);
}

interface SeenEntry {
	roomId: string;
	entryId: string;
}

/** Newest first. */
function loadSeenMap(): SeenEntry[] {
	const raw = readJson(SEEN_KEY);
	if (!Array.isArray(raw)) return [];
	return raw.filter(
		(v): v is SeenEntry =>
			typeof v === "object" &&
			v !== null &&
			typeof (v as SeenEntry).roomId === "string" &&
			typeof (v as SeenEntry).entryId === "string",
	);
}

/** Id of the last transcript entry the user saw in a room, or null when unknown. */
export function loadSeen(roomId: string): string | null {
	return loadSeenMap().find(seen => seen.roomId === roomId)?.entryId ?? null;
}

/** Remember the last entry seen in a room; the 50 most recently updated rooms are kept. */
export function saveSeen(roomId: string, entryId: string): void {
	writeJson(
		SEEN_KEY,
		[{ roomId, entryId }, ...loadSeenMap().filter(seen => seen.roomId !== roomId)].slice(0, MAX_SEEN_ROOMS),
	);
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
	writeJson(ACTIVE_KEY, link);
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
