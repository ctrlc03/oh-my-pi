import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { HostList, IdleList } from "../src/components/shell/CompanionCard";
import { PrivateChip, PrivateMark } from "../src/components/shell/PrivateMark";
import { SessionRow } from "../src/components/shell/SessionsSheet";
import { SessionsSidebar } from "../src/components/shell/SessionsSidebar";
import type { SessionSummary } from "@oh-my-pi/omp-stats/shared-types";
import { createSessionLister, type RegistryModule } from "../scripts/companion-list";
import { launchesPrivate, privateHostsFields } from "../scripts/companion-private";
import { headlessOmpArgs } from "../scripts/companion-headless";
import { ompArgs } from "../scripts/companion-gitmsg";
import { isPrivateSession } from "../scripts/companion-sessions";
import { mergeLive } from "../scripts/companion-stats";
import { findTmux, launchInTmux } from "../scripts/companion-start";
import { createMockForeign } from "../scripts/mock-foreign";
import { createMockStart } from "../scripts/mock-start";
import {
	type CompanionHost,
	type CompanionIdleSession,
	type CompanionSnapshot,
	INITIAL_SNAPSHOT,
	type SessionOverview,
} from "../src/lib/companion";
import type { ComputerHandle } from "../src/lib/computers";
import { applyOrg, emptyOrg } from "../src/lib/session-org";
import type { SessionOrgControl, SessionOrgs } from "../src/lib/use-session-org";
import { newSessionTarget, type StartDraft, startOptions, startsPrivate } from "../src/lib/start-session";

const NOW = 1_800_000_000_000;

const draft: StartDraft = {
	cwd: "/Users/me/code/app",
	sandboxed: false,
	worktree: false,
	branch: "",
	prompt: "do it",
	agent: null,
	model: "",
	permission: "supervised",
};

describe("the start draft asks for a private session", () => {
	it("only when the computer can and the agent is omp", () => {
		// The sheet resolves the draft's flag through `startsPrivate`; the target and the request carry what it says.
		const request = (wanted: boolean, canPrivate: boolean, agent: string | null) => {
			const target = newSessionTarget({ ...draft, agent, private: startsPrivate(wanted, canPrivate, agent) });
			return startOptions(target).private;
		};
		expect(request(true, true, null)).toBe(true);
		expect(request(true, false, null)).toBeUndefined();
		expect(request(false, true, null)).toBeUndefined();
		expect(request(true, true, "claude")).toBeUndefined();
		expect(request(true, true, "custom:team")).toBeUndefined();
	});

	it("drops the flag for a vendor agent even when the draft carries it", () => {
		expect(newSessionTarget({ ...draft, agent: "codex", private: true }).private).toBeUndefined();
		expect(newSessionTarget({ ...draft, private: true }).private).toBe(true);
	});

	it("goes with a worktree, high stakes and no project", () => {
		const target = newSessionTarget({ ...draft, private: true, worktree: true, highStakes: true, branch: "x" });
		expect(startOptions(target)).toMatchObject({ private: true, highStakes: true, worktree: { branch: "x" } });
		expect(startOptions(newSessionTarget({ ...draft, cwd: "", private: true }))).toMatchObject({
			private: true,
			scratch: { hint: "do it" },
		});
	});

	it("is never sent for a resume", () => {
		expect(startOptions({ cwd: "/p", resume: "abc", sandboxed: false })).not.toHaveProperty("private", true);
	});
});

describe("the companion", () => {
	it("advertises canPrivate with canStart, and only then", () => {
		expect(privateHostsFields(true)).toEqual({ canPrivate: true });
		expect(privateHostsFields(false)).toEqual({ canPrivate: false });
	});

	it("launches --private for a new omp session only", () => {
		expect(launchesPrivate({ private: true, foreign: false })).toBe(true);
		expect(launchesPrivate({ foreign: false })).toBe(false);
		expect(launchesPrivate({ private: false, foreign: false })).toBe(false);
		expect(launchesPrivate({ private: true, foreign: true })).toBe(false);
		expect(launchesPrivate({ private: true, foreign: false, resume: "abc123" })).toBe(false);
	});

	it("lists a private session's row with private: true, from the registry", async () => {
		const row = { instanceId: "a", sessionId: "s", cwd: "/w", startedAt: 1, pid: 0, participants: 1 };
		const lister = createSessionLister({
			sandboxOverlayPath: "/nonexistent",
			runOmp: async () => "{}",
			loadRegistry: async () =>
				({
					listCollabSessions: async () => ({
						hosts: [
							{ ...row, access: "control", sessionName: "p", model: null, private: true },
							{ ...row, instanceId: "b", access: "control", sessionName: "n", model: null },
						],
						idle: [
							{ ...row, instanceId: "c", private: true },
							{ ...row, instanceId: "d" },
						],
					}),
				}) as unknown as RegistryModule,
		});
		const listing = await lister.list();
		const byId = (rows: readonly { instanceId: string; private?: boolean }[]) =>
			Object.fromEntries(rows.map(r => [r.instanceId, r.private]));
		expect(byId(listing.hosts)).toEqual({ a: true, b: undefined });
		expect(byId(listing.idle)).toEqual({ c: true, d: undefined });
	});
});

