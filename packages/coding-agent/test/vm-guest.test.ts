import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type GuestProvisionOptions,
	guestCloneSystemScript,
	guestCloneUserScript,
	guestDoneWatcherScript,
	guestDoneWatcherUnit,
	guestGitProxyConfig,
	guestSystemScript,
	guestUserScript,
	parsePairUrl,
} from "@oh-my-pi/pi-coding-agent/vm/guest";
import type { VmRecord } from "@oh-my-pi/pi-coding-agent/vm/types";

const record: VmRecord = {
	version: 1,
	name: "api",
	repos: ["acme/api", "acme/it's-quoted"],
	cpus: 2,
	memoryGiB: 4,
	diskGiB: 20,
	network: "allowlist",
	driver: "qemu",
	phase: "creating",
	createdAt: 0,
};

function options(endpoints: GuestProvisionOptions["endpoints"]): GuestProvisionOptions {
	return {
		record,
		endpoints,
		providers: ["anthropic", "openai-codex"],
		installerUrl: "https://example.test/install.sh",
		identity: { name: "omp-vm[bot]", email: "1+omp-vm[bot]@users.noreply.github.com" },
	};
}

const endpointKinds: GuestProvisionOptions["endpoints"][] = [
	{ hostServices: "UNIX-CONNECT:%h/.omp-host.sock" },
	{ hostServices: "TCP:10.0.2.100:80", egressProxy: "http://10.0.2.101:3128" },
];

function bashSyntaxError(script: string): string {
	const result = Bun.spawnSync(["bash", "-n"], { stdin: new Blob([script]) });
	return result.exitCode === 0 ? "" : result.stderr.toString();
}

