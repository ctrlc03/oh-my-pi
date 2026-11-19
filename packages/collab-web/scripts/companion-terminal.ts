/**
 * Interactive terminals of the app (`terminal-*` frames, @oh-my-pi/pi-wire/terminal): a login shell on a pseudo-terminal
 * in a session's folder, driven from a paired device.
 *
 * The PTY comes from Bun itself (`Bun.spawn(…, { terminal })`, Bun 1.3.5 and later, POSIX only): the shell is a child
 * of the companion with its own session and controlling terminal, written and resized through `Bun.Terminal`, and its
 * output arrives as byte chunks. tmux would add a second terminal emulator between the shell and the app (its redraws
 * instead of the shell's bytes, so no real scrollback in the app) and a server that outlives the companion, so it is
 * not used here; the companion already owns the lifetime rules below.
 *
 * Who may use it is decided by the caller (the companion serves these frames only to authenticated paired devices and
 * refuses sandboxed sessions before it calls {@link Terminals.open}); this module enforces what belongs to the
 * terminals themselves: input and resizes come only from a device that is attached to the terminal (and still
 * connected), the number of terminals and the size of a frame are capped, and output leaves at a bounded rate, and only
 * while the connection to the device is taking what was already sent.
 *
 * Lifetime: a terminal runs while a device is attached; with none attached it is killed after
 * {@link TERMINAL_ORPHAN_MS}. A device that comes back (a reload, a dropped connection) attaches again and receives the
 * newest {@link RING_BYTES} of output to draw first. Closing a terminal, a shell that ends, and the companion
 * stopping all end the process group.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	TERMINAL_MAX,
	TERMINAL_MAX_COLS,
	TERMINAL_MAX_INPUT_BYTES,
	TERMINAL_MAX_ROWS,
	TERMINAL_ORPHAN_MS,
	type TerminalExit,
	type TerminalInfo,
	type TerminalPush,
} from "@oh-my-pi/pi-wire/terminal";

/** Output kept per terminal for a device that attaches later. */
export const RING_BYTES = 256 * 1024;
/** Where a replay may start: it is moved to the next line start if one is this close, so it does not begin inside an escape sequence. */
const LINE_SCAN_BYTES = 4096;
/** Largest `terminal-output` payload, in bytes before base64. */
const FRAME_BYTES = 48 * 1024;
/** Output waits this long for more to batch with it. */
const FLUSH_MS = 10;
/** Sustained output rate toward the devices, per terminal; a shell that writes faster is skipped ahead. */
export const OUTPUT_BYTES_PER_SECOND = 1024 * 1024;
/** Output that may be sent at once after a quiet moment. */
const OUTPUT_BURST_BYTES = 256 * 1024;
/** Output waiting to be sent; beyond it the oldest is skipped (it is still in the ring for a later attach). */
export const PENDING_MAX_BYTES = 512 * 1024;
/** Output waits, instead of being sent, while a device's connection still holds this much unsent data. */
export const SOCKET_BUFFER_HIGH_BYTES = 256 * 1024;
/** How long output waits before the connection's backlog is looked at again. */
const BACKPRESSURE_RETRY_MS = 50;
/** Sustained output toward all devices together, counted per device it is sent to: what 8 busy terminals may use of the uplink. */
export const GLOBAL_OUTPUT_BYTES_PER_SECOND = 2 * 1024 * 1024;
/** What may go out at once after a quiet moment, all terminals together. */
const GLOBAL_OUTPUT_BURST_BYTES = 512 * 1024;
/** Reads smaller than this are merged into one block of the ring: output in many tiny reads would otherwise cost an object each. */
export const RING_BLOCK_BYTES = 4096;
/** The shell is given this long to leave on SIGHUP before SIGKILL. */
const KILL_GRACE_MS = 2_000;
/** After the shell ended, how long its last output may still arrive from the PTY. */
const EXIT_DRAIN_MS = 60;

// ── bytes ───────────────────────────────────────────────────────────────────

/** The newest output of a terminal, bounded, with the offset of every byte. */
export class ByteRing {
	readonly #cap: number;
	#chunks: Uint8Array[] = [];
	#held = 0;
	#end = 0;
	/** The block small reads are appended to; its filled part ({@link #blockLen}) is the ring's last chunk. */
	#block: Uint8Array | null = null;
	#blockLen = 0;

	constructor(cap: number) {
		this.#cap = cap;
	}

	/** Offset after the last byte written. */
	get end(): number {
		return this.#end;
	}

