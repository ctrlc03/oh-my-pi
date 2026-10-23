import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_ALLOW_HOSTS, type EgressPolicy, isBlockedAddress, startEgressProxy } from "../src/vm/egress-proxy";

const PUBLIC_IP = "93.184.216.34";

let dir: string;
let origin: net.Server;
let originPort: number;
const originRequests: string[] = [];
const closers: Array<() => Promise<void>> = [];
const connectedTo: Array<{ address: string; port: number }> = [];

beforeEach(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "egp-"));
	originRequests.length = 0;
	connectedTo.length = 0;
	// Origin: answers any HTTP request with a fixed body; after a CONNECT tunnel it echoes bytes uppercased.
	origin = net.createServer(socket => {
		socket.on("error", () => {});
		socket.once("data", first => {
			const text = first.toString("latin1");
			if (text.startsWith("GET ") || text.startsWith("POST ")) {
				originRequests.push(text);
				socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
				return;
			}
			socket.write(first.toString().toUpperCase());
			socket.on("data", chunk => socket.write(chunk.toString().toUpperCase()));
		});
	});
	await new Promise<void>(resolve => origin.listen(0, "127.0.0.1", resolve));
	originPort = (origin.address() as net.AddressInfo).port;
});

afterEach(async () => {
	for (const close of closers.splice(0)) await close();
	await new Promise<void>(resolve => origin.close(() => resolve()));
	fs.rmSync(dir, { recursive: true, force: true });
});

async function start(
	policy: EgressPolicy,
	table: Record<string, string[]>,
	extra: { ports?: number[]; log?: (m: string) => void } = {},
): Promise<string> {
	const socketPath = path.join(dir, "p.sock");
	const proxy = await startEgressProxy({
		socketPath,
		policy,
		ports: extra.ports,
		log: extra.log,
		resolve: async host => {
			const addresses = table[host];
			if (!addresses) throw new Error("NXDOMAIN");
			return addresses;
		},
		// The origin is on loopback, which the policy forbids as a destination; the test redirects the vetted
		// address to it and records what the proxy decided to connect to.
		connect: (address, port) => {
			connectedTo.push({ address, port });
			return net.connect({ host: "127.0.0.1", port: originPort, allowHalfOpen: true });
		},
	});
	closers.push(() => proxy.close());
	return socketPath;
}

/** Sends `request`, optionally keeps talking, and returns everything the proxy sends until it closes (or `until` matches). */
async function exchange(socketPath: string, request: string, until?: RegExp): Promise<string> {
	const socket = net.connect(socketPath);
	let received = "";
	const done = Promise.withResolvers<string>();
	socket.on("data", chunk => {
		received += chunk.toString("latin1");
		if (until?.test(received)) {
			socket.destroy();
			done.resolve(received);
		}
	});
	socket.on("close", () => done.resolve(received));
	socket.on("error", () => done.resolve(received));
	socket.write(request);
	return done.promise;
}

function status(response: string): number {
	return Number(/^HTTP\/1\.[01] (\d{3})/.exec(response)?.[1]);
}

