import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	actionsRef,
	checkNumber,
	checkRepo,
	ciFailures,
	MAX_LOG_BYTES,
	MAX_LOG_LINES,
	MAX_TOTAL_BYTES,
	type RepoFacts,
	repoFolders,
	repoFromRemote,
	readTail,
	repoSessions,
	trimLog,
} from "../scripts/companion-cilog";
import { fixRoute, parseFixRoute } from "../src/lib/fix-route";

const byteLength = (text: string): number => Buffer.byteLength(text);

describe("trimLog", () => {
	it("keeps the tail, says how much was cut, and drops colour codes and timestamps", () => {
		const raw = Array.from(
			{ length: 300 },
			(_, i) => `lint\tRun lint\t2026-10-10T09:00:00.1234567Z \u001b[31mline ${i}\u001b[0m`,
		).join("\n");
		const lines = trimLog(raw).split("\n");
		expect(lines).toHaveLength(MAX_LOG_LINES + 1);
		expect(lines[0]).toBe("… 100 earlier lines omitted");
		expect(lines[1]).toBe("lint\tRun lint\tline 100");
		expect(lines.at(-1)).toBe("lint\tRun lint\tline 299");
	});

	it("returns a short log whole, without a marker", () => {
		expect(trimLog("a\nb\n\n")).toBe("a\nb");
		expect(trimLog("\n\n")).toBe("");
	});

	it("stays within the byte budget, marker and multi-byte text included", () => {
		const raw = Array.from({ length: 150 }, (_, i) => `${"é".repeat(150)} ${i}`).join("\n");
		const out = trimLog(raw);
		expect(byteLength(out)).toBeLessThanOrEqual(MAX_LOG_BYTES);
		expect(out.startsWith("… ")).toBe(true);
		expect(out.endsWith(" 149")).toBe(true);
	});

	it("keeps the end of a single line larger than the budget", () => {
		const out = trimLog(`${"x".repeat(5000)}END`, 200, 1024);
		expect(byteLength(out)).toBeLessThanOrEqual(1024);
		expect(out.endsWith("xxxEND")).toBe(true);
		expect(out.split("\n")[0]).toContain("omitted");
	});
});

describe("remote and URL parsing", () => {
	it("reads owner/name from https, ssh and scp-like remotes", () => {
		for (const url of [
			"https://github.com/acme/app.git",
			"https://user:token@github.com/acme/app",
			"git@github.com:acme/app.git",
			"ssh://git@github.com:22/acme/app.git",
			"https://github.com/acme/app/",
		])
			expect(repoFromRemote(url)).toBe("acme/app");
		expect(repoFromRemote("/Users/me/code/app")).toBeNull();
		expect(repoFromRemote("")).toBeNull();
	});

	it("finds the Actions run and job of a details URL, and nothing in other URLs", () => {
		expect(actionsRef("https://github.com/acme/app/actions/runs/200/job/111")).toEqual({
			runId: "200",
			jobId: "111",
		});
		expect(actionsRef("https://github.com/acme/app/actions/runs/200")).toEqual({ runId: "200", jobId: null });
		expect(actionsRef("https://codecov.io/gh/acme/app/pull/7")).toBeNull();
		expect(actionsRef("")).toBeNull();
	});

	it("refuses arguments that could be read as gh flags or paths", () => {
		for (const repo of ["--repo/x", "a/b/c", "acme", "acme/app --json", "", 7])
			expect(() => checkRepo(repo)).toThrow("invalid repository");
		expect(checkRepo("acme/app.js")).toBe("acme/app.js");
		for (const n of [0, -1, 1.5, "7", Number.NaN]) expect(() => checkNumber(n)).toThrow("invalid number");
		expect(checkNumber(7)).toBe(7);
	});
});

describe("fix route", () => {
	it("round-trips a pull request and rejects anything else", () => {
		expect(fixRoute("acme/app", 7)).toBe("fix:acme%2Fapp/7");
		expect(parseFixRoute(fixRoute("acme/app", 7))).toEqual({ repo: "acme/app", number: 7 });
		for (const bad of ["fix:acme%2Fapp/0", "fix:acme%2Fapp/x", "fix:%zz/7", "open:abc", "fix:/7"])
			expect(parseFixRoute(bad)).toBeNull();
	});
});

let tmp: string;
let savedGhBin: string | undefined;

const LINT_LOG = Array.from({ length: 300 }, (_, i) => `lint\tRun lint\t2026-10-10T09:00:00.1234567Z error ${i}`).join(
	"\n",
);

function check(name: string, conclusion: string, url: string, workflowName = "CI"): Record<string, string> {
	return { name, workflowName, status: "COMPLETED", conclusion, detailsUrl: url };
}

const ACTIONS = "https://github.com/acme/app/actions/runs/200";

