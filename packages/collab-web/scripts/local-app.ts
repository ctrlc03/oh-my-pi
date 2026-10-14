/**
 * The collab web app, served by the companion's loopback relay (`./local-relay`) next to its websockets, so the
 * browser on this computer loads the app and talks to the relay over one origin: `http://127.0.0.1:<port>`.
 * No public relay, no GitHub Pages and no mixed content are involved, and an installed copy keeps working offline.
 *
 * This file is the serving rules; where the files come from is the caller's: a build directory the companion
 * made ({@link loadDirectoryBuild}, `./local-app-source`) or the files embedded in the release binary
 * ({@link loadEmbeddedBuild}, `./local-app-embedded`). Both reach the handler as an {@link AppBuild}: a map from
 * request path to file, so a request path is looked up, never joined onto a directory.
 *
 * - Only `GET`/`HEAD`. A path that tries to leave the app (`..`, an encoded slash or backslash, a NUL) is refused
 *   with 400 before any lookup; a path with no file is 404, except a browser navigation to an extensionless path,
 *   which gets `index.html` (the app routes in the URL fragment, but a reload or an installed launch may land anywhere).
 * - `index.html`, the service worker and everything not content-hashed revalidate (`no-cache` plus an ETag); a
 *   content-hashed bundle is `immutable`.
 * - A content-hashed bundle the current build lacks is served from `AppState.older` (the builds kept before it,
 *   newest first) when one has it, so a page open across a rebuild still loads its lazy chunks. Never the HTML or the
 *   service worker: a navigation always gets the current build. The release binary embeds one build, so it has none.
 * - Every response carries `nosniff`, `Referrer-Policy: no-referrer`, a Content-Security-Policy and
 *   `Cross-Origin-Resource-Policy: same-origin`. There is no CORS: no `Access-Control-*` header is ever sent.
 * - The caller has already checked that the request is addressed to a loopback host name (DNS rebinding).
 */
import * as path from "node:path";

/** Content types of what the build ships. A file with another extension is a build error, not octet-stream. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".webp": "image/webp",
	".woff2": "font/woff2",
	".txt": "text/plain; charset=utf-8",
	".xml": "application/xml; charset=utf-8",
};

/** Extensions worth gzipping; the rest is already compressed. */
const COMPRESSIBLE: ReadonlySet<string> = new Set([
	".html",
	".js",
	".css",
	".json",
	".webmanifest",
	".svg",
	".ico",
	".txt",
	".xml",
]);

/** Bun names bundles `[hash].[ext]`: eight lowercase base-36 characters at the root. Nothing else is immutable. */
const HASHED_RE = /^[a-z0-9]{8}\.[a-z0-9]+$/;

/** Whether `rel` is a content-hashed bundle (a chunk, a script or a stylesheet), which an older build may have named. */
function isHashedAsset(rel: string): boolean {
	return HASHED_RE.test(rel) && path.extname(rel) !== ".html";
}

/** One file of a build. */
export interface AppAsset {
	/** `Content-Type`. */
	type: string;
	/** Validator for revalidation: changes whenever the bytes do. */
	etag: string;
	/** The stored bytes are gzip; sent as such to a browser that accepts it, inflated for one that does not. */
	gzip: boolean;
	/** The stored bytes. */
	file: Blob;
}

/** A complete build of the app, served as it is. */
export interface AppBuild {
	/** Relative path (`index.html`, `excalidraw-assets/index.css`) to file. */
	assets: ReadonlyMap<string, AppAsset>;
	/** The Content-Security-Policy that goes with this build's `index.html`. */
	csp: string;
}

/** What {@link createLocalAppHandler} serves right now. */
export type AppState =
	| { kind: "ready"; build: AppBuild; older: readonly AppBuild[] }
	| { kind: "building" }
	| { kind: "failed" };

export function contentTypeOf(rel: string): string | undefined {
	const ext = path.extname(rel);
	return Object.hasOwn(CONTENT_TYPES, ext) ? CONTENT_TYPES[ext] : undefined;
}

export function isCompressible(rel: string): boolean {
	return COMPRESSIBLE.has(path.extname(rel));
}

/**
 * The Content-Security-Policy for a build. Pages sets none, so this is the narrowest policy the app runs under rather
 * than a copy of one: scripts are the app's own files plus the inline ones in `index.html` (by hash); relays are
 * reached over `ws:`/`wss:` (the public relay is any host the user configured, a local one is loopback); the pet
 * gallery is the only other host the app contacts. Excalidraw lists its CDN (esm.sh) after the app's own copy as the
 * second source of every font it registers, and the browser reports a source the policy blocks even when it never loads
 * it, so fonts alone may come from there.
 */
