/**
 * Live preview of a session's dev server, for the `preview` and `preview-targets` requests. The companion
 * screenshots a loopback page with a Chromium browser already on the computer (driven through puppeteer-core,
 * with real device emulation: the Chrome command line cannot size a window below ~500 CSS px on macOS) and lists
 * the dev servers the session's repository runs.
 *
 * Only loopback http(s) pages are captured: a paired device already controls everything, but this feature is
 * for local dev servers, so it never fetches arbitrary addresses on the computer's network.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Browser } from "puppeteer-core";
import { PREVIEW_SCALE, type PreviewShot, type PreviewTarget, type PreviewViewport } from "../src/lib/companion";
import { isInside, repoRoot } from "./companion-git";

/** Browser size in CSS pixels per viewport; phones and tablets are emulated as touch devices. */
export const VIEWPORTS: Record<PreviewViewport, { width: number; height: number; mobile: boolean }> = {
	phone: { width: 390, height: 844, mobile: true },
	tablet: { width: 820, height: 1180, mobile: true },
	desktop: { width: 1280, height: 800, mobile: false },
};
/** iOS Safari: dev servers and sites that pick a layout by user agent serve their mobile one. */
const MOBILE_UA =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
/** How long the page may take to load. */
const CAPTURE_TIMEOUT_MS = 20_000;
/** After `load`, wait this long for the network to go quiet (client-rendered apps fetch data on mount). */
const SETTLE_TIMEOUT_MS = 4_000;
const SETTLE_IDLE_MS = 500;
/** The warm browser closes after this long without a capture. */
const BROWSER_IDLE_MS = 120_000;
/** Largest image sent to the device; the relay caps frames well above this, with room for encryption. */
const MAX_IMAGE_BYTES = 1024 * 1024;
/** Full-page captures stop at this many CSS pixels tall. */
const MAX_FULL_PAGE_CSS_PX = 6_000;
const MAX_URL_CHARS = 2048;
const PROBE_TIMEOUT_MS = 5_000;
const LSOF_TIMEOUT_MS = 5_000;
/** JPEG quality tries, best first; the first one under {@link MAX_IMAGE_BYTES} is sent. */
const JPEG_QUALITIES = [80, 55, 35];

const CHROME_PATHS = [
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];
const CHROME_COMMANDS = [
	"google-chrome",
	"google-chrome-stable",
	"chromium",
	"chromium-browser",
	"brave-browser",
	"microsoft-edge",
];
const IPV4_LOOPBACK_RE = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export function isViewport(value: unknown): value is PreviewViewport {
	return typeof value === "string" && Object.hasOwn(VIEWPORTS, value);
}

/**
 * The normalized form of `value` when it is an http(s) URL on the loopback interface (`localhost`,
 * `*.localhost`, `127.0.0.0/8`, `[::1]`).
 * @throws Error naming what is wrong, for the device to show.
 */
export function checkPreviewUrl(value: unknown): string {
	if (typeof value !== "string" || value.length > MAX_URL_CHARS) throw new Error("Enter a valid URL.");
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error("Enter a valid URL.");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new Error("Only http and https pages can be previewed.");
	if (url.username !== "" || url.password !== "") throw new Error("The URL must not contain a username or password.");
	// The URL parser has already lower-cased the host and rewritten numeric forms (`127.1`, `2130706433`) to dotted quads.
	const host = url.hostname.replace(/\.$/, "");
	const loopback =
		host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || IPV4_LOOPBACK_RE.test(host);
	if (!loopback) {
		throw new Error("Only pages on this computer can be previewed: use localhost, 127.0.0.1 or [::1].");
	}
	return url.href;
}

/** Path of a Chromium-based browser on this computer, or null: `CHROME_PATH`, then the usual macOS apps, then PATH. */
export async function findChrome(env: Record<string, string | undefined> = process.env): Promise<string | null> {
	const candidates = [env.CHROME_PATH, ...CHROME_PATHS].filter((p): p is string => !!p);
	for (const candidate of candidates) if (await Bun.file(candidate).exists()) return candidate;
	for (const command of CHROME_COMMANDS) {
		const found = Bun.which(command);
		if (found !== null) return found;
	}
	return null;
}

/** Captures run one after another on the one warm browser: parallel loads would time each other out. */
let captureQueue: Promise<unknown> = Promise.resolve();
let browser: Browser | null = null;
let profileDir: string | null = null;
let idleTimer: Timer | undefined;