beforeAll(async () => {
	tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "companion-cilog-")));
	const view = {
		title: "Add widgets",
		url: "https://github.com/acme/app/pull/7",
		headRefName: "widgets",
		statusCheckRollup: [
			check("lint", "FAILURE", `${ACTIONS}/job/111`),
			check("test", "FAILURE", `${ACTIONS}/job/112`),
			check("build", "SUCCESS", `${ACTIONS}/job/113`),
			check("lint", "FAILURE", `${ACTIONS}/job/111`),
			{ name: "deploy", workflowName: "CI", status: "IN_PROGRESS", detailsUrl: `${ACTIONS}/job/114` },
			{ context: "codecov/patch", state: "FAILURE", targetUrl: "https://codecov.io/gh/acme/app/pull/7" },
		],
	};
	await Bun.write(path.join(tmp, "view.json"), JSON.stringify(view));
	await Bun.write(path.join(tmp, "log-111"), LINT_LOG);
	// A gh stand-in: records every call and answers from the fixtures above.
	const stub = path.join(tmp, "gh");
	await fs.writeFile(
		stub,
		`#!/bin/sh
printf '%s\\n' "$*" >> "${tmp}/calls"
case "$1 $2" in
  "pr view") cat "${tmp}/view.json" ;;
  "run view")
    case "$3 $4" in
      "--job 111") cat "${tmp}/log-111" ;;
      *) echo "log not found" >&2; exit 1 ;;
    esac ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`,
		{ mode: 0o755 },
	);
	savedGhBin = process.env.GH_BIN;
	process.env.GH_BIN = stub;
});

afterAll(async () => {
	if (savedGhBin === undefined) delete process.env.GH_BIN;
	else process.env.GH_BIN = savedGhBin;
	await fs.rm(tmp, { recursive: true, force: true });
});

describe("ciFailures", () => {
	it("lists each failing check once with the log tail of its Actions job, and none for other checks", async () => {
		const report = await ciFailures("acme/app", 7);
		expect(report.pr).toEqual({ title: "Add widgets", url: "https://github.com/acme/app/pull/7", branch: "widgets" });
		expect(report.moreFailures).toBe(0);
		expect(report.failures.map(f => f.check)).toEqual(["CI / lint", "CI / test", "codecov/patch"]);
		const [lint, test, codecov] = report.failures;
		const lines = lint!.log.split("\n");
		expect(lines[0]).toBe("… 100 earlier lines omitted");
		expect(lines.at(-1)).toBe("lint\tRun lint\terror 299");
		expect(lint!.url).toBe(`${ACTIONS}/job/111`);
		// gh could not give the second job's log: the check is still listed.
		expect(test).toEqual({ check: "CI / test", url: `${ACTIONS}/job/112`, log: "" });
		expect(codecov).toEqual({ check: "codecov/patch", url: "https://codecov.io/gh/acme/app/pull/7", log: "" });
	});

	it("asks gh for the pull request and one job log per distinct job, never for passing or other checks", async () => {
		await fs.rm(path.join(tmp, "calls"), { force: true });
		await ciFailures("acme/app", 7);
		const calls = (await Bun.file(path.join(tmp, "calls")).text()).trim().split("\n").sort();
		expect(calls).toEqual([
			"pr view 7 --repo acme/app --json title,url,headRefName,statusCheckRollup",
			"run view --job 111 --repo acme/app --log-failed",
			"run view --job 112 --repo acme/app --log-failed",
		]);
	});

	it("keeps all logs within the overall budget", async () => {
		const many = Array.from({ length: 8 }, (_, i) => check(`job${i}`, "FAILURE", `${ACTIONS}/job/111`, `W${i}`));
		await Bun.write(
			path.join(tmp, "view.json"),
			JSON.stringify({
				title: "t",
				url: "u",
				headRefName: "b",
				statusCheckRollup: [...many, check("extra", "FAILURE", `${ACTIONS}/job/111`, "X")],
			}),
		);
		await Bun.write(
			path.join(tmp, "log-111"),
			Array.from({ length: 400 }, (_, i) => `${"y".repeat(200)} ${i}`).join("\n"),
		);
		const report = await ciFailures("acme/app", 7);
		const total = report.failures.reduce((sum, f) => sum + byteLength(f.log), 0);
		expect(total).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
		expect(report.failures).toHaveLength(8);
		expect(report.moreFailures).toBe(1);
		// The first checks get their full share, later ones what is left (possibly nothing).
		expect(report.failures[0]!.log.length).toBeGreaterThan(0);
		expect(report.failures.at(-1)!.log).toBe("");
	});
});

const facts: Record<string, RepoFacts | null> = {
	"/code/app": { repos: ["Acme/App"], branch: "main" },
	"/code/app-widgets": { repos: ["me/app", "acme/app"], branch: "widgets" },
	"/code/app-sandbox": { repos: ["acme/app"], branch: "widgets" },
	"/code/other": { repos: ["acme/other"], branch: "widgets" },
	"/code/gone": null,
};
const lookup = async (cwd: string): Promise<RepoFacts | null> => (Object.hasOwn(facts, cwd) ? facts[cwd]! : null);
const session = (instanceId: string, cwd: string, extra: { sandboxed?: boolean; busy?: boolean | null } = {}) => ({
	instanceId,
	sessionName: null,
	cwd,
	busy: extra.busy ?? false,
	sandboxed: extra.sandboxed,
});

