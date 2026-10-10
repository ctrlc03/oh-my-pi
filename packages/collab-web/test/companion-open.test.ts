import { describe, expect, it } from "bun:test";
import { parseLsofWriters, parsePs, resumedSession, sessionHolders } from "../scripts/companion-open";

const ID = "01a0ca0f-1111-7295-8160-1c66d561452d";

describe("parseLsofWriters", () => {
	it("keeps processes that hold the file for writing and skips readers", () => {
		// `lsof -F pcfa`: one p/c block per process, one f/a pair per descriptor.
		const out = [
			"p100",
			"cbun",
			"f40",
			"aw",
			"p200",
			"cmds",
			"f12",
			"ar",
			"p300",
			"cbun",
			"f9",
			"ar",
			"f11",
			"au",
		].join("\n");
		expect(parseLsofWriters(out)).toEqual([
			{ pid: 100, command: "bun" },
			{ pid: 300, command: "bun" },
		]);
	});

	it("is empty when lsof found nothing", () => {
		expect(parseLsofWriters("")).toEqual([]);
	});
});

describe("resumedSession", () => {
	it("reads the session an omp command line resumes", () => {
		expect(resumedSession(`bun /Users/me/.bun/bin/omp -r ${ID}`)).toBe(ID);
		expect(resumedSession(`/Users/me/.bun/bin/omp --resume ${ID} --model x`)).toBe(ID);
		expect(resumedSession(`omp --session=${ID}`)).toBe(ID);
	});

	it("ignores a process that only mentions the command, and omp without a session flag", () => {
		expect(resumedSession(`tmux new-session -d -s omp-1 omp -r ${ID}`)).toBeNull();
		expect(resumedSession("bun /Users/me/.bun/bin/omp --config x.yml")).toBeNull();
		expect(resumedSession(`vim -r ${ID}`)).toBeNull();
	});
});

describe("sessionHolders", () => {
	// 1 launchd → 10 Terminal.app → 20 login/zsh → 30 omp (resumed with -r, not written yet)
	//          → 40 tmux server → 50 omp (writer) ;  60 tmux (inherited the descriptor of an unrelated omp)
	const processes = parsePs(
		[
			"    1     0 ??       /sbin/launchd",
			"   10     1 ??       /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
			"   20    10 ttys001  -zsh",
			`   30    20 ttys001  bun /Users/me/.bun/bin/omp -r ${ID.slice(0, 13)}`,
			"   40     1 ??       tmux -S /tmp/s new-session -d omp",
			"   50    40 ttys002  bun /Users/me/.bun/bin/omp",
			`   60     1 ??       tmux new-session -d omp -r ${ID}`,
		].join("\n"),
	);
	const base = { sessionId: ID, writers: [], processes, listedPids: [], ignorePids: [] };

	it("finds a resumer by its arguments and names the app and terminal it runs in", () => {
		expect(sessionHolders(base)).toEqual([{ pid: 30, tty: "ttys001", app: "Terminal" }]);
	});

	it("finds a writer by its open file, under tmux, and does not blame a tmux server for a descriptor it inherited", () => {
		const holders = sessionHolders({
			...base,
			processes: processes.filter(proc => proc.pid !== 30),
			writers: [
				{ pid: 50, command: "bun" },
				{ pid: 60, command: "tmux" },
			],
		});
		expect(holders).toEqual([{ pid: 50, tty: "ttys002", app: "tmux" }]);
	});

	it("counts a listed omp once however many signals name it, and never the companion", () => {
		const holders = sessionHolders({
			...base,
			writers: [{ pid: 30, command: "bun" }],
			listedPids: [30, 70],
			ignorePids: [70],
		});
		expect(holders.map(holder => holder.pid)).toEqual([30]);
	});

	it("finds nothing when no signal names the session", () => {
		expect(sessionHolders({ ...base, sessionId: "01a0ca0f-9999-7295-8160-1c66d561452d" })).toEqual([]);
	});
});