/**
 * Screenshot the loopback page `rawUrl` at `viewport` (the whole page, up to 6000 CSS px, when `fullPage`) with
 * the browser at `chrome`.
 * @throws Error when the URL is refused, nothing answers on it, the browser fails or takes over 20s, or the image is too big.
 */
export function capturePreview(
	chrome: string,
	rawUrl: unknown,
	viewport: PreviewViewport,
	fullPage: boolean,
): Promise<PreviewShot> {
	const run = captureQueue.then(() => capture(chrome, checkPreviewUrl(rawUrl), viewport, fullPage));
	captureQueue = run.catch(() => {});
	return run;
}

/** Close the warm browser and remove its profile (idle timeout, companion shutdown). */
export async function closePreviewBrowser(): Promise<void> {
	clearTimeout(idleTimer);
	const open = browser;
	const dir = profileDir;
	browser = null;
	profileDir = null;
	await open?.close().catch(() => {
		// Already gone.
	});
	if (dir !== null) await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

async function warmBrowser(chrome: string): Promise<Browser> {
	clearTimeout(idleTimer);
	if (browser?.connected) return browser;
	await closePreviewBrowser();
	// Loaded on the first preview only: puppeteer-core is large and probes the cwd while initializing,
	// which every companion start would otherwise pay for.
	const { default: puppeteer } = await import("puppeteer-core");
	profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-preview-"));
	browser = await puppeteer.launch({
		executablePath: chrome,
		headless: true,
		userDataDir: profileDir,
		// Dev servers on https use self-signed certificates.
		acceptInsecureCerts: true,
		timeout: CAPTURE_TIMEOUT_MS,
		args: ["--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--disable-extensions"],
	});
	browser.on("disconnected", () => {
		browser = null;
	});
	return browser;
}

function isLoopbackUrl(url: string): boolean {
	try {
		checkPreviewUrl(url);
		return true;
	} catch {
		return false;
	}
}

/** Fail fast with a useful message when nothing answers: a dead port otherwise costs the whole capture timeout. */
async function probe(url: string): Promise<void> {
	let location: string | null;
	try {
		const res = await fetch(url, {
			redirect: "manual",
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
			// Dev servers on https use self-signed certificates.
			tls: { rejectUnauthorized: false },
		});
		location = res.headers.get("location");
		void res.body?.cancel();
	} catch {
		throw new Error(`Nothing answered at ${url}. Is the dev server running?`);
	}
	// The browser would follow a redirect off this computer.
	if (location !== null) checkPreviewUrl(new URL(location, url).href);
}

async function capture(
	chrome: string,
	url: string,
	viewport: PreviewViewport,
	fullPage: boolean,
): Promise<PreviewShot> {
	await probe(url);
	const { width, height, mobile } = VIEWPORTS[viewport];
	const page = await (await warmBrowser(chrome)).newPage();
	try {
		await page.setViewport({ width, height, deviceScaleFactor: PREVIEW_SCALE, isMobile: mobile, hasTouch: mobile });
		if (mobile) await page.setUserAgent({ userAgent: MOBILE_UA });
		// The page itself may navigate (a client-side redirect): never off this computer.
		await page.setRequestInterception(true);
		page.on("request", request => {
			if (request.isNavigationRequest() && request.frame() === page.mainFrame() && !isLoopbackUrl(request.url())) {
				void request.abort("blockedbyclient");
			} else {
				void request.continue();
			}
		});
		try {
			await page.goto(url, { waitUntil: "load", timeout: CAPTURE_TIMEOUT_MS });
		} catch (err) {
			if (err instanceof Error && err.name === "TimeoutError") {
				throw new Error(`The page did not finish loading within ${CAPTURE_TIMEOUT_MS / 1000} seconds.`);
			}
			throw err;
		}
		await page.waitForNetworkIdle({ idleTime: SETTLE_IDLE_MS, timeout: SETTLE_TIMEOUT_MS }).catch(() => {
			// A page that keeps polling never goes idle: capture it as it is.
		});
		const pageHeight = fullPage
			? Math.min(
					MAX_FULL_PAGE_CSS_PX,
					Math.max(height, await page.evaluate(() => document.documentElement.scrollHeight)),
				)
			: height;
		const clip = { x: 0, y: 0, width, height: pageHeight };
		let size = 0;
		for (const quality of JPEG_QUALITIES) {
			const bytes = await page.screenshot({ type: "jpeg", quality, clip, captureBeyondViewport: fullPage });
			size = bytes.length;
			if (size > MAX_IMAGE_BYTES) continue;
			return {
				data: Buffer.from(bytes).toString("base64"),
				mimeType: "image/jpeg",
				width: width * PREVIEW_SCALE,
				height: pageHeight * PREVIEW_SCALE,
				url,
				at: Date.now(),
			};
		}
		throw new Error(
			`The screenshot is ${(size / (1024 * 1024)).toFixed(1)} MB, over the ${MAX_IMAGE_BYTES / (1024 * 1024)} MB limit.`,
		);
	} finally {
		await page.close().catch(() => {
			// The browser went away with it.
		});
		idleTimer = setTimeout(() => void closePreviewBrowser(), BROWSER_IDLE_MS);
	}
}

export interface Listener {
	pid: number;
	/** Process name, as `lsof` reports it (truncated to 9 characters on some systems). */
	command: string;
	port: number;
}

/** Addresses that `localhost` reaches: a listener on any other (LAN-only) address would not answer there. */
function listensOnLoopback(host: string): boolean {
	return host === "*" || host === "[::]" || host === "0.0.0.0" || host === "[::1]" || IPV4_LOOPBACK_RE.test(host);
}

/** `lsof` escapes unprintable bytes (and spaces) in names as `\xNN`. */
function unescapeLsof(text: string): string {
	return text.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/**
 * Listeners reachable on loopback from `lsof -nP -iTCP -sTCP:LISTEN -Fpcn`: field lines `p<pid>`, `c<command>`
 * then one `n<address:port>` per socket.
 */
export function parseListeners(output: string): Listener[] {
	const listeners: Listener[] = [];
	let pid = 0;
	let command = "";
	for (const line of output.split("\n")) {
		const value = line.slice(1);
		if (line.startsWith("p")) {
			pid = Number(value);
			command = "";
		} else if (line.startsWith("c")) {
			command = unescapeLsof(value);
		} else if (line.startsWith("n") && pid > 0) {
			const match = /^(.+):(\d+)$/.exec(value);
			if (match && listensOnLoopback(match[1]!)) listeners.push({ pid, command, port: Number(match[2]) });
		}
	}
	return listeners;
}

/** Working directory of each process from `lsof -a -p <pids> -d cwd -Fpn`. */
export function parseCwds(output: string): Map<number, string> {
	const cwds = new Map<number, string>();
	let pid = 0;
	for (const line of output.split("\n")) {
		if (line.startsWith("p")) pid = Number(line.slice(1));
		else if (line.startsWith("n") && pid > 0) cwds.set(pid, unescapeLsof(line.slice(1)));
	}
	return cwds;
}

async function lsof(args: string[]): Promise<string> {
	const lsofBin = Bun.which("lsof");
	if (lsofBin === null) throw new Error("lsof is not installed on this computer.");
	const proc = Bun.spawn([lsofBin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
	const timer = setTimeout(() => proc.kill(), LSOF_TIMEOUT_MS);
	try {
		// Exit code 1 means "nothing matched" as often as failure: the output decides.
		return await new Response(proc.stdout).text();
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Dev servers of the session: TCP listeners on loopback whose process runs inside the session's repository (its
 * folder outside one). `exclude` holds the pids of the companion and of omp itself. Sorted by port, one per port.
 */
export async function previewTargets(cwd: string, exclude: ReadonlySet<number>): Promise<PreviewTarget[]> {
	const root = (await repoRoot(cwd)) ?? (await fs.realpath(cwd));
	const listeners = parseListeners(await lsof(["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"])).filter(
		l => !exclude.has(l.pid),
	);
	if (listeners.length === 0) return [];
	const pids = [...new Set(listeners.map(l => l.pid))];
	const cwds = parseCwds(await lsof(["-a", "-p", pids.join(","), "-d", "cwd", "-Fpn"]));
	const byPort = new Map<number, PreviewTarget>();
	for (const { pid, command, port } of listeners) {
		const processCwd = cwds.get(pid);
		if (processCwd === undefined || !isInside(root, processCwd) || byPort.has(port)) continue;
		byPort.set(port, { url: `http://localhost:${port}/`, port, command });
	}
	return [...byPort.values()].sort((a, b) => a.port - b.port);
}