export function contentSecurityPolicy(indexHtml: string): string {
	const hashes = [...indexHtml.matchAll(/<script(?<attrs>[^>]*)>(?<body>[\s\S]*?)<\/script>/g)]
		.filter(
			match => !/\bsrc=/.test(match.groups!.attrs!) && !/\btype="application\/ld\+json"/.test(match.groups!.attrs!),
		)
		.map(match => `'sha256-${new Bun.CryptoHasher("sha256").update(match.groups!.body!).digest("base64")}'`);
	return [
		"default-src 'none'",
		`script-src 'self' 'wasm-unsafe-eval' ${hashes.join(" ")}`.trimEnd(),
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob: https://assets.petdex.dev",
		"font-src 'self' data: https://esm.sh",
		"connect-src 'self' ws://127.0.0.1:* ws://localhost:* wss: https://petdex.dev",
		"worker-src 'self' blob:",
		"manifest-src 'self'",
		"media-src 'self' blob: data:",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
		"frame-ancestors 'none'",
	].join("; ");
}

const NOT_AN_APP_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'";

/**
 * Reloads the building page. A `<meta http-equiv="refresh">` to the page's own URL does nothing while that URL has a
 * fragment (it counts as a same-document navigation), and the pairing link is all fragment. `location.reload()` keeps
 * the fragment and does reload; the meta tag stays inside `<noscript>` for a browser with scripts off.
 */
const RELOAD_SCRIPT = "setTimeout(() => location.reload(), 2000);";
const BUILDING_CSP = `default-src 'none'; script-src 'sha256-${new Bun.CryptoHasher("sha256").update(RELOAD_SCRIPT).digest("base64")}'; style-src 'unsafe-inline'; frame-ancestors 'none'`;

function securityHeaders(csp: string): Record<string, string> {
	return {
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy": "no-referrer",
		"Cross-Origin-Resource-Policy": "same-origin",
		"Content-Security-Policy": csp,
	};
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"]/g, ch => `&#${ch.charCodeAt(0)};`);
}

