/**
 * Interactive terminals on a computer (docs/collab.md → Interactive terminal): the app opens a real shell in a session's
 * folder on the computer that runs the session, types into it and sees its screen, through the companion.
 *
 * The companion runs each shell on a pseudo-terminal (a login shell, in the session's folder) and keeps it alive while
 * a device is attached and for {@link TERMINAL_ORPHAN_MS} after the last one left, so a reload or a dropped connection
 * finds it again with its recent output. Everything below rides the same end-to-end encrypted room as every other
 * companion frame, and is served only to a paired device (a view-only link or a guest of a session never reaches the
 * companion). A companion advertises `canTerminal` on the `hosts` frame; sandboxed sessions are refused.
 *
 * Output is raw PTY bytes, base64 in the frame, so any byte sequence (and UTF-8 split between two frames) arrives
 * exactly as the shell wrote it. Each byte of a terminal's output has an offset (the count of bytes it wrote before),
 * which is how the app knows what an `attach` replay already contains.
 */

/** Most terminals open at once on one computer (a shell that exited and was not closed counts until its last device leaves). */
export const TERMINAL_MAX = 8;
/** A terminal with no device attached is killed after this long. */
export const TERMINAL_ORPHAN_MS = 10 * 60_000;
/** Largest `terminal-input` payload, in bytes before base64; a bigger paste is sent in several frames. */
export const TERMINAL_MAX_INPUT_BYTES = 16 * 1024;
/** Limits on the size a terminal can be asked to take. */
export const TERMINAL_MAX_COLS = 500;
export const TERMINAL_MAX_ROWS = 200;

/** One terminal as the computer keeps it. */
export interface TerminalInfo {
	/** Random, unguessable; names the terminal in every other frame. */
	id: string;
	/** The session it was opened for. */
	instanceId: string;
	/** Folder the shell started in. */
	cwd: string;
	/** Base name of the shell program (`zsh`). */
	shell: string;
	cols: number;
	rows: number;
	startedAt: number;
	/** Present once the shell has ended; the terminal stays (with its last output) until it is closed or no device is attached. */
	exit?: TerminalExit;
}

export interface TerminalExit {
	/** Exit status, or null when a signal ended the shell. */
	code: number | null;
	signal?: string;
}

export type TerminalRequest =
	/** A new shell in the session's folder, attached to this device; answered with `terminal-open` (needs `canTerminal`). */
	| { t: "terminal-open"; reqId: number; instanceId: string; cols: number; rows: number }
	/** The terminals still open for a session (any device's), for a page that was reloaded. */
	| { t: "terminal-list"; reqId: number; instanceId: string }
	/** Attach this device to a terminal and resize it; answered with its recent output as `replay` (a device attached already stays so). */
	| { t: "terminal-attach"; reqId: number; id: string; cols: number; rows: number }
	/** End the shell and forget the terminal. */
	| { t: "terminal-close"; reqId: number; id: string }
	/** Keystrokes (base64 of the bytes) for the shell; only from a device attached to it. Carries no `reqId`, never answered. */
	| { t: "terminal-input"; id: string; data: string }
	/** The shell's window changed size; only from a device attached to it. Carries no `reqId`, never answered. */
	| { t: "terminal-resize"; id: string; cols: number; rows: number }
	/** This device no longer shows the terminal: it keeps running for {@link TERMINAL_ORPHAN_MS} unless another device is attached. Carries no `reqId`. */
	| { t: "terminal-detach"; id: string };

/** Pushed to every device attached to a terminal, in order; carries no `reqId`. */
export interface TerminalOutputFrame {
	t: "terminal-output";
	id: string;
	/** Offset of the first byte of `data` in the terminal's output. A jump ahead of the last offset received means the computer skipped output it could not send fast enough. */
	from: number;
	/** Base64 of the bytes. */
	data: string;
}

/** Pushed when the shell ended; carries no `reqId`. Its last output has been sent before it. */
export interface TerminalExitFrame {
	t: "terminal-exit";
	id: string;
	exit: TerminalExit;
}

export type TerminalReply =
	| { t: "terminal-open"; reqId: number; terminal: TerminalInfo }
	| { t: "terminal-list"; reqId: number; terminals: TerminalInfo[] }
	/** `replay` (base64): the newest part of the output, cut at a line start; `end`: the offset after it, from which `terminal-output` continues. */
	| { t: "terminal-attach"; reqId: number; terminal: TerminalInfo; replay: string; end: number }
	| { t: "terminal-close"; reqId: number }
	| TerminalOutputFrame
	| TerminalExitFrame;

/** The pushes of a terminal: frames without a `reqId` that go to attached devices. */
export type TerminalPush = TerminalOutputFrame | TerminalExitFrame;