	push(bytes: Uint8Array): void {
		if (bytes.length === 0) return;
		if (bytes.length >= RING_BLOCK_BYTES) {
			this.#block = null;
			this.#chunks.push(bytes);
		} else {
			if (this.#block === null || this.#blockLen + bytes.length > RING_BLOCK_BYTES) {
				this.#block = new Uint8Array(RING_BLOCK_BYTES);
				this.#blockLen = 0;
				this.#chunks.push(this.#block.subarray(0, 0));
			}
			this.#block.set(bytes, this.#blockLen);
			this.#blockLen += bytes.length;
			this.#chunks[this.#chunks.length - 1] = this.#block.subarray(0, this.#blockLen);
		}
		this.#held += bytes.length;
		this.#end += bytes.length;
		// Whole chunks go once the rest still fills the ring; the block being filled is the last chunk, so it stays.
		while (this.#chunks.length > 1 && this.#held - this.#chunks[0]!.length >= this.#cap) {
			this.#held -= this.#chunks.shift()!.length;
		}
	}

	/**
	 * The newest bytes (at most the ring's size) and the offset of the first. When older output was dropped the replay
	 * starts after a line break close to its start, so it does not begin in the middle of an escape sequence or a
	 * multi-byte character; the bytes skipped that way are not part of it.
	 */
	replay(): { from: number; bytes: Uint8Array } {
		let bytes = new Uint8Array(this.#held);
		let at = 0;
		for (const chunk of this.#chunks) {
			bytes.set(chunk, at);
			at += chunk.length;
		}
		let from = this.#end - bytes.length;
		if (bytes.length > this.#cap) {
			bytes = bytes.subarray(bytes.length - this.#cap);
			from = this.#end - bytes.length;
		}
		if (from > 0) {
			const newline = bytes.subarray(0, LINE_SCAN_BYTES).indexOf(0x0a);
			if (newline >= 0) {
				bytes = bytes.subarray(newline + 1);
				from += newline + 1;
			}
		}
		return { from, bytes };
	}
}

/** A token bucket: `perSecond` bytes refill continuously up to `burst`. */
export class RateGate {
	readonly #perSecond: number;
	readonly #burst: number;
	#tokens: number;
	#at: number;

	constructor(perSecond: number, burst: number, now: number) {
		this.#perSecond = perSecond;
		this.#burst = burst;
		this.#tokens = burst;
		this.#at = now;
	}

	#refill(now: number): void {
		this.#tokens = Math.min(this.#burst, this.#tokens + ((now - this.#at) * this.#perSecond) / 1000);
		this.#at = now;
	}

	/** Up to `wanted` bytes may be sent now; the granted amount is spent. */
	take(now: number, wanted: number): number {
		this.#refill(now);
		const granted = Math.min(wanted, Math.floor(this.#tokens));
		this.#tokens -= granted;
		return granted;
	}

	/** How many bytes may be taken now, without taking them. */
	available(now: number): number {
		this.#refill(now);
		return Math.floor(this.#tokens);
	}

	/** Milliseconds until `need` bytes may be taken at once (0 when they may now). */
	waitMs(now: number, need: number): number {
		this.#refill(now);
		return this.#tokens >= need ? 0 : Math.ceil(((need - this.#tokens) * 1000) / this.#perSecond);
	}
}

/** `cols`×`rows` as the shell's window, or an error naming what is wrong. */
export function checkSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
	if (
		typeof cols !== "number" ||
		typeof rows !== "number" ||
		!Number.isInteger(cols) ||
		!Number.isInteger(rows) ||
		cols < 1 ||
		rows < 1 ||
		cols > TERMINAL_MAX_COLS ||
		rows > TERMINAL_MAX_ROWS
	)
		throw new Error("invalid terminal size");
	return { cols, rows };
}

/**
 * The login shell to run: the companion's `$SHELL` when it is an absolute program that can run, else the account's
 * login shell (a service manager starts the companion without `$SHELL`), else the platform's default.
 */
export function pickShell(
	env: Readonly<Record<string, string | undefined>>,
	accountShell: string | undefined,
	platform: NodeJS.Platform,
	canRun: (program: string) => boolean,
): string {
	const defaults = platform === "darwin" ? ["/bin/zsh", "/bin/bash", "/bin/sh"] : ["/bin/bash", "/bin/sh"];
	for (const candidate of [env.SHELL, accountShell, ...defaults]) {
		if (candidate !== undefined && path.isAbsolute(candidate) && canRun(candidate)) return candidate;
	}
	throw new Error("No shell found on this computer");
}

/**
 * What marks a process as running inside someone else's terminal or multiplexer, or under the service manager that
 * started the companion: the shell must not believe it. `XPC_SERVICE_NAME` is how launchd names the job and
 * `INVOCATION_ID` how systemd names the unit (the two things `managedBy` reads, so a companion started by hand from
 * the shell would think it was the service and skip printing its pairing invite); `OMP_BIN` is what the service file
 * hands the companion to find omp, not a setting of the shell. `PI_CONFIG_DIR` stays: it is the user's own choice of
 * omp's config folder, and an omp run in the shell must agree with the companion about it.
 */
const FOREIGN_TERMINAL_VARS = new Set([
	"TMUX",
	"TMUX_PANE",
	"STY",
	"ZELLIJ",
	"ZELLIJ_SESSION_NAME",
	"ZELLIJ_PANE_ID",
	"TERM_SESSION_ID",
	"ITERM_SESSION_ID",
	"ITERM_PROFILE",
	"LC_TERMINAL",
	"LC_TERMINAL_VERSION",
	"TERM_PROGRAM_VERSION",
	"TERMINAL_EMULATOR",
	"VTE_VERSION",
	"WT_SESSION",
	"WT_PROFILE_ID",
	"WINDOWID",
	"COLORFGBG",
	"COLUMNS",
	"LINES",
	"XPC_SERVICE_NAME",
	"XPC_FLAGS",
	"INVOCATION_ID",
	"JOURNAL_STREAM",
	"NOTIFY_SOCKET",
	"MANAGERPID",
	"SYSTEMD_EXEC_PID",
	"LISTEN_PID",
	"LISTEN_FDS",
	"LISTEN_FDNAMES",
	"OMP_BIN",
]);
/** Variables of one terminal emulator's family: each sets a handful (`KITTY_WINDOW_ID`, `WEZTERM_PANE`, `VSCODE_INJECTION`…). */
const FOREIGN_TERMINAL_PREFIXES = ["KITTY_", "WEZTERM_", "VSCODE_", "ALACRITTY_", "GHOSTTY_", "KONSOLE_", "ITERM_"];

/** The shell's environment: the companion's, described as the xterm.js terminal it really is. */
export function terminalEnv(base: Readonly<Record<string, string | undefined>>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(base)) {
		if (value === undefined || FOREIGN_TERMINAL_VARS.has(key)) continue;
		if (FOREIGN_TERMINAL_PREFIXES.some(prefix => key.startsWith(prefix))) continue;
		env[key] = value;
	}
	env.TERM = "xterm-256color";
	env.COLORTERM = "truecolor";
	env.TERM_PROGRAM = "omp";
	// A service manager may start the companion without a locale; the shell and its programs need UTF-8.
	if (env.LANG === undefined && env.LC_ALL === undefined) env.LANG = "en_US.UTF-8";
	return env;
}

/** Whether this computer can run terminals: a POSIX system whose Bun has the PTY option of `Bun.spawn`. */
export function terminalsSupported(): boolean {
	return process.platform !== "win32" && typeof Bun.Terminal === "function";
}

// ── terminals ───────────────────────────────────────────────────────────────

function startShell(
	program: string,
	cwd: string,
	cols: number,
	rows: number,
	onData: (bytes: Uint8Array) => void,
): Bun.Subprocess {
	return Bun.spawn([program, "-l"], {
		cwd,
		env: terminalEnv(process.env),
		terminal: {
			cols,
			rows,
			name: "xterm-256color",
			// Copied: the callback's buffer may be reused once it returns.
			data: (_terminal, data) => onData(data.slice()),
		},
	});
}

interface Terminal {
	info: TerminalInfo;
	proc: Bun.Subprocess;
	ring: ByteRing;
	/** Devices (peer ids) that receive its output and may type into it. */
	peers: Set<number>;
	gate: RateGate;
	/** Output not yet sent, and the offset of its first byte. */
	pending: Uint8Array[];
	pendingBytes: number;
	pendingFrom: number;
	flushTimer: Timer | undefined;
	orphanTimer: Timer | undefined;
	/** Closed on purpose: its exit is not reported. */
	closing: boolean;
}

export interface TerminalsOptions {
	/** Deliver a push to one device. */
	send(peer: number, frame: TerminalPush): void;
	/** Whether `peer` is an authenticated device that is still connected; output is never sent to any other. */
	isLive(peer: number): boolean;
	/** Bytes the connection to `peer` has been given and not yet sent on. */
	buffered(peer: number): number;
	log(message: string): void;
	now?(): number;
}

/** The session a terminal is opened for, already checked by the caller (known, not sandboxed). */
export interface TerminalSession {
	instanceId: string;
	cwd: string;
}

export interface Terminals {
	/** Start a shell in the session's folder and attach `peer` to it. */
	open(peer: number, session: TerminalSession, cols: unknown, rows: unknown): Promise<TerminalInfo>;
	/** The open terminals of a session. */
	list(instanceId: string): TerminalInfo[];
	/** Attach `peer` and resize the terminal to it; the replay is the newest output up to `end`, base64. */
	attach(peer: number, id: string, cols: unknown, rows: unknown): { terminal: TerminalInfo; replay: string; end: number };
	detach(peer: number, id: string): void;
	/** Bytes (base64) for the shell; ignored from a device that is not attached. */
	input(peer: number, id: string, data: unknown): void;
	resize(peer: number, id: string, cols: unknown, rows: unknown): void;
	/** End the terminal's shell and forget it. */
	close(id: string): void;
	/** A device left (its connection ended): it is detached everywhere. */
	peerGone(peer: number): void;
	count(): number;
	/** The companion is stopping. */
	stopAll(): void;
}

export function createTerminals(options: TerminalsOptions): Terminals {
	const now = options.now ?? Date.now;
	const terminals = new Map<string, Terminal>();
	/** What all terminals together may send; each terminal has its own limit besides. */
	const budget = new RateGate(GLOBAL_OUTPUT_BYTES_PER_SECOND, GLOBAL_OUTPUT_BURST_BYTES, now());

	const find = (id: unknown): Terminal => {
		const terminal = typeof id === "string" ? terminals.get(id) : undefined;
		if (!terminal) throw new Error("no such terminal");
		return terminal;
	};
	const sendAll = (terminal: Terminal, frame: TerminalPush): void => {
		for (const peer of [...terminal.peers]) {
			// A device that left without the terminal hearing of it (or one that never authenticated) gets nothing.
			if (options.isLive(peer)) options.send(peer, frame);
			else detach(peer, terminal.info.id);
		}
	};

	/**
	 * Send what is waiting, within the rate the terminal and all terminals together may use, and while no device's
	 * connection holds a backlog; the rest follows when that allows. Output that waits too long is skipped by the
	 * pending limit in `onData` (it is still in the ring for a later attach).
	 */
	const flush = (terminal: Terminal): void => {
		terminal.flushTimer = undefined;
		while (terminal.pendingBytes > 0 && terminal.peers.size > 0) {
			if ([...terminal.peers].some(peer => options.buffered(peer) >= SOCKET_BUFFER_HIGH_BYTES)) {
				schedule(terminal, BACKPRESSURE_RETRY_MS);
				return;
			}
			const at = now();
			const devices = terminal.peers.size;
			const granted = Math.min(
				FRAME_BYTES,
				terminal.pendingBytes,
				terminal.gate.available(at),
				Math.floor(budget.available(at) / devices),
			);
			if (granted === 0) break;
			terminal.gate.take(at, granted);
			budget.take(at, granted * devices);
			const chunk = takeBytes(terminal, granted);
			sendAll(terminal, {
				t: "terminal-output",
				id: terminal.info.id,
				from: terminal.pendingFrom - chunk.length,
				data: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length).toString("base64"),
			});
		}
		if (terminal.pendingBytes > 0 && terminal.peers.size > 0) {
			const need = Math.min(FRAME_BYTES, terminal.pendingBytes);
			const wait = Math.max(
				terminal.gate.waitMs(now(), need),
				budget.waitMs(now(), Math.min(need * terminal.peers.size, GLOBAL_OUTPUT_BURST_BYTES)),
			);
			schedule(terminal, Math.max(FLUSH_MS, wait));
		}
	};
	const schedule = (terminal: Terminal, ms: number): void => {
		terminal.flushTimer ??= setTimeout(() => flush(terminal), ms);
	};

	const onData = (terminal: Terminal, bytes: Uint8Array): void => {
		if (bytes.length === 0) return;
		terminal.ring.push(bytes);
		if (terminal.peers.size === 0) return;
		if (terminal.pendingBytes === 0) terminal.pendingFrom = terminal.ring.end - bytes.length;
		terminal.pending.push(bytes);
		terminal.pendingBytes += bytes.length;
		// A shell faster than the devices: the oldest waiting output is skipped, the devices see the jump in `from`.
		while (terminal.pendingBytes > PENDING_MAX_BYTES && terminal.pending.length > 1) {
			const dropped = terminal.pending.shift()!;
			terminal.pendingBytes -= dropped.length;
			terminal.pendingFrom += dropped.length;
		}
		schedule(terminal, FLUSH_MS);
	};

	const kill = (terminal: Terminal): void => {
		terminal.closing = true;
		clearTimeout(terminal.flushTimer);
		clearTimeout(terminal.orphanTimer);
		const { proc } = terminal;
		const hangUp = (signal: NodeJS.Signals): void => {
			// A shell that ended is not signalled: its process id may belong to something else by now.
			if (proc.exitCode !== null || proc.signalCode !== null) return;
			// The shell leads its own session and process group. Jobs it starts with job control get groups of their
			// own, so these signals reach the shell and what it runs without job control; the rest depends on closing
			// the PTY above, which makes the kernel hang up the foreground job, and on the shell passing SIGHUP to its
			// jobs as it exits. A job that ignores SIGHUP may outlive its terminal.
			for (const target of [-proc.pid, proc.pid]) {
				try {
					process.kill(target, signal);
				} catch {
					// already gone
				}
			}
		};
		try {
			proc.terminal?.close();
		} catch {
			// already closed
		}
		hangUp("SIGHUP");
		const force = setTimeout(() => hangUp("SIGKILL"), KILL_GRACE_MS);
		void proc.exited.then(() => clearTimeout(force));
	};

	const forget = (terminal: Terminal): void => {
		terminals.delete(terminal.info.id);
		kill(terminal);
	};

	const startOrphanTimer = (terminal: Terminal): void => {
		clearTimeout(terminal.orphanTimer);
		terminal.orphanTimer = setTimeout(() => {
			options.log(`terminal ${terminal.info.id.slice(0, 8)} had no device for ${TERMINAL_ORPHAN_MS / 60_000} minutes; ended`);
			forget(terminal);
		}, TERMINAL_ORPHAN_MS);
	};

	const onExit = (terminal: Terminal, exit: TerminalExit): void => {
		if (terminal.closing) return;
		// The last of the shell's output may still be on its way from the PTY.
		setTimeout(() => {
			if (terminal.closing) return;
			terminal.info = { ...terminal.info, exit };
			try {
				terminal.proc.terminal?.close();
			} catch {
				// already closed
			}
			clearTimeout(terminal.flushTimer);
			// What the shell last wrote goes out at once, ahead of the exit.
			terminal.flushTimer = undefined;
			while (terminal.pendingBytes > 0 && terminal.peers.size > 0) {
				const chunk = takeBytes(terminal, Math.min(FRAME_BYTES, terminal.pendingBytes));
				sendAll(terminal, {
					t: "terminal-output",
					id: terminal.info.id,
					from: terminal.pendingFrom - chunk.length,
					data: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length).toString("base64"),
				});
			}
			sendAll(terminal, { t: "terminal-exit", id: terminal.info.id, exit });
			options.log(`terminal ${terminal.info.id.slice(0, 8)} ended (${exit.signal ?? `exit ${exit.code}`})`);
			// Nobody to show it to: nothing to keep.
			if (terminal.peers.size === 0) forget(terminal);
		}, EXIT_DRAIN_MS);
	};

