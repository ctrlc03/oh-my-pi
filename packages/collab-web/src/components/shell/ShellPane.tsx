import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { type ITheme, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { TerminalExit, TerminalOutputFrame, TerminalPush } from "@oh-my-pi/pi-wire/terminal";
import { X } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { CompanionClient } from "../../lib/companion";
import { effectiveKeys, IS_MAC, matchCombo, type ShortcutId } from "../../lib/shortcuts";
import {
	applyCtrl,
	base64ToBytes,
	decideChunk,
	inputPayloads,
	SKIPPED_NOTICE,
} from "../../lib/terminal-stream";
import { watchTheme } from "../ide/backend/monaco-theme";

/** The shortcuts that belong to the terminal's sheet: the pane hands them up instead of sending the keys to the shell. */
export const SHELL_SHORTCUTS = [
	"shellSplitRight",
	"shellSplitDown",
	"shellClosePane",
	"shellPrevPane",
	"shellNextPane",
] as const satisfies readonly ShortcutId[];
export type ShellShortcut = (typeof SHELL_SHORTCUTS)[number];

/** What the sheet can do to a terminal it shows. */
export interface ShellPaneHandle {
	/** Type `text` as if on the keyboard. */
	send(text: string): void;
	/** An arrow key (`A` up, `B` down, `C` right, `D` left), in the form the running program asked for. */
	cursorKey(letter: "A" | "B" | "C" | "D"): void;
	/** The terminal's size now, for the neighbour a split opens. */
	size(): { cols: number; rows: number };
	focus(): void;
}

export interface ShellPaneProps {
	client: CompanionClient;
	/** The terminal's id on the computer. */
	id: string;
	/** Where the sheet puts it: shares of the body, as percentages. */
	style: CSSProperties;
	/** The terminal that gets the keys. */
	focused: boolean;
	/** The computer is connected; false while the connection is being re-made (the pane attaches again when it returns). */
	live: boolean;
	onFocus(id: string): void;
	/** Close the terminal (its shell ends). */
	onClose(id: string): void;
	onShortcut(shortcut: ShellShortcut): void;
	/** The sheet's handle on the terminal, set while it shows and cleared when it goes. */
	register(id: string, handle: ShellPaneHandle | null): void;
	/** Whether the key row's Ctrl is armed; reading it disarms it. */
	takeCtrl(): boolean;
	/** The sheet shows several terminals: each gets a close button of its own. */
	showClose: boolean;
}

const FALLBACK_FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
/**
 * The bundled Nerd Fonts symbols (`public/terminal-assets/`). Prompts such as Powerlevel10k, Starship and oh-my-posh
 * draw their icons from the Private Use Area, which no system font covers, so without it they show as boxes. It comes
 * last in the terminal's font list: the device's own fonts keep every character they have.
 */
const SYMBOLS_FAMILY = "omp-terminal-symbols";
const SYMBOLS_FILE = "terminal-assets/SymbolsNerdFontMono-Regular.woff2";
/** The code points the font carries: the Private Use Areas plus the few symbols Nerd Fonts adds outside them. */
const SYMBOLS_RANGE = "U+E000-F8FF, U+F0000-FFFFD, U+23FB-23FE, U+2630, U+2665, U+26A1, U+276C-2771, U+2B58";
const SCROLLBACK_LINES = 5000;
/** Output frames kept while an attach is on its way; beyond it the oldest go (the screen then shows a skip notice). */
const WAITING_MAX_FRAMES = 64;

/** What `css` is as the browser computes it (a colour expression, `var()`s and `color-mix()` included). */
function computedColor(probe: HTMLElement, css: string): string {
	probe.style.color = "";
	probe.style.color = css;
	return getComputedStyle(probe).color;
}

let symbolsFont: Promise<void> | undefined;

/**
 * Load the symbols font once per page. It is fetched when a terminal first opens rather than when a glyph first
 * needs it: the WebGL renderer draws through a canvas, which never starts a font download by itself. A failed fetch
 * (the dev server has no `terminal-assets/`) leaves the boxes and is not retried.
 */
function loadSymbolsFont(): Promise<void> {
	symbolsFont ??= (async () => {
		const url = new URL(SYMBOLS_FILE, document.baseURI).href;
		const face = new FontFace(SYMBOLS_FAMILY, `url("${url}") format("woff2")`, { unicodeRange: SYMBOLS_RANGE });
		document.fonts.add(face);
		await face.load();
	})().catch(() => {});
	return symbolsFont;
}

function terminalFont(appFont: string): string {
	return `${appFont}, "${SYMBOLS_FAMILY}"`;
}

/** The terminal's colours from the app's tokens (`--term-0…15` are the same sixteen the read-only terminal view draws). */
function readTheme(host: HTMLElement): { theme: ITheme; fontFamily: string } {
	const probe = document.createElement("span");
	probe.style.display = "none";
	probe.style.fontFamily = "var(--font-mono)";
	host.append(probe);
	const color = (css: string): string => computedColor(probe, css);
	const ansi = Array.from({ length: 16 }, (_, i) => color(`var(--term-${i})`));
	const theme: ITheme = {
		background: color("var(--bg-inset)"),
		foreground: color("var(--fg)"),
		cursor: color("var(--accent)"),
		cursorAccent: color("var(--bg-inset)"),
		selectionBackground: color("color-mix(in srgb, var(--accent) 35%, transparent)"),
		black: ansi[0],
		red: ansi[1],
		green: ansi[2],
		yellow: ansi[3],
		blue: ansi[4],
		magenta: ansi[5],
		cyan: ansi[6],
		white: ansi[7],
		brightBlack: ansi[8],
		brightRed: ansi[9],
		brightGreen: ansi[10],
		brightYellow: ansi[11],
		brightBlue: ansi[12],
		brightMagenta: ansi[13],
		brightCyan: ansi[14],
		brightWhite: ansi[15],
	};
	const fontFamily = getComputedStyle(probe).fontFamily || FALLBACK_FONT;
	probe.remove();
	return { theme, fontFamily };
}

/**
 * One interactive terminal: an xterm.js screen wired to a shell on the computer. It attaches when it shows (and again
 * when the connection comes back), draws the replay of recent output and then what the computer pushes, and sends
 * keystrokes, pastes and its size back. Closing the sheet only detaches: the shell keeps running for a while.
 */
export function ShellPane(props: ShellPaneProps): ReactNode {
	const { client, id, style, focused, live } = props;
	const host = useRef<HTMLDivElement>(null);
	const xterm = useRef<Terminal | null>(null);
	/** Attach (again): the effect that makes the terminal sets it, the one that follows `live` calls it. */
	const attach = useRef<(() => Promise<void>) | null>(null);
	const [exit, setExit] = useState<TerminalExit | null>(null);
	const [error, setError] = useState<string | null>(null);
	// The terminal's own handlers outlive a render: they read what the parent passed last.
	const latest = useRef(props);
	latest.current = props;

	useEffect(() => {
		const element = host.current;
		if (element === null) return;
		const look = readTheme(element);
		const term = new Terminal({
			fontFamily: terminalFont(look.fontFamily),
			fontSize: 13,
			theme: look.theme,
			cursorBlink: true,
			// Glyphs from a fallback font that are wider than a cell are narrowed to it instead of covering the next one.
			rescaleOverlappingGlyphs: true,
			scrollback: SCROLLBACK_LINES,
			// ⌥ is Meta for the shell (Alt+B, Alt+F) rather than a key for typing accents.
			macOptionIsMeta: true,
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(element);
		xterm.current = term;
		// WebGL draws powerline separators and box characters to fill each cell exactly, which a font only manages at
		// the size it was made for. Without WebGL2, or once the context is lost (a browser caps how many a page holds),
		// the terminal keeps the DOM renderer.
		let webgl: WebglAddon | undefined = new WebglAddon();
		webgl.onContextLoss(() => {
			webgl?.dispose();
			webgl = undefined;
		});
		try {
			term.loadAddon(webgl);
		} catch {
			webgl.dispose();
			webgl = undefined;
		}
		let disposed = false;
		void loadSymbolsFont().then(() => {
			if (disposed) return;
			// Glyphs drawn before the font arrived are cached as boxes.
			term.clearTextureAtlas();
			term.refresh(0, term.rows - 1);
		});

		/** The offset after the last output byte drawn; chunks that end before it are ones the replay held. */
		let received = 0;
		/** False until the attach answered: output that comes first waits, so it is drawn after the replay it may overlap. */
		let ready = false;
		let exited = false;
		/** True while the replay is being parsed: xterm.js answers the queries in it again (see `onData`). */
		let replaying = false;
		const waiting: TerminalPush[] = [];
		const draw = (frame: TerminalOutputFrame): void => {
			const decision = decideChunk(received, frame.from, base64ToBytes(frame.data));
			received = decision.received;
			if (decision.skipped) term.write(SKIPPED_NOTICE);
			if (decision.draw !== null) term.write(decision.draw);
		};
		const handle = (frame: TerminalPush): void => {
			if (frame.t === "terminal-exit") {
				exited = true;
				setExit(frame.exit);
			} else draw(frame);
		};
		const stopWatching = client.watchTerminal(id, frame => {
			if (ready) handle(frame);
			else {
				waiting.push(frame);
				if (waiting.length > WAITING_MAX_FRAMES) waiting.shift();
			}
		});

		const send = (text: string, binary = false): void => {
			for (const payload of inputPayloads(text, binary)) client.terminalInput(id, payload);
		};
		term.onData(data => {
			// xterm.js answers terminal queries (device attributes, cursor position…) through this event, as typed
			// input. Those in the replay were answered when the program sent them, so answering again would type into
			// whatever runs now. With several devices attached each one would answer a live query too, so only a
			// device whose page has the focus sends anything: that is the one a person types on, and others stay quiet.
			if (replaying || !document.hasFocus()) return;
			if (exited) {
				// The shell is gone: Enter closes the pane, as the notice says.
				if (data.includes("\r")) latest.current.onClose(id);
				return;
			}
			send(latest.current.takeCtrl() ? applyCtrl(data) : data);
		});
		term.onBinary(data => {
			if (!replaying && document.hasFocus()) send(data, true);
		});
		term.onResize(({ cols, rows }) => client.terminalResize(id, cols, rows));
		term.attachCustomKeyEventHandler(event => {
			if (event.type !== "keydown") return true;
			// The shell's own Esc (vim, readline) must not also close a floating sheet.
			if (event.key === "Escape") event.preventDefault();
			for (const shortcut of SHELL_SHORTCUTS) {
				if (!matchCombo(event, effectiveKeys(shortcut), IS_MAC)) continue;
				event.preventDefault();
				latest.current.onShortcut(shortcut);
				return false;
			}
			// Ctrl+C copies a selection where Ctrl+Shift+C is the browser's inspector; with nothing selected it is the shell's interrupt.
			return !(!IS_MAC && event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === "c" && term.hasSelection());
		});

		attach.current = async () => {
			ready = false;
			try {
				fit.fit();
				const attached = await client.terminalAttach(id, term.cols, term.rows);
				term.reset();
				const replay = base64ToBytes(attached.replay);
				if (replay.length > 0) {
					replaying = true;
					term.write(replay, () => {
						replaying = false;
					});
				}
				received = attached.end;
				exited = attached.terminal.exit !== undefined;
				setExit(attached.terminal.exit ?? null);
				setError(null);
				ready = true;
				for (const frame of waiting.splice(0)) handle(frame);
			} catch (err) {
				// The computer may have attached this device before the answer was lost: letting go keeps it from
				// sending output nobody draws.
				client.terminalDetach(id);
				waiting.length = 0;
				setError(err instanceof Error ? err.message : String(err));
			}
		};

		let frame = 0;
		const observer = new ResizeObserver(() => {
			cancelAnimationFrame(frame);
			// A pane that is hidden (a tab behind another) has no size to fit to.
			frame = requestAnimationFrame(() => {
				if (element.clientWidth > 0 && element.clientHeight > 0) fit.fit();
			});
		});
		observer.observe(element);
		const stopTheme = watchTheme(element, () => {
			const next = readTheme(element);
			term.options.theme = next.theme;
			term.options.fontFamily = terminalFont(next.fontFamily);
			fit.fit();
		});

		latest.current.register(id, {
			send: text => send(text),
			cursorKey: letter => send(`\x1b${term.modes.applicationCursorKeysMode ? "O" : "["}${letter}`),
			size: () => ({ cols: term.cols, rows: term.rows }),
			focus: () => term.focus(),
		});

		return () => {
			disposed = true;
			latest.current.register(id, null);
			stopTheme();
			observer.disconnect();
			cancelAnimationFrame(frame);
			stopWatching();
			client.terminalDetach(id);
			attach.current = null;
			xterm.current = null;
			term.dispose();
		};
	}, [client, id]);

	// Attach when the computer is connected, and again whenever it comes back: the shell kept its output meanwhile.
	useEffect(() => {
		if (live) void attach.current?.();
	}, [live]);

	useEffect(() => {
		if (focused) xterm.current?.focus();
	}, [focused]);

	return (
		<div
			className="sh-shell-pane"
			style={style}
			data-focused={focused ? "" : undefined}
			onFocusCapture={() => props.onFocus(id)}
			onPointerDownCapture={() => props.onFocus(id)}
		>
			<div ref={host} className="sh-shell-term" />
			{props.showClose && (
				<button
					type="button"
					className="sh-btn sh-btn-icon sh-shell-close"
					aria-label="Close this terminal"
					title="Close this terminal"
					onClick={() => props.onClose(id)}
				>
					<X size={13} />
				</button>
			)}
			{exit !== null && (
				<div className="sh-shell-note" role="status">
					{exit.signal !== undefined ? `The shell was ended by ${exit.signal}` : `The shell exited with code ${exit.code}`}.
					Press Enter to close this terminal.
				</div>
			)}
			{error !== null && (
				<div className="sh-shell-note sh-shell-note-error" role="alert">
					{error}
					<button type="button" className="sh-btn" onClick={() => props.onClose(id)}>
						Close
					</button>
				</div>
			)}
			{!live && <div className="sh-shell-note">Reconnecting to the computer…</div>}
		</div>
	);
}
