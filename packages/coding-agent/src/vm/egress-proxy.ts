import * as dns from "node:dns";
import * as fs from "node:fs/promises";
import * as net from "node:net";

/**
 * HTTP proxy for `allowlist` VMs (docs/vm-sessions.md, "Network"). The VM's only route to the outside is this
 * proxy, reached through a QEMU `guestfwd` that connects to the unix socket below. It supports `CONNECT` tunnels
 * and absolute-form plain HTTP requests, on the allowed ports only, and refuses every destination that is not a
 * public address, whatever the policy.
 */

export type EgressPolicy = { mode: "allowlist"; hosts: string[] } | { mode: "public" };

/**
 * What a fork VM needs to provision itself and to work: GitHub, Ubuntu mirrors, the fork's installer host, the Sigstore
 * trust roots the installer's build-attestation check (`gh attestation verify`) fetches, and the common package
 * registries.
 */
export const DEFAULT_ALLOW_HOSTS: readonly string[] = [
	"github.com",
	"api.github.com",
	"codeload.github.com",
	"objects.githubusercontent.com",
	"release-assets.githubusercontent.com",
	"raw.githubusercontent.com",
	"ctrlc03.github.io",
	"cli.github.com",
	"tuf-repo.github.com",
	"tuf-repo-cdn.sigstore.dev",
	// GitHub's attestation bundles (signed, time-limited read URLs).
	"tmaproduction.blob.core.windows.net",
	"ports.ubuntu.com",
	"archive.ubuntu.com",
	"security.ubuntu.com",
	"*.ubuntu.com",
	"my.omp.sh",
	"registry.npmjs.org",
	"bun.sh",
	"crates.io",
	"index.crates.io",
	"static.crates.io",
	"static.rust-lang.org",
	"pypi.org",
	"files.pythonhosted.org",
];

export interface EgressProxyOptions {
	/** Unix socket to listen on (mode 0600; a stale file is replaced). */
	socketPath: string;
	policy: EgressPolicy;
	/** Destination ports the proxy connects to; default `[80, 443]`. */
	ports?: number[];
	log?: (message: string) => void;
	/** Host-side name resolution; default `dns.lookup`. Every returned address is vetted. */
	resolve?: (host: string) => Promise<string[]>;
	/** Opens the upstream connection to a vetted address; default `net.connect` (with `allowHalfOpen`). A test seam: the address has already passed the policy. */
	connect?: (address: string, port: number) => net.Socket;
}

const MAX_HEAD_BYTES = 64 * 1024;
const HEAD_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 15_000;

class Refusal extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

/** Lower-case, drop a trailing dot and the brackets of an IPv6 literal. */
function normalizeHost(host: string): string {
	let h = host.trim().toLowerCase();
	if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
	while (h.endsWith(".")) h = h.slice(0, -1);
	return h;
}

function hostAllowed(host: string, hosts: readonly string[]): boolean {
	for (const raw of hosts) {
		const entry = normalizeHost(raw);
		if (!entry) continue;
		if (entry.startsWith("*.")) {
			const suffix = entry.slice(1); // ".example.com"
			if (host.length > suffix.length && host.endsWith(suffix)) return true;
		} else if (host === entry) {
			return true;
		}
	}
	return false;
}

function parseIPv4(address: string): number[] | undefined {
	const parts = address.split(".");
	if (parts.length !== 4) return undefined;
	const octets: number[] = [];
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return undefined;
		const value = Number(part);
		if (value > 255) return undefined;
		octets.push(value);
	}
	return octets;
}

