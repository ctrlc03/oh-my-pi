/**
 * What the preview sheet shows for each session, kept in localStorage so reopening it (or the app) resumes
 * where it was: the page, the screen size, whether it captures the whole page, and whether it re-captures when
 * the agent changes files.
 */

import type { PreviewViewport } from "./companion";
import { readJson, writeJson } from "./storage";

const PREVIEW_KEY = "omp.collab.preview";
const MAX_SESSIONS = 30;

export interface PreviewPrefs {
	/** The page last captured; null before the first capture. */
	url: string | null;
	viewport: PreviewViewport;
	auto: boolean;
	/** Capture the whole page rather than the first screen. */
	full: boolean;
}

export const DEFAULT_PREVIEW_PREFS: PreviewPrefs = { url: null, viewport: "phone", auto: true, full: false };

const VIEWPORT_NAMES: Record<PreviewViewport, true> = { phone: true, tablet: true, desktop: true };

interface Entry extends PreviewPrefs {
	sessionId: string;
}

/** Newest first. */
function loadEntries(): Entry[] {
	const raw = readJson(PREVIEW_KEY);
	if (!Array.isArray(raw)) return [];
	return raw.filter(
		(v): v is Entry =>
			typeof v === "object" &&
			v !== null &&
			typeof (v as Entry).sessionId === "string" &&
			((v as Entry).url === null || typeof (v as Entry).url === "string") &&
			VIEWPORT_NAMES[(v as Entry).viewport] === true &&
			typeof (v as Entry).auto === "boolean" &&
			// Absent from entries saved before full-page capture.
			((v as Entry).full === undefined || typeof (v as Entry).full === "boolean"),
	);
}

export function loadPreviewPrefs(sessionId: string): PreviewPrefs {
	const { sessionId: _, ...prefs } = loadEntries().find(e => e.sessionId === sessionId) ?? { sessionId };
	return { ...DEFAULT_PREVIEW_PREFS, ...prefs };
}

/** Change some of a session's preferences; the 30 most recently changed sessions are kept. */
export function savePreviewPrefs(sessionId: string, patch: Partial<PreviewPrefs>): void {
	const entries = loadEntries();
	const current = entries.find(e => e.sessionId === sessionId) ?? { ...DEFAULT_PREVIEW_PREFS, sessionId };
	writeJson(
		PREVIEW_KEY,
		[{ ...current, ...patch }, ...entries.filter(e => e.sessionId !== sessionId)].slice(0, MAX_SESSIONS),
	);
}