const tmuxBin = await findTmux();

describe.skipIf(tmuxBin === null)("launchInTmux with a real tmux", () => {
	let root: string;
	let wrapper: string;
	let fakeOmp: string;

	beforeAll(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join("/tmp", "omp-priv-")));
		wrapper = path.join(root, "tmux");
		await fs.writeFile(wrapper, `#!/bin/sh\ncd '${root}' && TMUX_TMPDIR='${root}' exec '${tmuxBin}' -L p "$@"\n`, {
			mode: 0o700,
		});
		fakeOmp = path.join(root, "fake-omp");
		await fs.writeFile(
			fakeOmp,
			`#!/bin/sh\n{ for a in "$@"; do printf '[%s]\\n' "$a"; done; } > "${root}/out.tmp" && mv "${root}/out.tmp" "${root}/out"\n`,
			{ mode: 0o700 },
		);
	});

	afterAll(async () => {
		const stop = Bun.spawn([wrapper, "kill-server"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
		await stop.exited;
		await fs.rm(root, { recursive: true, force: true });
	});

	async function argsOf(extra: { private?: boolean }): Promise<string[]> {
		await fs.rm(path.join(root, "out"), { force: true });
		await launchInTmux({
			tmux: wrapper,
			ompBin: fakeOmp,
			overlayPath: path.join(root, "overlay.yml"),
			promptDir: path.join(root, "run"),
			cwd: root,
			prompt: "fix it",
			...extra,
		});
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			const text = await Bun.file(path.join(root, "out"))
				.text()
				.catch(() => null);
			if (text !== null) return text.trim().split("\n");
			await Bun.sleep(20);
		}
		throw new Error("the stand-in omp never ran");
	}

	it("starts omp with --private, before the prompt, when asked", async () => {
		const lines = await argsOf({ private: true });
		expect(lines).toContain("[--private]");
		expect(lines.indexOf("[--private]")).toBeLessThan(lines.indexOf("[--]"));
	});

	it("does not pass --private otherwise", async () => {
		expect(await argsOf({})).not.toContain("[--private]");
		expect(await argsOf({ private: false })).not.toContain("[--private]");
	});
});