/** Expands an IPv6 address into its eight 16-bit groups. */
function parseIPv6(address: string): number[] | undefined {
	let text = address;
	const zone = text.indexOf("%");
	if (zone >= 0) text = text.slice(0, zone);
	const doubleColon = text.indexOf("::");
	if (doubleColon !== text.lastIndexOf("::")) return undefined;
	const [headText, tailText] =
		doubleColon >= 0 ? [text.slice(0, doubleColon), text.slice(doubleColon + 2)] : [text, ""];
	const expand = (part: string): number[] | undefined => {
		if (part === "") return [];
		const groups: number[] = [];
		const pieces = part.split(":");
		for (let i = 0; i < pieces.length; i++) {
			const piece = pieces[i];
			if (i === pieces.length - 1 && piece.includes(".")) {
				const v4 = parseIPv4(piece);
				if (!v4) return undefined;
				groups.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
			} else {
				if (!/^[0-9a-f]{1,4}$/i.test(piece)) return undefined;
				groups.push(Number.parseInt(piece, 16));
			}
		}
		return groups;
	};
	const head = expand(headText);
	const tail = expand(tailText);
	if (!head || !tail) return undefined;
	if (doubleColon < 0) return head.length === 8 ? head : undefined;
	const fill = 8 - head.length - tail.length;
	if (fill < 1) return undefined;
	return [...head, ...Array.from({ length: fill }, () => 0), ...tail];
}

function isBlockedIPv4([a, b, c]: number[]): boolean {
	if (a === 0) return true; // 0.0.0.0/8, unspecified
	if (a === 10) return true; // RFC 1918
	if (a === 127) return true; // loopback
	if (a === 169 && b === 254) return true; // link-local
	if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
	if (a === 192 && b === 168) return true; // RFC 1918
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
	if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
	if (a >= 224) return true; // multicast, reserved, broadcast
	return false;
}

/** Whether `address` is not a public unicast address (loopback, private, link-local, CGNAT, ULA, multicast, unspecified, or mapped forms of those). Unparseable input counts as blocked. */
export function isBlockedAddress(address: string): boolean {
	const kind = net.isIP(address.includes("%") ? address.slice(0, address.indexOf("%")) : address);
	if (kind === 4) {
		const octets = parseIPv4(address);
		return !octets || isBlockedIPv4(octets);
	}
	if (kind === 6) {
		const g = parseIPv6(address);
		if (!g) return true;
		const embedded = (hi: number, lo: number): number[] => [hi >> 8, hi & 255, lo >> 8, lo & 255];
		const leadingZero = g.slice(0, 5).every(x => x === 0);
		if (leadingZero && g[5] === 0xffff) return isBlockedIPv4(embedded(g[6], g[7])); // ::ffff:a.b.c.d
		if (leadingZero && g[5] === 0) return g[6] === 0 && g[7] <= 1 ? true : isBlockedIPv4(embedded(g[6], g[7])); // ::, ::1, ::a.b.c.d
		if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0))
			return isBlockedIPv4(embedded(g[6], g[7])); // NAT64
		if (g[0] === 0x2002) return isBlockedIPv4(embedded(g[1], g[2])); // 6to4
		if ((g[0] & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
		if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local
		if ((g[0] & 0xffc0) === 0xfec0) return true; // site-local (deprecated)
		if ((g[0] & 0xff00) === 0xff00) return true; // multicast
		return false;
	}
	return true;
}

async function defaultResolve(host: string): Promise<string[]> {
	const results = await dns.promises.lookup(host, { all: true, verbatim: true });
	return results.map(r => r.address);
}

interface Destination {
	host: string;
	port: number;
}

function parseAuthority(authority: string, defaultPort: number | undefined): Destination {
	let url: URL;
	try {
		url = new URL(`http://${authority}`);
	} catch {
		throw new Refusal(400, "bad target");
	}
	if (url.username || url.password || url.pathname !== "/" || url.search || url.hash)
		throw new Refusal(400, "bad target");
	const host = normalizeHost(url.hostname);
	if (!host) throw new Refusal(400, "bad target");
	// `new URL` drops the default port of `http:`, so recover it from the text.
	const explicit = /:(\d+)$/.exec(authority);
	const port = explicit ? Number(explicit[1]) : defaultPort;
	if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) throw new Refusal(400, "bad port");
	return { host, port };
}

