import { describe, expect, test } from "bun:test";
import {
	type GuestProvisionOptions,
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
