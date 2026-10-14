/**
 * The contract between the desktop shell and the collab web app it shows. The preload script exposes
 * {@link OmpDesktopBridge} as `window.ompDesktop`; the web app (`packages/collab-web/src/lib/desktop.ts`) uses it only
 * when it is there, so the same build runs unchanged in a browser. The bridge is deliberately narrow: three calls, no
 * generic IPC, nothing that reads the disk or runs a process on the page's say-so.
 */

/** Bumped when a call changes in a way an older web app cannot follow. */
export const BRIDGE_VERSION = 1;

/** Largest file `saveFile` accepts. Bigger payloads should be downloaded by the companion instead of cloned across processes. */
export const MAX_SAVE_BYTES = 1024 * 1024 * 1024;

/** What a session is doing, as the web app derives it from the computer's host list. */
export type SessionActivity = "input" | "working" | "idle";

/** One session on a paired computer that is hosting collab. */
export interface ReportedSession {
	computerId: string;
	instanceId: string;
	/** What the session is called in the app (its name, else its folder). */
	title: string;
	/** The computer's name; null when the app does not know it yet. */
	computerName: string | null;
	activity: SessionActivity;
}

/** Everything the shell needs for the menu-bar icon and notifications. */
export interface SessionReport {
	sessions: ReportedSession[];
	/** Paired computers whose session list is current. */
	computersLive: number;
	/** The ids of those computers, so a session that appears on one that listed nothing before still counts as news. */
	liveComputerIds?: string[];
	/** Paired computers. */
	computersTotal: number;
}

export type SaveOutcome = "saved" | "cancelled";

/** A session the shell asks the app to open (menu-bar item, notification click). */
export interface OpenSessionTarget {
	computerId: string;
	instanceId: string;
}

export interface OmpDesktopBridge {
	readonly version: number;
	/** `process.platform` of the shell: `darwin`, `linux` or `win32`. */
	readonly platform: string;
	/** Ask for a place with the system's save dialog and write `data` there. Resolves `cancelled` when the dialog is dismissed. */
	saveFile(name: string, data: Uint8Array): Promise<SaveOutcome>;
	/** Tell the shell what the sessions are doing. Fire and forget; call it whenever the picture changes. */
	reportSessions(report: SessionReport): void;
	/** Be told when the shell wants a session opened. Returns the unsubscribe function. */
	onOpenSession(handler: (target: OpenSessionTarget) => void): () => void;
}

/** IPC channel names, shared by the preload script and the main process. */
export const CHANNELS = {
	saveFile: "omp-desktop:save-file",
	reportSessions: "omp-desktop:report-sessions",
	openSession: "omp-desktop:open-session",
} as const;
