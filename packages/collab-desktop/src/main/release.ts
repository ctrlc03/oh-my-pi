/**
 * Release selection for the app's self-updater: which GitHub release is newer than this build, which file in it is
 * this platform's app, and what its checksum must be. Pure functions over GitHub's release listing, as
 * `fork-release.ts` in the coding agent is for `omp update`; the network and the disk are in `updater.ts`.
 *
 * Releases are tagged `collab-v<semver>-<n>` (`<semver>` is the coding agent's version, `<n>` counts releases of it)
 * and the app is attached to the same release as the `omp` binaries, as `collab-desktop-<os>-<arch>.zip`, with its
 * checksum in the release's `SHA256SUMS.txt`.
 */

import { isRecord } from "./guards";

/** The release tag shape; the same pattern the installer and `omp update` use. */
export const FORK_TAG_PATTERN = /^collab-v(\d+)\.(\d+)\.(\d+)-(\d+)$/;

export interface ForkTag {
	tag: string;
	parts: readonly [number, number, number];
	/** Build counter after the version. */
	build: number;
}

export function parseTag(tag: string): ForkTag | null {
	const match = FORK_TAG_PATTERN.exec(tag);
	if (match === null) return null;
	const [major, minor, patch, build] = [match[1], match[2], match[3], match[4]].map(Number) as [
		number,
		number,
		number,
		number,
	];
	return { tag, parts: [major, minor, patch], build };
}

/** Negative when `a` is older than `b`: version first, then the build counter. */
export function compareTags(a: ForkTag, b: ForkTag): number {
	for (let i = 0; i < 3; i++) {
		const diff = a.parts[i]! - b.parts[i]!;
		if (diff !== 0) return diff;
	}
	return a.build - b.build;
}

/** Whether `release` is newer than `current`. A build with no tag (a development build) is older than every release. */
export function isNewer(release: string, current: string | null): boolean {
	const next = parseTag(release);
	if (next === null) return false;
	const now = current === null ? null : parseTag(current);
	return now === null || compareTags(next, now) > 0;
}

/** The file name of the app for a platform, or null where the app has no self-updating release. */
export function desktopAssetName(platform: NodeJS.Platform, arch: string): string | null {
	if (platform !== "darwin") return null;
	if (arch !== "arm64" && arch !== "x64") return null;
	return `collab-desktop-darwin-${arch}.zip`;
}

export const CHECKSUMS_NAME = "SHA256SUMS.txt";

export interface UpdateOffer {
	tag: string;
	name: string;
	url: string;
	size: number;
	/** The digest GitHub computed for the asset, lowercase hex; null when the listing has none. */
	githubSha256: string | null;
	checksumsUrl: string;
}

function assetOf(release: Record<string, unknown>, name: string): Record<string, unknown> | null {
	if (!Array.isArray(release.assets)) return null;
	const matches = release.assets.filter(asset => isRecord(asset) && asset.name === name);
	if (matches.length !== 1) return null;
	const asset = matches[0] as Record<string, unknown>;
	return asset.state === "uploaded" ? asset : null;
}

/**
 * The newest published release of `repo` that is newer than `current` and carries this platform's app and the
 * checksums file, with download URLs that are GitHub's own for that release (a listing that names another host is
 * refused). Undefined when there is none, including when the platform has no self-updating app.
 */
export function selectUpdate(
	releases: unknown,
	input: { current: string | null; repo: string; platform: NodeJS.Platform; arch: string },
): UpdateOffer | undefined {
	const name = desktopAssetName(input.platform, input.arch);
	if (name === null || !Array.isArray(releases)) return undefined;
	let best: { tag: ForkTag; offer: UpdateOffer } | undefined;
	for (const release of releases) {
		if (!isRecord(release) || release.draft !== false || release.prerelease !== false) continue;
		if (typeof release.tag_name !== "string") continue;
		const tag = parseTag(release.tag_name);
		if (tag === null || !isNewer(tag.tag, input.current)) continue;
		if (best !== undefined && compareTags(tag, best.tag) <= 0) continue;
		const app = assetOf(release, name);
		const sums = assetOf(release, CHECKSUMS_NAME);
		if (app === null || sums === null) continue;
		const base = `https://github.com/${input.repo}/releases/download/${tag.tag}`;
		if (app.browser_download_url !== `${base}/${name}` || sums.browser_download_url !== `${base}/${CHECKSUMS_NAME}`)
			continue;
		const size = app.size;
		if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) continue;
		const digest = typeof app.digest === "string" ? /^sha256:([0-9a-f]{64})$/i.exec(app.digest)?.[1] : undefined;
		best = {
			tag,
			offer: {
				tag: tag.tag,
				name,
				url: `${base}/${name}`,
				size,
				githubSha256: digest === undefined ? null : digest.toLowerCase(),
				checksumsUrl: `${base}/${CHECKSUMS_NAME}`,
			},
		};
	}
	return best?.offer;
}

/** The `<sha256>  <name>` lines of a checksums file, by name; a line that is not one is skipped. */
export function parseChecksums(text: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const line of text.split("\n")) {
		const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
		if (match !== null) out.set(match[2]!, match[1]!.toLowerCase());
	}
	return out;
}

/**
 * The checksum the download must have: the one in `SHA256SUMS.txt`, which must exist, and which must agree with the
 * digest GitHub computed for the asset when the listing has one. Throws when they disagree or the file lists none.
 */
export function expectedSha256(checksums: string, name: string, githubSha256: string | null): string {
	const listed = parseChecksums(checksums).get(name);
	if (listed === undefined) throw new Error(`${CHECKSUMS_NAME} has no entry for ${name}`);
	if (githubSha256 !== null && githubSha256 !== listed) {
		throw new Error(`${CHECKSUMS_NAME} and GitHub disagree about the checksum of ${name}`);
	}
	return listed;
}

/** The `.app` directory a macOS executable path lives in, or null when it is not inside one. */
export function bundlePathFromExe(exe: string): string | null {
	const match = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(exe);
	return match?.[1] ?? null;
}

export interface BuildInfo {
	/** The release tag this build was made for; null for a development build. */
	tag: string | null;
	/** `owner/name` the releases come from. */
	repo: string;
}

export const DEFAULT_REPO = "ctrlc03/oh-my-pi";

export function parseBuildInfo(text: string | null): BuildInfo {
	try {
		const raw: unknown = text === null ? {} : JSON.parse(text);
		if (isRecord(raw)) {
			const tag = typeof raw.tag === "string" && parseTag(raw.tag) !== null ? raw.tag : null;
			const repo =
				typeof raw.repo === "string" && /^[A-Za-z0-9][\w-]*\/(?!\.\.?$)[\w.-]+$/.test(raw.repo)
					? raw.repo
					: DEFAULT_REPO;
			return { tag, repo };
		}
	} catch {
		// unreadable: a development build
	}
	return { tag: null, repo: DEFAULT_REPO };
}