interface ParsedHead {
	method: string;
	target: string;
	version: string;
	headers: Array<[string, string]>;
}

function parseHead(text: string): ParsedHead {
	const lines = text.split("\r\n");
	const match = /^([A-Za-z]+) (\S+) (HTTP\/1\.[01])$/.exec(lines[0]);
	if (!match) throw new Refusal(400, "bad request line");
	const headers: Array<[string, string]> = [];
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (line === "") continue;
		const colon = line.indexOf(":");
		if (colon <= 0) throw new Refusal(400, "bad header");
		headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
	}
	return { method: match[1].toUpperCase(), target: match[2], version: match[3], headers };
}

function respond(socket: net.Socket, status: number, message: string): void {
	const reason = status === 403 ? "Forbidden" : status === 400 ? "Bad Request" : "Bad Gateway";
	const body = `${message}\n`;
	socket.end(
		`HTTP/1.1 ${status} ${reason}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
	);
}

/**
 * Starts the proxy. Resolves once it is listening on `socketPath`.
 *
 * Policy order per request: port, then host name against the allowlist (`allowlist` mode only), then every
 * resolved address against the public-address rule (both modes). The proxy connects to the vetted address itself,
 * so a second lookup cannot return something else.
 */
export async function startEgressProxy(opts: EgressProxyOptions): Promise<{ close(): Promise<void> }> {
	const ports = new Set(opts.ports ?? [80, 443]);
	const log = opts.log ?? (() => {});
	const resolve = opts.resolve ?? defaultResolve;
	const policy = opts.policy;
	const allowHosts = policy.mode === "allowlist" ? policy.hosts : [];
	const sockets = new Set<net.Socket>();

	/** Throws `Refusal` unless the destination may be reached; returns the vetted addresses to try. */
	async function vet(dest: Destination): Promise<string[]> {
		if (!ports.has(dest.port)) throw new Refusal(403, `port ${dest.port} is not allowed`);
		if (policy.mode === "allowlist" && !hostAllowed(dest.host, allowHosts)) {
			throw new Refusal(403, `host ${dest.host} is not on the allowlist`);
		}
		let addresses: string[];
		if (net.isIP(dest.host)) {
			addresses = [dest.host];
		} else {
			try {
				addresses = await resolve(dest.host);
			} catch (error) {
				throw new Refusal(
					502,
					`cannot resolve ${dest.host}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			if (addresses.length === 0) throw new Refusal(502, `cannot resolve ${dest.host}`);
		}
		for (const address of addresses) {
			if (isBlockedAddress(address)) throw new Refusal(403, `${dest.host} resolves to a non-public address`);
		}
		return addresses;
	}

	function connectUpstream(addresses: string[], port: number): Promise<net.Socket> {
		const { promise, resolve: resolveSocket, reject } = Promise.withResolvers<net.Socket>();
		let index = 0;
		const attempt = (): void => {
			const address = addresses[index++];
			const upstream = opts.connect
				? opts.connect(address, port)
				: net.connect({ host: address, port, allowHalfOpen: true });
			upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy(new Error("connect timed out")));
			upstream.once("error", error => {
				upstream.destroy();
				if (index < addresses.length) attempt();
				else reject(error);
			});
			upstream.once("connect", () => {
				upstream.setTimeout(0);
				upstream.removeAllListeners("error");
				resolveSocket(upstream);
			});
		};
		attempt();
		return promise;
	}

	function bridge(client: net.Socket, upstream: net.Socket): void {
		sockets.add(upstream);
		const teardown = (): void => {
			client.destroy();
			upstream.destroy();
			sockets.delete(upstream);
		};
		client.on("error", teardown);
		upstream.on("error", teardown);
		client.on("close", teardown);
		upstream.on("close", teardown);
		client.pipe(upstream);
		upstream.pipe(client);
	}

	async function handle(client: net.Socket, head: string, rest: Buffer): Promise<void> {
		const request = parseHead(head);
		const label = `${request.method} ${request.target}`;
		try {
			if (request.method === "CONNECT") {
				const dest = parseAuthority(request.target, undefined);
				const addresses = await vet(dest);
				const upstream = await connectUpstream(addresses, dest.port).catch(error => {
					throw new Refusal(
						502,
						`cannot connect to ${dest.host}:${dest.port}: ${error instanceof Error ? error.message : String(error)}`,
					);
				});
				client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				if (rest.length > 0) upstream.write(rest);
				bridge(client, upstream);
				return;
			}
			let url: URL;
			try {
				url = new URL(request.target);
			} catch {
				throw new Refusal(400, "expected an absolute-form request target or CONNECT");
			}
			if (url.protocol !== "http:") throw new Refusal(400, "only http:// absolute-form targets are proxied");
			const authority = url.port ? `${url.hostname}:${url.port}` : url.hostname;
			const dest = parseAuthority(authority, 80);
			const addresses = await vet(dest);
			const upstream = await connectUpstream(addresses, dest.port).catch(error => {
				throw new Refusal(
					502,
					`cannot connect to ${dest.host}:${dest.port}: ${error instanceof Error ? error.message : String(error)}`,
				);
			});
			const upgrade = request.headers.some(([name]) => name.toLowerCase() === "upgrade");
			const lines = [`${request.method} ${url.pathname}${url.search} ${request.version}`, `Host: ${url.host}`];
			for (const [name, value] of request.headers) {
				const lower = name.toLowerCase();
				if (lower === "host" || lower.startsWith("proxy-")) continue;
				if (!upgrade && (lower === "connection" || lower === "keep-alive")) continue;
				lines.push(`${name}: ${value}`);
			}
			if (!upgrade) lines.push("Connection: close");
			upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
			if (rest.length > 0) upstream.write(rest);
			bridge(client, upstream);
		} catch (error) {
			if (error instanceof Refusal) {
				log(`egress ${error.status === 403 ? "refused" : "failed"} ${label}: ${error.message}`);
				respond(client, error.status, error.message);
				return;
			}
			throw error;
		}
	}

	const server = net.createServer({ allowHalfOpen: true }, client => {
		sockets.add(client);
		client.once("close", () => sockets.delete(client));
		client.on("error", () => client.destroy());
		let buffered = Buffer.alloc(0);
		const timer = setTimeout(() => client.destroy(), HEAD_TIMEOUT_MS);
		const onData = (chunk: Buffer): void => {
			buffered = Buffer.concat([buffered, chunk]);
			const end = buffered.indexOf("\r\n\r\n");
			if (end < 0) {
				if (buffered.length > MAX_HEAD_BYTES) {
					clearTimeout(timer);
					client.off("data", onData);
					respond(client, 400, "request head too large");
				}
				return;
			}
			clearTimeout(timer);
			client.off("data", onData);
			client.pause();
			const head = buffered.subarray(0, end).toString("latin1");
			const rest = buffered.subarray(end + 4);
			handle(client, head, rest)
				.then(() => client.resume())
				.catch(error => {
					if (error instanceof Refusal) {
						respond(client, error.status, error.message);
						return;
					}
					log(`egress error: ${error instanceof Error ? error.message : String(error)}`);
					client.destroy();
				});
		};
		client.on("data", onData);
		client.once("close", () => clearTimeout(timer));
	});

	await fs.rm(opts.socketPath, { force: true });
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(opts.socketPath, () => {
		server.off("error", listening.reject);
		listening.resolve();
	});
	await listening.promise;
	await fs.chmod(opts.socketPath, 0o600);

	return {
		async close(): Promise<void> {
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			for (const socket of sockets) socket.destroy();
			await closed.promise;
			await fs.rm(opts.socketPath, { force: true });
		},
	};
}
