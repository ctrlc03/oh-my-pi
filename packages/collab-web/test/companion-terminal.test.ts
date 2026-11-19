import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TerminalPush } from "@oh-my-pi/pi-wire/terminal";
import { TERMINAL_MAX } from "@oh-my-pi/pi-wire/terminal";
import {
	ByteRing,
	checkSize,
	createTerminals,
	pickShell,
	RateGate,
	RING_BLOCK_BYTES,
	SOCKET_BUFFER_HIGH_BYTES,
	type Terminals,
	type TerminalsOptions,
	terminalEnv,
	terminalsSupported,
} from "../scripts/companion-terminal";

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("ByteRing", () => {
	it("replays everything while it fits, from offset 0", () => {
		const ring = new ByteRing(100);
		ring.push(encode("hello\n"));
		ring.push(encode("world"));
		const replay = ring.replay();
		expect(replay.from).toBe(0);
		expect(text(replay.bytes)).toBe("hello\nworld");
		expect(ring.end).toBe(11);
	});

	it("drops the oldest output and starts the replay at a line, so no escape sequence or character is cut", () => {
		const ring = new ByteRing(8);
		ring.push(encode("aaaa\n"));
		ring.push(encode("bbbb\n"));
		ring.push(encode("cccc\n"));
		const replay = ring.replay();
		expect(text(replay.bytes)).toBe("cccc\n");
		// The offset says where the first replayed byte sits in the whole output.
		expect(replay.from).toBe(10);
		expect(replay.from + replay.bytes.length).toBe(ring.end);
	});

	it("keeps the newest bytes of a single chunk bigger than the ring", () => {
		const ring = new ByteRing(4);
		ring.push(encode("0123456789"));
		const replay = ring.replay();
		expect(text(replay.bytes)).toBe("6789");
		expect(replay.from).toBe(6);
	});

	it("merges small reads into blocks, so many tiny reads are not as many chunks", () => {
		const ring = new ByteRing(1024 * 1024);
		for (let i = 0; i < RING_BLOCK_BYTES * 3; i++) ring.push(encode("x"));
		ring.push(encode("\n"));
		const replay = ring.replay();
		expect(replay.bytes.length).toBe(RING_BLOCK_BYTES * 3 + 1);
		expect(replay.from).toBe(0);
		expect(text(replay.bytes)).toBe(`${"x".repeat(RING_BLOCK_BYTES * 3)}\n`);
		expect(ring.end).toBe(RING_BLOCK_BYTES * 3 + 1);
	});

	it("keeps output in order across merged reads and bigger ones, and still drops the oldest", () => {
		const ring = new ByteRing(RING_BLOCK_BYTES * 2);
		ring.push(encode("small-1\n"));
		ring.push(new Uint8Array(RING_BLOCK_BYTES).fill(0x61));
		ring.push(encode("small-2\n"));
		ring.push(new Uint8Array(RING_BLOCK_BYTES * 2).fill(0x62));
		ring.push(encode("small-3\n"));
		const { bytes, from } = ring.replay();
		expect(text(bytes.subarray(bytes.length - 16))).toBe("bbbbbbbbsmall-3\n");
		expect(from + bytes.length).toBe(ring.end);
		expect(bytes.length).toBeLessThanOrEqual(RING_BLOCK_BYTES * 2);
	});
});

describe("RateGate", () => {
	it("allows a burst, then only what has refilled", () => {
		const gate = new RateGate(1000, 500, 0);
		expect(gate.take(0, 800)).toBe(500);
		expect(gate.take(0, 10)).toBe(0);
		expect(gate.take(100, 1000)).toBe(100);
	});

	it("reports what may be taken without taking it", () => {
		const gate = new RateGate(1000, 500, 0);
		expect(gate.available(0)).toBe(500);
		expect(gate.available(0)).toBe(500);
		gate.take(0, 500);
		expect(gate.available(100)).toBe(100);
	});

	it("says how long until a size is available, and never banks more than the burst", () => {
		const gate = new RateGate(1000, 500, 0);
		gate.take(0, 500);
		expect(gate.waitMs(0, 200)).toBe(200);
		expect(gate.take(60_000, 10_000)).toBe(500);
	});
});

