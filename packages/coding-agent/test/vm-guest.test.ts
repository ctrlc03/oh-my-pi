import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type GuestProvisionOptions,
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
