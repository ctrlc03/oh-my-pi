import { afterEach, describe, expect, it } from "bun:test";
import {
	type AppAsset,
	type AppBuild,
	type AppState,
	buildOf,
	contentSecurityPolicy,
	createLocalAppHandler,
} from "../scripts/local-app";
import { type LocalRelay, startLocalRelay } from "../scripts/local-relay";

const INDEX_HTML = `<!doctype html><html><head><script type="application/ld+json">{"a":1}</script>
<script type="module" crossorigin src="./abcd1234.js"></script></head><body><script>document.title="theme"</script></body></html>`;

function asset(type: string, body: string | Uint8Array<ArrayBuffer>, gzip = false): AppAsset {
	return {
		type,
		etag: `"${type}-${typeof body === "string" ? body.length : body.byteLength}"`,
		gzip,
		file: new Blob([body]),
	};
}

async function sampleBuild(): Promise<AppBuild> {
	return await buildOf(
		new Map([
			["index.html", asset("text/html; charset=utf-8", INDEX_HTML)],
			["sw.js", asset("text/javascript; charset=utf-8", "self.skipWaiting()")],
			["abcd1234.js", asset("text/javascript; charset=utf-8", "console.log(1)")],
			["favicon.svg", asset("image/svg+xml", "<svg/>")],
			["excalidraw-assets/index.css", asset("text/css; charset=utf-8", "a{}")],
			["big.js", asset("text/javascript; charset=utf-8", Bun.gzipSync("x".repeat(500)), true)],
		]),
	);
}

async function handlerFor(state?: AppState): Promise<(request: Request) => Promise<Response>> {
	const resolved = state ?? { kind: "ready", build: await sampleBuild() };
	return createLocalAppHandler(() => resolved);
}

const get = (path: string, headers: Record<string, string> = {}, method = "GET"): Request =>
	new Request(`http://127.0.0.1:7467${path}`, { method, headers });

const NAVIGATE = { "sec-fetch-mode": "navigate", accept: "text/html,*/*" };