function statusPage(title: string, body: string, refresh: boolean): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
${refresh ? `<script>${RELOAD_SCRIPT}</script>\n<noscript><meta http-equiv="refresh" content="2"></noscript>\n` : ""}<title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:20vh auto;padding:0 1.5rem}h1{font-size:1.25rem}p{opacity:.75}</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(body)}</p>
</body>
</html>
`;
}

/**
 * Whether `request` is a browser loading a page: it asks for a document, and the path has no file extension. Anything
 * else (a script, an image, a `fetch`) that finds no file must see a 404, not an HTML page it would try to run.
 */
function isNavigation(request: Request, rel: string): boolean {
	if (path.extname(rel) !== "") return false;
	const mode = request.headers.get("sec-fetch-mode");
	if (mode !== null) return mode === "navigate";
	return (request.headers.get("accept") ?? "").includes("text/html");
}

/** The decoded request path without its leading slash, or null when it is not a path inside the app. */
function relativePath(pathname: string): string | null {
	// An encoded separator would decode into a path the lookup never meant; refuse instead of guessing.
	if (/%2f|%5c/i.test(pathname)) return null;
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return null;
	}
	if (decoded.includes("\0") || decoded.includes("\\") || !decoded.startsWith("/")) return null;
	const rel = decoded.slice(1);
	if (rel.split("/").some(segment => segment === ".." || segment === ".")) return null;
	return rel;
}

function plain(status: number, text: string, extra: Record<string, string> = {}): Response {
	return new Response(text, {
		status,
		headers: {
			...securityHeaders(NOT_AN_APP_CSP),
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "no-store",
			...extra,
		},
	});
}

function page(status: number, html: string, extra: Record<string, string> = {}, csp = NOT_AN_APP_CSP): Response {
	return new Response(html, {
		status,
		headers: {
			...securityHeaders(csp),
			"Content-Type": CONTENT_TYPES[".html"]!,
			"Cache-Control": "no-store",
			...extra,
		},
	});
}

async function serveAsset(request: Request, csp: string, rel: string, asset: AppAsset): Promise<Response> {
	const immutable = isHashedAsset(rel);
	const headers: Record<string, string> = {
		...securityHeaders(csp),
		"Content-Type": asset.type,
		"Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
		ETag: asset.etag,
	};
	if (asset.gzip) headers.Vary = "Accept-Encoding";
	if (request.headers.get("if-none-match") === asset.etag) return new Response(null, { status: 304, headers });
	const wantsGzip = /\bgzip\b/i.test(request.headers.get("accept-encoding") ?? "");
	if (asset.gzip && wantsGzip) {
		headers["Content-Encoding"] = "gzip";
		headers["Content-Length"] = String(asset.file.size);
		return new Response(request.method === "HEAD" ? null : asset.file, { headers });
	}
	if (asset.gzip) {
		const bytes = Bun.gunzipSync(new Uint8Array(await asset.file.arrayBuffer()));
		headers["Content-Length"] = String(bytes.byteLength);
		return new Response(request.method === "HEAD" ? null : bytes, { headers });
	}
	headers["Content-Length"] = String(asset.file.size);
	return new Response(request.method === "HEAD" ? null : asset.file, { headers });
}

/** The handler the relay calls for every request that is not a room upgrade. */
export function createLocalAppHandler(state: () => AppState): (request: Request) => Promise<Response> {
	return async request => {
		if (request.method !== "GET" && request.method !== "HEAD") {
			return plain(405, "method not allowed", { Allow: "GET, HEAD" });
		}
		const rel = relativePath(new URL(request.url).pathname);
		if (rel === null) return plain(400, "bad request path");
		const current = state();
		if (current.kind !== "ready") {
			const navigating = isNavigation(request, rel) || rel === "" || rel === "index.html";
			const retry = { "Retry-After": "2" };
			if (current.kind === "failed") {
				return navigating
					? page(
							503,
							statusPage(
								"The app could not be built",
								"The companion could not build the web app on this computer. Its log says why; restarting the companion tries again.",
								false,
							),
							retry,
						)
					: plain(503, "the app could not be built", retry);
			}
			return navigating
				? page(
						503,
						statusPage(
							"Building the app…",
							"The companion is building the web app for this computer. This page reloads by itself.",
							true,
						),
						retry,
						BUILDING_CSP,
					)
				: plain(503, "the app is being built", retry);
		}
		const { build, older } = current;
		const wanted = rel === "" ? "index.html" : rel;
		const asset = build.assets.get(wanted);
		if (asset !== undefined) return await serveAsset(request, build.csp, wanted, asset);
		// A page loaded from an older build asks for the lazy chunks that build named. Content-hashed names are never
		// reused for other bytes, so an older build's copy is the file the page wants; the HTML and the worker are not.
		if (isHashedAsset(wanted)) {
			for (const previous of older) {
				const kept = previous.assets.get(wanted);
				if (kept !== undefined) return await serveAsset(request, build.csp, wanted, kept);
			}
		}
		if (isNavigation(request, rel))
			return await serveAsset(request, build.csp, "index.html", build.assets.get("index.html")!);
		return plain(404, "not found");
	};
}

/** Index every file under `dir` (dotfiles skipped) as the build a request path maps to. */
export async function loadDirectoryBuild(dir: string): Promise<AppBuild> {
	const assets = new Map<string, AppAsset>();
	for await (const rel of new Bun.Glob("**/*").scan({ cwd: dir, onlyFiles: true })) {
		if (rel.split("/").some(segment => segment.startsWith("."))) continue;
		const type = contentTypeOf(rel);
		if (type === undefined) throw new Error(`no content type for ${rel}`);
		const file = Bun.file(path.join(dir, rel));
		assets.set(rel, {
			type,
			etag: `W/"${file.size.toString(36)}-${Math.trunc(file.lastModified).toString(36)}"`,
			gzip: false,
			file,
		});
	}
	return buildOf(assets);
}

/** A build from its files; reads `index.html` once for the Content-Security-Policy hashes. */
export async function buildOf(assets: ReadonlyMap<string, AppAsset>): Promise<AppBuild> {
	const index = assets.get("index.html");
	if (index === undefined) throw new Error("the build has no index.html");
	const bytes = new Uint8Array(await index.file.arrayBuffer());
	const html = new TextDecoder().decode(index.gzip ? Bun.gunzipSync(bytes) : bytes);
	return { assets, csp: contentSecurityPolicy(html) };
}

/** One file of the embedded app: where the binary keeps it and how it is stored. */
export interface EmbeddedAppFile {
	/** Request path, `excalidraw-assets/index.css`. */
	path: string;
	/** The file as bundled into the binary (`import … with { type: "file" }`). */
	file: string;
	gzip: boolean;
	etag: string;
}

export interface EmbeddedApp {
	files: EmbeddedAppFile[];
}

/** The app embedded in the binary, as a build served from memory-mapped binary data. */
export async function loadEmbeddedBuild(app: EmbeddedApp): Promise<AppBuild> {
	const assets = new Map<string, AppAsset>();
	for (const entry of app.files) {
		const type = contentTypeOf(entry.path);
		if (type === undefined) throw new Error(`no content type for ${entry.path}`);
		assets.set(entry.path, { type, etag: entry.etag, gzip: entry.gzip, file: Bun.file(entry.file) });
	}
	return buildOf(assets);
}