	const detach = (peer: number, id: string): void => {
		const terminal = terminals.get(id);
		if (!terminal?.peers.delete(peer) || terminal.peers.size > 0) return;
		terminal.pending.length = 0;
		terminal.pendingBytes = 0;
		clearTimeout(terminal.flushTimer);
		terminal.flushTimer = undefined;
		if (terminal.info.exit !== undefined) forget(terminal);
		else startOrphanTimer(terminal);
	};

	return {
		async open(peer, session, colsIn, rowsIn) {
			const { cols, rows } = checkSize(colsIn, rowsIn);
			if (!terminalsSupported()) throw new Error("Terminals are not available on this computer.");
			const folder = await fsp.stat(session.cwd).then(
				stat => stat.isDirectory(),
				() => false,
			);
			if (!folder) throw new Error("The session's folder is not on this computer any more.");
			// Checked after the folder was, with nothing awaited from here to the new terminal being counted.
			if (terminals.size >= TERMINAL_MAX)
				throw new Error(`At most ${TERMINAL_MAX} terminals can be open at once on this computer.`);
			// The device may have left while the session was listed and the folder checked; a terminal it cannot
			// reach would run until the companion stops, since only a device detaching starts the orphan timer.
			if (!options.isLive(peer)) throw new Error("The device that asked for this terminal is no longer connected.");
			const program = pickShell(process.env, os.userInfo().shell ?? undefined, process.platform, candidate => {
				try {
					fs.accessSync(candidate, fs.constants.X_OK);
					return true;
				} catch {
					return false;
				}
			});
			let terminal: Terminal | undefined;
			const proc = startShell(program, session.cwd, cols, rows, bytes => {
				if (terminal) onData(terminal, bytes);
			});
			terminal = {
				info: {
					id: randomUUID(),
					instanceId: session.instanceId,
					cwd: session.cwd,
					shell: path.basename(program),
					cols,
					rows,
					startedAt: now(),
				},
				proc,
				ring: new ByteRing(RING_BYTES),
				peers: new Set([peer]),
				gate: new RateGate(OUTPUT_BYTES_PER_SECOND, OUTPUT_BURST_BYTES, now()),
				pending: [],
				pendingBytes: 0,
				pendingFrom: 0,
				flushTimer: undefined,
				orphanTimer: undefined,
				closing: false,
			};
			const opened = terminal;
			terminals.set(opened.info.id, opened);
			void proc.exited.then(code => onExit(opened, { code: proc.signalCode === null ? code : null, signal: proc.signalCode ?? undefined }));
			options.log(`terminal ${opened.info.id.slice(0, 8)} opened: ${opened.info.shell} in ${session.cwd} for ${session.instanceId}`);
			return opened.info;
		},

		list: instanceId =>
			[...terminals.values()].filter(terminal => terminal.info.instanceId === instanceId).map(terminal => terminal.info),

		attach(peer, id, colsIn, rowsIn) {
			const terminal = find(id);
			const { cols, rows } = checkSize(colsIn, rowsIn);
			terminal.peers.add(peer);
			clearTimeout(terminal.orphanTimer);
			if (terminal.info.exit === undefined) {
				terminal.proc.terminal?.resize(cols, rows);
				terminal.info = { ...terminal.info, cols, rows };
			}
			const { from, bytes } = terminal.ring.replay();
			return {
				terminal: terminal.info,
				replay: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString("base64"),
				end: from + bytes.length,
			};
		},

		detach,

		input(peer, id, data) {
			const terminal = typeof id === "string" ? terminals.get(id) : undefined;
			if (!terminal?.peers.has(peer) || terminal.info.exit !== undefined) return;
			// 4 characters of base64 carry 3 bytes: refuse before decoding what could not be an allowed payload.
			if (typeof data !== "string" || data.length > Math.ceil((TERMINAL_MAX_INPUT_BYTES * 4) / 3) + 4) return;
			terminal.proc.terminal?.write(Buffer.from(data, "base64"));
		},

		resize(peer, id, colsIn, rowsIn) {
			const terminal = typeof id === "string" ? terminals.get(id) : undefined;
			if (!terminal?.peers.has(peer) || terminal.info.exit !== undefined) return;
			const { cols, rows } = checkSize(colsIn, rowsIn);
			terminal.proc.terminal?.resize(cols, rows);
			terminal.info = { ...terminal.info, cols, rows };
		},

		close(id) {
			const terminal = find(id);
			options.log(`terminal ${terminal.info.id.slice(0, 8)} closed`);
			forget(terminal);
		},

		peerGone(peer) {
			for (const terminal of [...terminals.values()]) {
				if (terminal.peers.has(peer)) detach(peer, terminal.info.id);
			}
		},

		count: () => terminals.size,

		stopAll() {
			for (const terminal of [...terminals.values()]) forget(terminal);
		},
	};
}

/** The oldest `count` bytes of the terminal's waiting output, taken out of it. */
function takeBytes(terminal: Terminal, count: number): Uint8Array {
	const out = new Uint8Array(count);
	let filled = 0;
	while (filled < count) {
		const head = terminal.pending[0]!;
		const take = Math.min(head.length, count - filled);
		out.set(head.subarray(0, take), filled);
		filled += take;
		if (take === head.length) terminal.pending.shift();
		else terminal.pending[0] = head.subarray(take);
	}
	terminal.pendingBytes -= count;
	terminal.pendingFrom += count;
	return out;
}