describe("serving the app", () => {
	it("serves index.html at the root and falls back to it only for browser navigations to extensionless paths", async () => {
		const handle = await handlerFor();
		const root = await handle(get("/"));
		expect(root.status).toBe(200);
		expect(await root.text()).toBe(INDEX_HTML);
		const deepNavigation = await handle(get("/some/where", NAVIGATE));
		expect(deepNavigation.status).toBe(200);
		expect(await deepNavigation.text()).toBe(INDEX_HTML);
		// Not a navigation: a script, a fetch, curl.
		expect((await handle(get("/some/where"))).status).toBe(404);
		expect((await handle(get("/some/where", { "sec-fetch-mode": "cors", accept: "text/html" }))).status).toBe(404);
		// A missing file is a 404 even for a navigation: the page would load HTML where it expected a script.
		expect((await handle(get("/missing.js", NAVIGATE))).status).toBe(404);
		expect((await handle(get("/excalidraw-assets/fonts/none.woff2", NAVIGATE))).status).toBe(404);
	});

	it("revalidates the shell and the service worker, and lets content-hashed bundles be cached forever", async () => {
		const handle = await handlerFor();
		expect((await handle(get("/"))).headers.get("cache-control")).toBe("no-cache");
		expect((await handle(get("/sw.js"))).headers.get("cache-control")).toBe("no-cache");
		expect((await handle(get("/favicon.svg"))).headers.get("cache-control")).toBe("no-cache");
		expect((await handle(get("/excalidraw-assets/index.css"))).headers.get("cache-control")).toBe("no-cache");
		expect((await handle(get("/abcd1234.js"))).headers.get("cache-control")).toBe(
			"public, max-age=31536000, immutable",
		);
		// Only a root file named like a bundle is immutable.
		const nested = await buildOf(
			new Map([
				["index.html", asset("text/html; charset=utf-8", INDEX_HTML)],
				["fonts/abcd1234.js", asset("text/javascript; charset=utf-8", "x")],
			]),
		);
		const response = await createLocalAppHandler(() => ({ kind: "ready", build: nested }))(get("/fonts/abcd1234.js"));
		expect(response.headers.get("cache-control")).toBe("no-cache");
	});

	it("answers a matching If-None-Match with 304 and serves HEAD without a body", async () => {
		const handle = await handlerFor();
		const first = await handle(get("/sw.js"));
		const etag = first.headers.get("etag")!;
		expect((await handle(get("/sw.js", { "if-none-match": etag }))).status).toBe(304);
		const head = await handle(get("/sw.js", {}, "HEAD"));
		expect(head.status).toBe(200);
		expect(await head.text()).toBe("");
		expect(head.headers.get("content-length")).toBe(String("self.skipWaiting()".length));
	});

	it("sends stored gzip to a client that accepts it and inflates it for one that does not", async () => {
		const handle = await handlerFor();
		const zipped = await handle(get("/big.js", { "accept-encoding": "gzip, br" }));
		expect(zipped.headers.get("content-encoding")).toBe("gzip");
		expect(zipped.headers.get("vary")).toBe("Accept-Encoding");
		const plain = await handle(get("/big.js", { "accept-encoding": "identity" }));
		expect(plain.headers.get("content-encoding")).toBeNull();
		expect(await plain.text()).toBe("x".repeat(500));
		expect(plain.headers.get("content-length")).toBe("500");
	});

	it("only answers GET and HEAD", async () => {
		const handle = await handlerFor();
		for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
			const response = await handle(get("/", {}, method));
			expect(response.status).toBe(405);
			expect(response.headers.get("allow")).toBe("GET, HEAD");
		}
	});

	it("refuses paths that try to leave the app", async () => {
		const handle = await handlerFor();
		for (const path of ["/%2e%2e%2fsecret", "/..%2f..%2fetc/passwd", "/a%5c..%5csecret", "/%00", "/%zz"]) {
			expect((await handle(get(path))).status).toBe(400);
		}
		// A dot segment, literal or percent-encoded, never reaches the handler: URL parsing resolves it inside the origin.
		expect((await handle(get("/../../etc/passwd"))).status).toBe(404);
		expect((await handle(get("/%2E%2E/%2e%2e/x.js"))).status).toBe(404);
	});

	it("sends hardening headers on every response and never a CORS header", async () => {
		const handle = await handlerFor();
		for (const response of [
			await handle(get("/")),
			await handle(get("/abcd1234.js")),
			await handle(get("/missing.js")),
			await handle(get("/", {}, "POST")),
			await handle(get("/%00")),
		]) {
			expect(response.headers.get("x-content-type-options")).toBe("nosniff");
			expect(response.headers.get("referrer-policy")).toBe("no-referrer");
			expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
			expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
			expect([...response.headers.keys()].filter(name => name.startsWith("access-control-"))).toEqual([]);
		}
		const preflight = await handle(
			get("/", { origin: "https://evil.example", "access-control-request-method": "GET" }, "OPTIONS"),
		);
		expect(preflight.status).toBe(405);
		expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
	});

	it("allows the app's own inline script by hash, and no other", () => {
		const csp = contentSecurityPolicy(INDEX_HTML);
		const hash = new Bun.CryptoHasher("sha256").update('document.title="theme"').digest("base64");
		expect(csp).toContain(`'sha256-${hash}'`);
		// The JSON-LD block and the external module are not inline scripts.
		expect(csp.match(/'sha256-/g)).toHaveLength(1);
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).not.toContain("'unsafe-eval'");
		expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
	});

	it("shows a page that reloads itself while the app is being built, never as a script or the service worker", async () => {
		const handle = await handlerFor({ kind: "building" });
		const page = await handle(get("/", NAVIGATE));
		expect(page.status).toBe(503);
		expect(page.headers.get("retry-after")).toBe("2");
		expect(page.headers.get("cache-control")).toBe("no-store");
		// location.reload() keeps the URL's fragment (the pairing link); a refresh meta tag to the same URL would not reload at all.
		const body = await page.text();
		expect(body).toContain("location.reload()");
		const script = body.match(/<script>(.*?)<\/script>/s)?.[1] ?? "";
		const hash = new Bun.CryptoHasher("sha256").update(script).digest("base64");
		expect(page.headers.get("content-security-policy")).toContain(`script-src 'sha256-${hash}'`);
		const worker = await handle(get("/sw.js"));
		expect(worker.status).toBe(503);
		expect(worker.headers.get("content-type")).toContain("text/plain");
		// The update check fetches "./" without asking for a document: it must not take a "building" page for a new version.
		const check = await handle(get("/", { accept: "*/*" }));
		expect(check.status).toBe(503);
	});

	it("says so, without reloading, when the build failed", async () => {
		const handle = await handlerFor({ kind: "failed" });
		const page = await handle(get("/", NAVIGATE));
		expect(page.status).toBe(503);
		expect(await page.text()).not.toContain("http-equiv");
	});
});

