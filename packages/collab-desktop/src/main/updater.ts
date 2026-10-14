/**
 * The self-updater's disk and network work: list releases, download the app and check its SHA-256 against the
 * release's `SHA256SUMS.txt` while streaming, unpack it beside the installed bundle, check what came out, and write
 * the script that swaps it in once this process has exited.
 *
 * Electron's own `autoUpdater` (Squirrel.Mac) refuses an app that is not signed with a Developer ID, which this one
 * never is, so the swap is done by a short shell script: after the app quits it moves the old bundle aside, moves the
 * new one into its place (a rename on one volume, so there is never a half-installed app), and puts the old one back
 * if that fails. The zip is never opened by anything but `ditto`, and nothing is moved until every check has passed.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { expectedSha256, selectUpdate, type UpdateOffer } from "./release";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const LISTING_TIMEOUT_MS = 30_000;
const CHECKSUMS_LIMIT = 256 * 1024;

/** The newest release newer than `current` that carries this platform's app, or undefined. */
export async function fetchOffer(input: {
	repo: string;
	current: string | null;
	platform: NodeJS.Platform;
	arch: string;
	fetch: Fetch;
}): Promise<UpdateOffer | undefined> {
	const response = await input.fetch(`https://api.github.com/repos/${input.repo}/releases?per_page=30`, {
		headers: { Accept: "application/vnd.github+json", "User-Agent": "omp-collab-desktop" },
		signal: AbortSignal.timeout(LISTING_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`GitHub answered ${response.status} listing the releases`);
	return selectUpdate(await response.json(), input);
}

export interface DownloadResult {
	sha256: string;
}

/**
 * Download `offer` to `dest`, refusing anything whose size or SHA-256 is not what the release says. The file is
 * written as `dest.part` and renamed only once it has verified, so `dest` is either absent or good.
 */
export async function downloadVerified(
	offer: UpdateOffer,
	dest: string,
	options: { fetch: Fetch; onProgress?: (received: number, total: number) => void },
): Promise<DownloadResult> {
	const sumsResponse = await options.fetch(offer.checksumsUrl, { signal: AbortSignal.timeout(LISTING_TIMEOUT_MS) });
	if (!sumsResponse.ok) throw new Error(`GitHub answered ${sumsResponse.status} for the checksums`);
	const sumsText = await sumsResponse.text();
	if (sumsText.length > CHECKSUMS_LIMIT) throw new Error("the checksums file is unreasonably large");
	const expected = expectedSha256(sumsText, offer.name, offer.githubSha256);

	const response = await options.fetch(offer.url, { redirect: "follow" });
	if (!response.ok || response.body === null) throw new Error(`GitHub answered ${response.status} for ${offer.name}`);
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	const part = `${dest}.part`;
	const hash = createHash("sha256");
	let received = 0;
	const file = await fs.promises.open(part, "w", 0o600);
	try {
		const reader = response.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			received += value.byteLength;
			if (received > offer.size) throw new Error(`${offer.name} is larger than the release says`);
			hash.update(value);
			await file.write(value);
			options.onProgress?.(received, offer.size);
		}
		await file.close();
		if (received !== offer.size)
			throw new Error(`${offer.name} is ${received} bytes, the release says ${offer.size}`);
		const actual = hash.digest("hex");
		if (actual !== expected)
			throw new Error(`checksum mismatch for ${offer.name}: expected ${expected}, got ${actual}`);
		fs.renameSync(part, dest);
		return { sha256: actual };
	} catch (err) {
		await file.close().catch(() => {});
		fs.rmSync(part, { force: true });
		throw err;
	}
}

export interface RunResult {
	code: number;
	out: string;
}
export type Run = (command: string, args: string[]) => Promise<RunResult>;

export interface StageExpectation {
	bundleId: string;
	tag: string;
}

/** A value of a plist file's top-level key, or null. */
async function plistValue(run: Run, plist: string, key: string): Promise<string | null> {
	const result = await run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist]);
	return result.code === 0 ? result.out.trim() : null;
}

/**
 * Unpack `zip` into `stagingDir` with `ditto` (which restores the bundle's symlinks and modes) and check the result is
 * the app: exactly one `.app`, our bundle identifier, built for the release's tag, and its signature intact. Returns
 * the path of the unpacked bundle. The staging directory is emptied first and left behind for the caller to remove.
 */
export async function stageUpdate(
	zip: string,
	stagingDir: string,
	expect: StageExpectation,
	run: Run,
): Promise<string> {
	fs.rmSync(stagingDir, { recursive: true, force: true });
	fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
	const unpacked = await run("/usr/bin/ditto", ["-x", "-k", zip, stagingDir]);
	if (unpacked.code !== 0) throw new Error(`could not unpack the update: ${unpacked.out.trim()}`);
	const bundles = fs.readdirSync(stagingDir).filter(name => name.endsWith(".app"));
	if (bundles.length !== 1) throw new Error(`the update holds ${bundles.length} apps, expected one`);
	const bundle = path.join(stagingDir, bundles[0]!);
	const plist = path.join(bundle, "Contents", "Info.plist");
	const id = await plistValue(run, plist, "CFBundleIdentifier");
	if (id !== expect.bundleId) throw new Error(`the update is not this app (bundle ${id ?? "unknown"})`);
	const tag = await plistValue(run, plist, "OmpBuildTag");
	if (tag !== expect.tag) throw new Error(`the update is build ${tag ?? "unknown"}, expected ${expect.tag}`);
	const signature = await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
	if (signature.code !== 0) throw new Error(`the update's signature is broken: ${signature.out.trim()}`);
	return bundle;
}

/** `value` as one single-quoted shell word. */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface SwapPlan {
	/** The running app's pid: the swap waits for it to exit. */
	pid: number;
	/** The installed bundle to replace. */
	bundle: string;
	/** The verified new bundle, on the same volume. */
	staged: string;
	/** The staging directory to remove afterwards. */
	stagingDir: string;
	/** Open the new app when done. */
	relaunch: boolean;
	/** Give up if the app is still running after this many seconds. */
	waitSeconds: number;
}

/** The shell script that swaps `staged` for `bundle` once `pid` has exited. */
export function swapScript(plan: SwapPlan): string {
	const q = shellQuote;
	return `#!/bin/sh
# Swaps the omp collab app for the downloaded update once the running app has quit. Written by the app itself.
PID=${Math.trunc(plan.pid)}
BUNDLE=${q(plan.bundle)}
STAGED=${q(plan.staged)}
STAGING=${q(plan.stagingDir)}
OLD="$BUNDLE.old"
waited=0
while kill -0 "$PID" 2>/dev/null; do
	waited=$((waited + 1))
	if [ "$waited" -gt ${plan.waitSeconds * 5} ]; then rm -rf "$STAGING"; exit 1; fi
	sleep 0.2
done
rm -rf "$OLD"
mv "$BUNDLE" "$OLD" || { rm -rf "$STAGING"; exit 1; }
if mv "$STAGED" "$BUNDLE"; then
	rm -rf "$OLD" "$STAGING"
	xattr -dr com.apple.quarantine "$BUNDLE" 2>/dev/null || true
${plan.relaunch ? '\topen "$BUNDLE"\n' : ""}else
	mv "$OLD" "$BUNDLE"
	rm -rf "$STAGING"
	exit 1
fi
`;
}