describe("egress proxy policy", () => {
	test("allowed CONNECT tunnels bytes both ways to the vetted address", async () => {
		const socketPath = await start({ mode: "allowlist", hosts: ["example.test"] }, { "example.test": [PUBLIC_IP] });
		const tunnel = await Conversation.open(socketPath);
		tunnel.socket.write("CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n\r\n");
		expect(status(await tunnel.until(/\r\n\r\n/))).toBe(200);
		tunnel.received = "";
		tunnel.socket.write("hello tunnel");
		expect(await tunnel.until(/HELLO TUNNEL/)).toBe("HELLO TUNNEL");
		tunnel.socket.write(" again");
		expect(await tunnel.until(/AGAIN/)).toBe("HELLO TUNNEL AGAIN");
		tunnel.socket.destroy();
		expect(connectedTo).toEqual([{ address: PUBLIC_IP, port: 443 }]);
	});

	test("bytes sent right after the CONNECT head reach the origin", async () => {
		const socketPath = await start({ mode: "public" }, { "example.test": [PUBLIC_IP] });
		const response = await exchange(socketPath, "CONNECT example.test:443 HTTP/1.1\r\n\r\nearly", /EARLY/);
		expect(response).toContain("EARLY");
	});

	test("a host that is not on the allowlist gets 403 and no connection is attempted", async () => {
		const logs: string[] = [];
		const socketPath = await start(
			{ mode: "allowlist", hosts: ["example.test"] },
			{ "example.test": [PUBLIC_IP], "evil.test": [PUBLIC_IP] },
			{ log: m => logs.push(m) },
		);
		const response = await exchange(socketPath, "CONNECT evil.test:443 HTTP/1.1\r\n\r\n");
		expect(status(response)).toBe(403);
		expect(response).toContain("allowlist");
		expect(connectedTo).toEqual([]);
		expect(logs.some(l => l.includes("evil.test"))).toBe(true);
	});

	test("wildcard entries match subdomains only; case and trailing dot are ignored", async () => {
		const socketPath = await start(
			{ mode: "allowlist", hosts: ["*.Example.Test", "exact.test."] },
			{
				"a.example.test": [PUBLIC_IP],
				"example.test": [PUBLIC_IP],
				"badexample.test": [PUBLIC_IP],
				"exact.test": [PUBLIC_IP],
			},
		);
		const sub = await exchange(socketPath, "CONNECT A.EXAMPLE.TEST.:443 HTTP/1.1\r\n\r\n", /\r\n\r\n/);
		expect(status(sub)).toBe(200);
		expect(status(await exchange(socketPath, "CONNECT example.test:443 HTTP/1.1\r\n\r\n"))).toBe(403);
		expect(status(await exchange(socketPath, "CONNECT badexample.test:443 HTTP/1.1\r\n\r\n"))).toBe(403);
		const exact = await exchange(socketPath, "CONNECT exact.test:443 HTTP/1.1\r\n\r\n", /\r\n\r\n/);
		expect(status(exact)).toBe(200);
	});

	test.each([
		["127.0.0.1"],
		["10.1.2.3"],
		["169.254.169.254"],
		["::1"],
		["::ffff:127.0.0.1"],
		["::ffff:7f00:1"],
		["192.168.0.5"],
		["172.20.0.1"],
		["100.64.0.1"],
		["fd00::1"],
		["fe80::1"],
		["224.0.0.1"],
		["0.0.0.0"],
	])("an allowed name resolving to %s is refused", async address => {
		const socketPath = await start({ mode: "allowlist", hosts: ["internal.test"] }, { "internal.test": [address] });
		const response = await exchange(socketPath, "CONNECT internal.test:443 HTTP/1.1\r\n\r\n");
		expect(status(response)).toBe(403);
		expect(response).toContain("non-public");
		expect(connectedTo).toEqual([]);
	});

	test("one private address among public ones refuses the whole name", async () => {
		const socketPath = await start({ mode: "public" }, { "mixed.test": [PUBLIC_IP, "10.0.0.1"] });
		expect(status(await exchange(socketPath, "CONNECT mixed.test:443 HTTP/1.1\r\n\r\n"))).toBe(403);
		expect(connectedTo).toEqual([]);
	});

	test("a port outside the list is refused", async () => {
		const socketPath = await start({ mode: "public" }, { "example.test": [PUBLIC_IP] });
		expect(status(await exchange(socketPath, "CONNECT example.test:22 HTTP/1.1\r\n\r\n"))).toBe(403);
		expect(
			status(
				await exchange(socketPath, "GET http://example.test:8080/ HTTP/1.1\r\nHost: example.test:8080\r\n\r\n"),
			),
		).toBe(403);
		expect(connectedTo).toEqual([]);
	});

	test("custom ports replace the defaults", async () => {
		const socketPath = await start({ mode: "public" }, { "example.test": [PUBLIC_IP] }, { ports: [8443] });
		expect(status(await exchange(socketPath, "CONNECT example.test:443 HTTP/1.1\r\n\r\n"))).toBe(403);
		expect(status(await exchange(socketPath, "CONNECT example.test:8443 HTTP/1.1\r\n\r\n", /\r\n\r\n/))).toBe(200);
	});

	test("IP literals follow the same address rules, and must be listed in allowlist mode", async () => {
		const listed = await start({ mode: "allowlist", hosts: [PUBLIC_IP, "127.0.0.1", "[::1]"] }, {});
		expect(status(await exchange(listed, `CONNECT ${PUBLIC_IP}:443 HTTP/1.1\r\n\r\n`, /\r\n\r\n/))).toBe(200);
		expect(status(await exchange(listed, "CONNECT 127.0.0.1:443 HTTP/1.1\r\n\r\n"))).toBe(403);
		expect(status(await exchange(listed, "CONNECT [::1]:443 HTTP/1.1\r\n\r\n"))).toBe(403);
		expect(status(await exchange(listed, "CONNECT 8.8.8.8:443 HTTP/1.1\r\n\r\n"))).toBe(403);
		expect(connectedTo).toEqual([{ address: PUBLIC_IP, port: 443 }]);
	});

	test("alternative IPv4 spellings of loopback cannot get around the rules", async () => {
		const socketPath = await start({ mode: "public" }, {});
		for (const host of ["2130706433", "0x7f.0.0.1", "127.1", "0177.0.0.1"]) {
			const response = await exchange(socketPath, `CONNECT ${host}:443 HTTP/1.1\r\n\r\n`);
			expect(status(response)).toBe(403);
		}
		expect(connectedTo).toEqual([]);
	});

	test("public mode allows any name that resolves to public addresses only", async () => {
		const socketPath = await start(
			{ mode: "public" },
			{ "anything.test": [PUBLIC_IP], "lan.test": ["192.168.1.10"], "loop.test": ["127.0.0.1"] },
		);
		expect(status(await exchange(socketPath, "CONNECT anything.test:443 HTTP/1.1\r\n\r\n", /\r\n\r\n/))).toBe(200);
		expect(status(await exchange(socketPath, "CONNECT lan.test:443 HTTP/1.1\r\n\r\n"))).toBe(403);
		expect(status(await exchange(socketPath, "CONNECT loop.test:443 HTTP/1.1\r\n\r\n"))).toBe(403);
	});

	test("a name that does not resolve answers 502", async () => {
		const socketPath = await start({ mode: "public" }, {});
		expect(status(await exchange(socketPath, "CONNECT nowhere.test:443 HTTP/1.1\r\n\r\n"))).toBe(502);
	});
});