describe("the mock companion", () => {
	let dir: string;
	const hosts: CompanionHost[] = [];

	beforeAll(async () => {
		dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mock-private-")));
		await fs.mkdir(path.join(dir, "repo"));
	});
	afterAll(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	const mock = (canPrivate?: boolean) =>
		createMockStart({
			dir,
			foreign: createMockForeign({ hosts }),
			hosts,
			baseFolders: async () => [],
			onChange: () => {},
			canPrivate,
		});

	it("advertises canPrivate, unless it plays an older companion, and lists a private start as private", async () => {
		expect(mock().capabilities).toHaveProperty("canPrivate", true);
		expect(mock(false).capabilities).not.toHaveProperty("canPrivate");
		const start = mock();
		const reply = await start.answer({ t: "start", reqId: 1, cwd: path.join(dir, "repo"), private: true });
		if (reply.t !== "started") throw new Error("not started");
		const row = hosts.find(h => h.instanceId === reply.instanceId);
		expect(row?.private).toBe(true);
		expect(row?.model?.startsWith("anthropic/")).toBe(false);
		const plain = await start.answer({ t: "start", reqId: 2, cwd: path.join(dir, "repo") });
		if (plain.t !== "started") throw new Error("not started");
		expect(hosts.find(h => h.instanceId === plain.instanceId)?.private).toBeUndefined();
	});
});

function host(over: Partial<CompanionHost> = {}): CompanionHost {
	return {
		instanceId: "inst-1",
		sessionId: "s-1",
		sessionName: "docs-pass",
		cwd: "/work/docs-pass",
		model: null,
		startedAt: NOW,
		participants: 1,
		busy: false,
		inputRequired: false,
		relayConnected: true,
		...over,
	};
}

function computer(hostsOf: CompanionHost[]): ComputerHandle {
	const snap: CompanionSnapshot = { ...INITIAL_SNAPSHOT, phase: "live", machine: "mac", hosts: hostsOf };
	return { id: "mac", name: "mac", client: null, snap, error: null };
}

function sidebar(hostsOf: CompanionHost[]): string {
	const control: SessionOrgControl = {
		doc: applyOrg(emptyOrg(), "none", { type: "pin" }, NOW),
		now: NOW,
		synced: false,
		act: () => {},
		edit: () => ({}),
		restore: () => {},
		extras: true,
		canEndOnSettle: false,
		setSettings: () => {},
	};
	const orgs: SessionOrgs = { of: () => control };
	return renderToStaticMarkup(
		<SessionsSidebar
			computers={[computer(hostsOf)]}
			rooms={[]}
			orgs={orgs}
			currentSessionId={null}
			currentRoomId={null}
			onOpenHost={() => Promise.resolve()}
			onOpenLink={() => {}}
			onOpenUsage={null}
			onOpenSessions={null}
			onClose={() => {}}
		/>,
	);
}

describe("the Private badge", () => {
	const idleSession = (over: Partial<CompanionIdleSession> = {}): CompanionIdleSession => ({
		instanceId: "inst-9",
		sessionId: "s-9",
		sessionName: "idle",
		cwd: "/work/idle",
		model: null,
		startedAt: NOW,
		busy: false,
		...over,
	});
	const hostRows = (rows: CompanionHost[]): string =>
		renderToStaticMarkup(
			<HostList computerId="mac" hosts={rows} joining={null} disabled={false} onJoin={() => {}} />,
		);
	const idleRows = (rows: CompanionIdleSession[]): string =>
		renderToStaticMarkup(<IdleList idle={rows} joining={null} disabled={false} onShare={() => {}} />);
	const sessionRow = (over: Partial<SessionOverview>): string =>
		renderToStaticMarkup(
			<SessionRow
				session={{
					sessionId: "s-1",
					title: "docs-pass",
					folder: "/work/docs-pass",
					startedAt: NOW,
					endedAt: null,
					requests: 1,
					toolCalls: 1,
					subagents: 0,
					tokens: 1,
					cost: 0,
					models: [],
					...over,
				}}
				current={false}
				busy={null}
				canStart
				onOpen={() => {}}
				onShare={() => {}}
				onResume={() => {}}
			/>,
		);

	it("is labelled for assistive technology, as a chip and as a mark", () => {
		expect(renderToStaticMarkup(<PrivateChip />)).toContain('aria-label="Private session"');
		expect(renderToStaticMarkup(<PrivateMark />)).toContain('aria-label="Private session"');
	});

	it("shows on a private row of the sessions sidebar and on no other", () => {
		const markup = sidebar([
			host({ private: true }),
			host({ instanceId: "inst-2", sessionId: "s-2", sessionName: "plain" }),
		]);
		expect(markup.match(/aria-label="Private session"/g)).toHaveLength(1);
		expect(sidebar([host()])).not.toContain("Private session");
	});

	it("shows on the computer card's rows and the All sessions rows, and on no other", () => {
		expect(hostRows([host({ private: true })])).toContain("Private session");
		expect(hostRows([host()])).not.toContain("Private session");
		expect(idleRows([idleSession({ private: true })])).toContain("Private session");
		expect(idleRows([idleSession()])).not.toContain("Private session");
		expect(sessionRow({ live: "host", instanceId: "inst-1", private: true })).toContain("Private session");
		expect(sessionRow({ live: "host", instanceId: "inst-1" })).not.toContain("Private session");
	});

	it("is carried from the listed hosts and idle sessions onto the session overviews", () => {
		const summary = {
			file: "/s/2026_abc123.jsonl",
			title: "t",
			folder: "/w",
			startedAt: 1,
			endedAt: 2,
		} as SessionSummary;
		const listed = (rows: CompanionHost[]) => mergeLive([summary], { hosts: rows, idle: [] })[0];
		expect(listed([host({ sessionId: "abc123", private: true })])?.private).toBe(true);
		expect(listed([host({ sessionId: "abc123" })])).not.toHaveProperty("private");
		const viaIdle = mergeLive([summary], { hosts: [], idle: [idleSession({ sessionId: "abc123", private: true })] });
		expect(viaIdle[0]?.private).toBe(true);
	});
});

describe("runs the companion makes on a private session's content", () => {
	let dir: string;
	beforeAll(async () => {
		dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "private-sessions-")));
		const folder = path.join(dir, "-work-repo");
		await fs.mkdir(folder);
		const header = (id: string, extra: string): string =>
			`{"type":"session","version":3,"id":"${id}","cwd":"/w"${extra}}\n`;
		await fs.writeFile(path.join(folder, "2026-01-01T00-00-00-000Z_priv1.jsonl"), header("priv1", ',"private":true'));
		await fs.writeFile(path.join(folder, "2026-01-01T00-00-00-000Z_plain1.jsonl"), header("plain1", ""));
		await fs.writeFile(
			path.join(folder, "2026-01-01T00-00-00-000Z_false1.jsonl"),
			header("false1", ',"private":false'),
		);
	});
	afterAll(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("reads a session's privacy from its header, and a missing session is not private", async () => {
		expect(await isPrivateSession(dir, "priv1")).toBe(true);
		expect(await isPrivateSession(dir, "plain1")).toBe(false);
		expect(await isPrivateSession(dir, "false1")).toBe(false);
		expect(await isPrivateSession(dir, "nonesuch")).toBe(false);
		expect(await isPrivateSession(dir, "../etc/passwd")).toBe(false);
	});

	it("passes --private to the headless runs only when asked", () => {
		const base = { ompBin: "omp", model: "@smol", systemPrompt: "s", maxCostUsd: 0.1 };
		expect(headlessOmpArgs({ ...base, private: true })).toContain("--private");
		expect(headlessOmpArgs(base)).not.toContain("--private");
		expect(headlessOmpArgs({ ...base, private: false })).not.toContain("--private");
		expect(ompArgs("omp", "smol", true)).toContain("--private");
		expect(ompArgs("omp", "smol")).not.toContain("--private");
	});
});