describe("the relay serving the app", () => {
	let relay: LocalRelay | null = null;
	afterEach(() => {
		relay?.stop();
		relay = null;
	});

	async function start(options: { allowedOrigins?: readonly string[] } = {}): Promise<string> {
		const handle = await handlerFor();
		relay = startLocalRelay(0, { ...options, app: handle });
		return relay.url.replace(/^ws:/, "http:");
	}

	it("serves the app over HTTP on the relay's port, and 404s other paths without an app", async () => {
		const base = await start();
		const response = await fetch(`${base}/`);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(INDEX_HTML);
		relay?.stop();
		relay = startLocalRelay(0);
		expect((await fetch(`${relay.url.replace(/^ws:/, "http:")}/`)).status).toBe(404);
	});

	it("applies the loopback Host check to the app too", async () => {
		const base = await start();
		const rebound = await fetch(`${base}/`, { headers: { host: "attacker.example:80" } });
		expect(rebound.status).toBe(403);
		expect(await rebound.text()).not.toContain("<html");
		const named = await fetch(`${base}/`, { headers: { host: `localhost:${new URL(base).port}` } });
		expect(named.status).toBe(200);
	});

	it("lets a page it served join rooms as a guest, and still refuses foreign origins and any browser host", async () => {
		const base = await start({ allowedOrigins: ["https://pages.example"] });
		const port = new URL(base).port;
		const room = "AppRoom_1234567";
		const guestFrom = (origin: string) => fetch(`${base}/r/${room}?role=guest`, { headers: { origin } });
		// 426: past the origin check, waiting for a websocket upgrade.
		expect((await guestFrom(`http://127.0.0.1:${port}`)).status).toBe(426);
		expect((await guestFrom(`http://localhost:${port}`)).status).toBe(426);
		expect((await guestFrom("https://pages.example")).status).toBe(426);
		expect((await guestFrom("https://evil.example")).status).toBe(403);
		// Another loopback port is another app.
		expect((await guestFrom(`http://127.0.0.1:${Number(port) + 1}`)).status).toBe(403);
		const host = await fetch(`${base}/r/${room}?role=host`, { headers: { origin: `http://127.0.0.1:${port}` } });
		expect(host.status).toBe(403);
	});

	it("does not widen the origins of a relay that serves no app", async () => {
		relay = startLocalRelay(0, { allowedOrigins: ["https://pages.example"] });
		const base = relay.url.replace(/^ws:/, "http:");
		const port = new URL(base).port;
		const response = await fetch(`${base}/r/AppRoom_1234567?role=guest`, {
			headers: { origin: `http://127.0.0.1:${port}` },
		});
		expect(response.status).toBe(403);
	});
});