describe("egress proxy plain HTTP", () => {
	test("absolute-form requests are forwarded in origin form with the proxy headers removed", async () => {
		const socketPath = await start({ mode: "allowlist", hosts: ["example.test"] }, { "example.test": [PUBLIC_IP] });
		const response = await exchange(
			socketPath,
			"GET http://example.test/a/b?c=1 HTTP/1.1\r\nHost: other.test\r\nProxy-Connection: keep-alive\r\nProxy-Authorization: Basic eA==\r\nConnection: keep-alive\r\nX-Test: 1\r\n\r\n",
		);
		expect(status(response)).toBe(200);
		expect(response.endsWith("ok")).toBe(true);
		expect(connectedTo).toEqual([{ address: PUBLIC_IP, port: 80 }]);
		expect(originRequests).toHaveLength(1);
		const forwarded = originRequests[0];
		expect(forwarded.startsWith("GET /a/b?c=1 HTTP/1.1\r\n")).toBe(true);
		expect(forwarded).toContain("Host: example.test\r\n");
		expect(forwarded).toContain("X-Test: 1\r\n");
		expect(forwarded).toContain("Connection: close\r\n");
		expect(forwarded.toLowerCase()).not.toContain("proxy-");
		expect(forwarded).not.toContain("other.test");
	});

	test("a request body follows the head", async () => {
		const socketPath = await start({ mode: "public" }, { "example.test": [PUBLIC_IP] });
		const response = await exchange(
			socketPath,
			"POST http://example.test:80/x HTTP/1.1\r\nHost: example.test\r\nContent-Length: 4\r\n\r\nbody",
		);
		expect(status(response)).toBe(200);
		expect(originRequests[0].endsWith("\r\n\r\nbody")).toBe(true);
	});

	test("plain HTTP to a host off the list or on a private address is refused", async () => {
		const socketPath = await start(
			{ mode: "allowlist", hosts: ["example.test", "lan.test"] },
			{ "example.test": [PUBLIC_IP], "lan.test": ["10.0.0.7"], "evil.test": [PUBLIC_IP] },
		);
		expect(status(await exchange(socketPath, "GET http://evil.test/ HTTP/1.1\r\n\r\n"))).toBe(403);
		expect(status(await exchange(socketPath, "GET http://lan.test/ HTTP/1.1\r\n\r\n"))).toBe(403);
		expect(status(await exchange(socketPath, "GET http://127.0.0.1/ HTTP/1.1\r\n\r\n"))).toBe(403);
		expect(connectedTo).toEqual([]);
	});

	test("origin-form and https:// targets are rejected", async () => {
		const socketPath = await start({ mode: "public" }, { "example.test": [PUBLIC_IP] });
		expect(status(await exchange(socketPath, "GET / HTTP/1.1\r\nHost: example.test\r\n\r\n"))).toBe(400);
		expect(status(await exchange(socketPath, "GET https://example.test/ HTTP/1.1\r\n\r\n"))).toBe(400);
		expect(status(await exchange(socketPath, "garbage\r\n\r\n"))).toBe(400);
	});
});