describe("checkSize", () => {
	it("accepts whole numbers of a sensible size", () => {
		expect(checkSize(80, 24)).toEqual({ cols: 80, rows: 24 });
	});

	it("refuses anything else", () => {
		for (const [cols, rows] of [[0, 24], [80, 0], [80.5, 24], [100_000, 24], [80, 100_000], ["80", 24], [Number.NaN, 24]]) {
			expect(() => checkSize(cols, rows)).toThrow("invalid terminal size");
		}
	});
});

describe("pickShell", () => {
	const only = (...runnable: string[]) => (program: string) => runnable.includes(program);

	it("prefers $SHELL, then the account's shell, then the platform's default", () => {
		expect(pickShell({ SHELL: "/usr/bin/fish" }, "/bin/zsh", "darwin", only("/usr/bin/fish", "/bin/zsh"))).toBe("/usr/bin/fish");
		expect(pickShell({}, "/bin/zsh", "darwin", only("/bin/zsh", "/bin/bash"))).toBe("/bin/zsh");
		expect(pickShell({}, undefined, "darwin", only("/bin/zsh"))).toBe("/bin/zsh");
		expect(pickShell({}, undefined, "linux", only("/bin/bash", "/bin/sh"))).toBe("/bin/bash");
	});

	it("skips a shell that is relative or cannot run", () => {
		expect(pickShell({ SHELL: "zsh" }, "/gone", "linux", only("/bin/sh"))).toBe("/bin/sh");
		expect(() => pickShell({}, undefined, "linux", only())).toThrow("No shell found");
	});
});