describe("guest provisioning scripts", () => {
	for (const endpoints of endpointKinds) {
		test(`are valid bash (${endpoints.egressProxy ? "proxied" : "direct"} egress)`, () => {
			expect(bashSyntaxError(guestSystemScript(options(endpoints), "dev"))).toBe("");
			expect(bashSyntaxError(guestUserScript(options(endpoints)))).toBe("");
		});
	}

	test("a repository name with a quote reaches the clone loop intact", () => {
		const script = guestUserScript(options(endpointKinds[0]));
		const loop = /for repo in (.+); do/.exec(script)?.[1];
		expect(loop).toBeDefined();
		const words = Bun.spawnSync(["bash", "-c", `for repo in ${loop}; do printf '%s\\n' "$repo"; done`]);
		expect(words.stdout.toString().trim().split("\n")).toEqual(record.repos);
	});

	test("git sends every github.com remote form to the host, and re-running does not stack rewrites", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "vm-home-"));
		try {
			const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
			const run = (...args: string[]) =>
				Bun.spawnSync(["git", ...args], { env })
					.stdout.toString()
					.trim();
			const config = guestGitProxyConfig().join("\n");
			for (let attempt = 0; attempt < 2; attempt++) {
				expect(Bun.spawnSync(["bash", "-euc", config], { env }).exitCode).toBe(0);
			}
			const urls = [
				"https://github.com/acme/api.git",
				"git@github.com:acme/api.git",
				"ssh://git@github.com/acme/api.git",
			].map(remote => run("ls-remote", "--get-url", remote));
			// Still github.com, so gh recognizes the remote; plain HTTP, so the host can read it and add the token.
			expect(urls).toEqual(Array(3).fill("http://github.com/acme/api.git"));
			expect(run("config", "--get-urlmatch", "http.proxy", "http://github.com/acme/api.git")).toBe(
				"http://127.0.0.1:4000",
			);
			expect(run("config", "--global", "--get-regexp", "insteadof").split("\n")).toHaveLength(3);
			expect(run("ls-remote", "--get-url", "https://gitlab.com/a/b.git")).toBe("https://gitlab.com/a/b.git");
			expect(run("config", "--get-urlmatch", "http.proxy", "https://gitlab.com/a/b.git")).toBe("");
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("fresh VM identity scripts", () => {
	const clone = { name: "base-1", providers: ["anthropic"] };

	test("are valid bash", () => {
		expect(bashSyntaxError(guestCloneSystemScript(clone))).toBe("");
		expect(bashSyntaxError(guestCloneUserScript(clone))).toBe("");
	});

	test("the system part names the host after the clone and makes a new machine id", () => {
		const script = guestCloneSystemScript(clone);
		expect(script).toContain("hostnamectl set-hostname 'vm-base-1'");
		expect(script).toContain("/etc/machine-id");
	});

	test("the user part drops the template's companion identity but keeps the disk-guard limit", () => {
		const script = guestCloneUserScript(clone);
		expect(script).toContain("systemctl --user stop omp-collab-companion.service");
		expect(script).toContain("collab-companion*' ! -name collab-companion-disk.json");
		for (const gone of ["agent/sessions", "agent/worktrees", ".omp/install-id"]) expect(script).toContain(gone);
		expect(script).toContain("anthropic");
		expect(script.indexOf("rm -rf ~/.omp/agent/sessions")).toBeLessThan(script.indexOf("start omp-collab-companion"));
	});

	test("the done-watcher is valid POSIX sh and posts to the shim", () => {
		const script = guestDoneWatcherScript();
		expect(Bun.spawnSync(["sh", "-n"], { stdin: new Blob([script]) }).exitCode).toBe(0);
		expect(script).toContain("curl -fsS -X POST http://127.0.0.1:4000/vm/done");
		expect(script).toContain("tmux ls -F '#{session_name}'");
		expect(guestDoneWatcherUnit()).toContain("ExecStart=%h/.omp-vm/done-watcher.sh");
	});
});

describe("done-watcher behaviour", () => {
	/** Runs the watcher against a fake clock, tmux, sleep and curl; returns the uptime at which it called /vm/done (null: never). */
	function run(opts: { startUptime: number; sessionUntil: number }): number | null {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vm-watch-"));
		try {
			const stub = (name: string, body: string) => {
				fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
			};
			fs.writeFileSync(path.join(dir, "uptime"), String(opts.startUptime));
			fs.writeFileSync(path.join(dir, "session_until"), String(opts.sessionUntil));
			// Each sleep advances the clock by 100 s (fewer processes than the real 10 s); the loop ends once curl ran or the clock passes 4000 s.
			stub(
				"sleep",
				`[ -e "$D/called" ] && exit 1\nup=$(cat "$D/uptime"); [ "$up" -gt 4000 ] && exit 1\necho $((up + 100)) > "$D/uptime"`,
			);
			// A companion session (omp-<8 hex>) exists until `session_until`; a session of the user's is always there.
			stub(
				"tmux",
				`if [ "$(cat "$D/uptime")" -lt "$(cat "$D/session_until")" ]; then echo omp-deadbeef; fi\necho notes`,
			);
			stub("curl", `cat "$D/uptime" > "$D/called"`);
			const script = guestDoneWatcherScript().replace("/proc/uptime", '"$D/uptime"');
			const result = Bun.spawnSync(["sh", "-c", script], {
				env: { PATH: `${dir}:/usr/bin:/bin`, D: dir },
				timeout: 20_000,
			});
			expect(result.exitCode).toBe(0);
			const called = path.join(dir, "called");
			return fs.existsSync(called) ? Number(fs.readFileSync(called, "utf8")) : null;
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}

	test("asks the host to delete the VM two minutes after its session ended", () => {
		// The session runs until uptime 300; the first poll without it is at 300, and 120 s of idleness is reached at 500.
		expect(run({ startUptime: 100, sessionUntil: 300 })).toBe(500);
	});

	test("asks after thirty minutes of uptime when no session ever started", () => {
		expect(run({ startUptime: 100, sessionUntil: 0 })).toBe(1800);
	});

	test("never asks while a session exists", () => {
		expect(run({ startUptime: 100, sessionUntil: 1_000_000 })).toBeNull();
	});
});

describe("parsePairUrl", () => {
	test("reads the link from the companion's --pair output", () => {
		const output = [
			"omp collab companion",
			"pair a device: scan the code or open https://ctrlc03.github.io/oh-my-pi/#pair=abc&k=def",
			"the code works once and expires in 10 minutes; the app's Devices screen makes new ones",
		].join("\n");
		expect(parsePairUrl(output)).toBe("https://ctrlc03.github.io/oh-my-pi/#pair=abc&k=def");
	});

	test("is null when the companion printed no link (a service-managed shell)", () => {
		expect(parsePairUrl("pair a device: run `omp companion --pair` in a terminal on this computer")).toBeNull();
	});
});