describe("egress proxy socket", () => {
	test("listens with mode 0600, replaces a stale socket file, and removes it on close", async () => {
		const socketPath = path.join(dir, "p.sock");
		fs.writeFileSync(socketPath, "stale");
		const proxy = await startEgressProxy({ socketPath, policy: { mode: "public" } });
		expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
		expect(fs.statSync(socketPath).isSocket()).toBe(true);
		await proxy.close();
		expect(fs.existsSync(socketPath)).toBe(false);
	});
});

describe("address rules", () => {
	test.each([
		"8.8.8.8",
		"1.1.1.1",
		"172.32.0.1",
		"100.128.0.1",
		"2606:4700:4700::1111",
		"::ffff:8.8.8.8",
		"2001:db8::1",
	])("%s is public", address => {
		expect(isBlockedAddress(address)).toBe(false);
	});

	test.each([
		"not-an-ip",
		"::",
		"::0:1",
		"64:ff9b::7f00:1",
		"2002:7f00:1::1",
		"fc00::1",
		"fdff::1",
		"ff02::1",
		"255.255.255.255",
	])("%s is refused", address => {
		expect(isBlockedAddress(address)).toBe(true);
	});
});

describe("DEFAULT_ALLOW_HOSTS", () => {
	test("covers what provisioning needs", () => {
		for (const host of [
			"github.com",
			"api.github.com",
			"ctrlc03.github.io",
			"ports.ubuntu.com",
			"registry.npmjs.org",
			"my.omp.sh",
		]) {
			expect(DEFAULT_ALLOW_HOSTS).toContain(host);
		}
	});
});

/** A connected client that accumulates what the proxy sends and lets a test await a pattern in it. */
class Conversation {
	received = "";
	#waiters: Array<{ pattern: RegExp; resolve: (text: string) => void }> = [];

	private constructor(readonly socket: net.Socket) {
		socket.on("data", chunk => {
			this.received += chunk.toString("latin1");
			this.#waiters = this.#waiters.filter(w => {
				if (!w.pattern.test(this.received)) return true;
				w.resolve(this.received);
				return false;
			});
		});
	}

	static async open(socketPath: string): Promise<Conversation> {
		const socket = net.connect(socketPath);
		await new Promise<void>(resolve => socket.once("connect", resolve));
		return new Conversation(socket);
	}

	until(pattern: RegExp): Promise<string> {
		if (pattern.test(this.received)) return Promise.resolve(this.received);
		const { promise, resolve } = Promise.withResolvers<string>();
		this.#waiters.push({ pattern, resolve });
		return promise;
	}
}