describe("terminalEnv", () => {
	it("describes the terminal it is and hides the multiplexer the companion may have been started in", () => {
		const env = terminalEnv({ PATH: "/bin", TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%1", TERM: "screen", ITERM_SESSION_ID: "w0t0p0" });
		expect(env).toEqual({
			PATH: "/bin",
			TERM: "xterm-256color",
			COLORTERM: "truecolor",
			TERM_PROGRAM: "omp",
			LANG: "en_US.UTF-8",
		});
	});

	it("keeps the locale the companion has", () => {
		expect(terminalEnv({ LANG: "de_DE.UTF-8" }).LANG).toBe("de_DE.UTF-8");
		expect(terminalEnv({ LC_ALL: "C.UTF-8" }).LANG).toBeUndefined();
	});

	it("hides the service manager and the terminals the companion may have been started from", () => {
		const env = terminalEnv({
			PATH: "/bin",
			XPC_SERVICE_NAME: "sh.omp.collab-companion",
			XPC_FLAGS: "0x0",
			INVOCATION_ID: "abc",
			JOURNAL_STREAM: "8:1",
			NOTIFY_SOCKET: "/run/systemd/notify",
			OMP_BIN: "/opt/omp",
			LC_TERMINAL: "iTerm2",
			TERM_PROGRAM_VERSION: "3.5",
			KITTY_WINDOW_ID: "1",
			WEZTERM_PANE: "2",
			VSCODE_INJECTION: "1",
			COLUMNS: "80",
			PI_CONFIG_DIR: ".omp-work",
			LANG: "C.UTF-8",
		});
		expect(env).toEqual({
			PATH: "/bin",
			PI_CONFIG_DIR: ".omp-work",
			LANG: "C.UTF-8",
			TERM: "xterm-256color",
			COLORTERM: "truecolor",
			TERM_PROGRAM: "omp",
		});
	});
});

// A real shell on a real PTY: the rules that make a terminal safe to hand out.
describe.skipIf(!terminalsSupported())("Terminals", () => {
	let terminals: Terminals | undefined;
	let sent: { peer: number; frame: TerminalPush }[] = [];
	const make = (extra: Partial<TerminalsOptions> = {}): Terminals => {
		sent = [];
		terminals = createTerminals({
			send: (peer, frame) => sent.push({ peer, frame }),
			isLive: () => true,
			buffered: () => 0,
			log: () => {},
			...extra,
		});
		return terminals;
	};
	afterEach(() => terminals?.stopAll());
	// `/bin/sh` with an empty home: a login shell reads the account's startup files, which can take seconds (nvm,
	// prompt themes) and print anything, so the tests do not depend on the machine they run on.
	const saved = { SHELL: process.env.SHELL, HOME: process.env.HOME };
	let home = "";
	beforeAll(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-terminal-test-"));
		process.env.SHELL = "/bin/sh";
		process.env.HOME = home;
	});
	afterAll(() => {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		fs.rmSync(home, { recursive: true, force: true });
	});

	const output = (peer: number): string =>
		sent
			.filter(entry => entry.peer === peer && entry.frame.t === "terminal-output")
			.map(entry => (entry.frame.t === "terminal-output" ? Buffer.from(entry.frame.data, "base64").toString() : ""))
			.join("");
	const until = async (done: () => boolean): Promise<void> => {
		for (let i = 0; i < 200 && !done(); i++) await Bun.sleep(25);
		expect(done()).toBe(true);
	};
	const typed = (line: string): string => Buffer.from(line).toString("base64");

	it("runs the shell in the session's folder and keeps its input for the device that is attached", async () => {
		const shell = make();
		const terminal = await shell.open(1, { instanceId: "inst-1", cwd: "/tmp" }, 80, 24);
		// The arithmetic is evaluated by the shell: its answer, unlike the echo of the typed line, proves the command ran.
		shell.input(2, terminal.id, typed("echo stranger-$((1+1))\n"));
		shell.input(1, terminal.id, typed("echo owner-$((20+22)) cwd=$(pwd -P) end\n"));
		await until(() => /cwd=\S*\/tmp end/.test(output(1)));
		expect(output(1)).toContain("owner-42");
		expect(output(1)).not.toContain("stranger-");
		expect(output(1)).toMatch(/cwd=\S*\/tmp end/);
	});

	it("replays recent output to a device that attaches later, and ends the shell on close", async () => {
		const shell = make();
		const terminal = await shell.open(1, { instanceId: "inst-1", cwd: "/tmp" }, 80, 24);
		shell.input(1, terminal.id, typed("echo replayed-$((3*3))\n"));
		await until(() => output(1).includes("replayed-9"));
		shell.detach(1, terminal.id);
		const attached = shell.attach(3, terminal.id, 100, 30);
		expect(Buffer.from(attached.replay, "base64").toString()).toContain("replayed-9");
		expect(attached.terminal).toMatchObject({ cols: 100, rows: 30 });
		shell.close(terminal.id);
		expect(shell.count()).toBe(0);
		expect(() => shell.attach(3, terminal.id, 80, 24)).toThrow("no such terminal");
	});

	it("refuses a terminal beyond the cap", async () => {
		const shell = make();
		for (let i = 0; i < TERMINAL_MAX; i++) await shell.open(1, { instanceId: "inst-1", cwd: "/tmp" }, 80, 24);
		await expect(shell.open(1, { instanceId: "inst-1", cwd: "/tmp" }, 80, 24)).rejects.toThrow("At most");
	});

	it("refuses a folder that does not exist", async () => {
		await expect(make().open(1, { instanceId: "inst-1", cwd: "/no/such/folder" }, 80, 24)).rejects.toThrow("not on this computer");
	});

	it("starts no shell for a device that left while the terminal was being opened", async () => {
		const shell = make({ isLive: peer => peer !== 9 });
		await expect(shell.open(9, { instanceId: "inst-1", cwd: "/tmp" }, 80, 24)).rejects.toThrow("no longer connected");
		expect(shell.count()).toBe(0);
	});

	it("sends nothing to a device that is no longer connected", async () => {
		const live = new Set([1]);
		const shell = make({ isLive: peer => live.has(peer) });
		const terminal = await shell.open(1, { instanceId: "inst-1", cwd: "/tmp" }, 80, 24);
		shell.input(1, terminal.id, typed("echo before-$((1+1))\n"));
		await until(() => output(1).includes("before-2"));
		live.delete(1);
		const frames = sent.length;
		shell.input(1, terminal.id, typed("echo after-$((2+2))\n"));
		// The ring keeps what the shell wrote whether or not anyone was sent it: it shows the command ran.
		await until(() => Buffer.from(shell.attach(2, terminal.id, 80, 24).replay, "base64").toString().includes("after-4"));
		expect(sent.filter(entry => entry.peer === 1).length).toBe(frames);
	});

	it("holds output back while the connection of a device has a backlog, then sends it", async () => {
		let backlog = SOCKET_BUFFER_HIGH_BYTES;
		const shell = make({ buffered: () => backlog });
		const terminal = await shell.open(1, { instanceId: "inst-1", cwd: "/tmp" }, 80, 24);
		shell.input(1, terminal.id, typed("echo held-$((6*7))\n"));
		await until(() => Buffer.from(shell.attach(2, terminal.id, 80, 24).replay, "base64").toString().includes("held-42"));
		expect(output(1)).not.toContain("held-42");
		backlog = 0;
		await until(() => output(1).includes("held-42"));
	});
});