describe("repoSessions", () => {
	it("keeps sessions of the repository by any remote, ranking the pull request's branch first, sandboxed and idle ones last", async () => {
		const found = await repoSessions(
			"acme/app",
			"widgets",
			[
				session("main", "/code/app"),
				session("sandbox", "/code/app-sandbox", { sandboxed: true }),
				session("widgets", "/code/app-widgets", { busy: true }),
				session("other", "/code/other"),
				session("gone", "/code/gone"),
			],
			[session("idle-main", "/code/app")],
			lookup,
		);
		expect(found.map(s => s.instanceId)).toEqual(["widgets", "sandbox", "main", "idle-main"]);
		expect(found[0]).toMatchObject({
			title: "app-widgets",
			branch: "widgets",
			host: true,
			busy: true,
			sandboxed: false,
		});
		expect(found[1]).toMatchObject({ sandboxed: true });
		expect(found[3]).toMatchObject({ host: false });
	});

	it("offers nothing for a repository no session is in", async () => {
		expect(await repoSessions("acme/missing", "x", [session("a", "/code/app")], [], lookup)).toEqual([]);
	});
});

describe("repoFolders", () => {
	it("lists recent folders of the repository that no session already runs in", async () => {
		const found = await repoFolders(
			"acme/app",
			[{ cwd: "/code/app" }, { cwd: "/code/app-widgets" }, { cwd: "/code/other" }, { cwd: "/code/gone" }],
			["/code/app"],
			lookup,
		);
		expect(found).toEqual([{ cwd: "/code/app-widgets", branch: "widgets" }]);
	});
});

describe("readTail", () => {
	const streamOf = (chunks: string[]): ReadableStream<Uint8Array> =>
		new ReadableStream({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
				controller.close();
			},
		});

	it("keeps exactly the last bytes of a longer stream and says earlier output was cut", async () => {
		const out = await readTail(streamOf(["aaaa", "bbbb", "cccc"]), 6, 1000);
		expect(out).toEqual({ text: "bbcccc", cutBefore: true, stopped: false });
	});

	it("returns a short stream whole", async () => {
		expect(await readTail(streamOf(["ab", "c"]), 100, 1000)).toEqual({
			text: "abc",
			cutBefore: false,
			stopped: false,
		});
	});

	it("stops reading at the hard cap", async () => {
		let pulled = 0;
		const endless = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled++;
				controller.enqueue(new TextEncoder().encode("x".repeat(1000)));
			},
		});
		const out = await readTail(endless, 100, 10_000);
		expect(out.stopped).toBe(true);
		expect(out.cutBefore).toBe(true);
		expect(out.text).toHaveLength(100);
		// Not unbounded: a stream that never ends was abandoned soon after the cap.
		expect(pulled).toBeLessThan(50);
	});
});

describe("ciFailures with a huge log", () => {
	let dir: string;
	let saved: string | undefined;

	beforeAll(async () => {
		dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "companion-cilog-big-")));
		await Bun.write(
			path.join(dir, "view.json"),
			JSON.stringify({
				title: "t",
				url: "u",
				headRefName: "b",
				statusCheckRollup: [111, 112, 113, 114].map(job =>
					check(`job${job}`, "FAILURE", `${ACTIONS}/job/${job}`, `W${job}`),
				),
			}),
		);
		// Each `run view` prints ~12 MB, holds a lock directory for a moment, and records how many were running.
		const stub = path.join(dir, "gh");
		await fs.writeFile(
			stub,
			`#!/bin/sh
case "$1 $2" in
  "pr view") cat "${dir}/view.json" ;;
  "run view")
    mkdir "${dir}/lock.$$"
    ls -d "${dir}"/lock.* | wc -l >> "${dir}/running"
    awk 'BEGIN { pad = sprintf("%100s", ""); for (i = 0; i < 100000; i++) print "line " i pad }'
    rmdir "${dir}/lock.$$" ;;
esac
`,
			{ mode: 0o755 },
		);
		saved = process.env.GH_BIN;
		process.env.GH_BIN = stub;
	});

	afterAll(async () => {
		if (saved === undefined) delete process.env.GH_BIN;
		else process.env.GH_BIN = saved;
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("answers each check with a tail of the real end of the log, marked as cut, and runs at most two reads at once", async () => {
		const report = await ciFailures("acme/app", 7);
		expect(report.failures).toHaveLength(4);
		const first = report.failures[0]!.log.split("\n");
		expect(first[0]).toBe("… earlier output omitted");
		expect(first.at(-1)).toBe("line 99999");
		expect(byteLength(report.failures[0]!.log)).toBeLessThanOrEqual(MAX_LOG_BYTES);
		const running = (await Bun.file(path.join(dir, "running")).text())
			.trim()
			.split("\n")
			.map(n => Number(n.trim()));
		expect(running).toHaveLength(4);
		expect(Math.max(...running)).toBeLessThanOrEqual(2);
	});
});
