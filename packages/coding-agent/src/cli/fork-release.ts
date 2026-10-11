/**
 * Release selection for fork builds, whose GitHub releases are tagged
 * `collab-v<semver>-<n>` and are not mirrored on npm. Pure functions over
 * GitHub's release listing so the policy is testable without the network.
 */
import { $env } from "@oh-my-pi/pi-utils";
import { FORK_TAG_PATTERN } from "../build-identity";
import {
	isTimeoutError,
	isUnsupportedProxyError,
	unsupportedProxyMessage,
	withTimeoutSignal,
} from "../utils/fetch-timeout";
import type { BuildAnswer, Fetch } from "./build-service";

/** A parsed fork release tag: the omp version it ships and the build counter within it. */
export interface ForkTag {
	tag: string;
	/** `major.minor.patch` of the omp package the release was built from. */
	version: string;
	parts: readonly [number, number, number];
	/** Build counter after the version (`1` in `collab-v18.8.9-1`). */
	build: number;
}

/** Parse `collab-v<semver>-<n>`; null for any other tag. */
export function parseForkTag(tag: string): ForkTag | null {
	const match = FORK_TAG_PATTERN.exec(tag);
	if (!match) return null;
	const [major, minor, patch, build] = [match[1], match[2], match[3], match[4]].map(Number);
	return { tag, version: `${major}.${minor}.${patch}`, parts: [major, minor, patch], build };
}

/** Order two parsed fork tags: version first, then build counter. */
function compareParsed(a: ForkTag, b: ForkTag): number {
	for (let i = 0; i < 3; i++) {
		if (a.parts[i] !== b.parts[i]) return a.parts[i] - b.parts[i];
	}
	return a.build - b.build;
}

/**
 * Compare a release tag with the tag the running binary was built from.
 * A build without a parseable tag (a dev build) is older than every release.
 */
export function compareForkTags(releaseTag: string, buildTag: string | null): number {
	const release = parseForkTag(releaseTag);
	if (!release) throw new Error(`Not a fork release tag: ${releaseTag}`);
	const build = buildTag === null ? null : parseForkTag(buildTag);
	return build ? compareParsed(release, build) : 1;
}

/** `major.minor.patch` shipped by a release tag: the fork shape, else the upstream `v<semver>` shape. */
export function versionFromTag(tag: string): string {
	return parseForkTag(tag)?.version ?? tag.replace(/^v/, "");
}

/**
 * Newest published fork release in a GitHub release listing: not a draft, not a
 * prerelease, tag of the `collab-v<semver>-<n>` shape. Undefined when there is none.
 */
export function selectLatestForkRelease(releases: unknown): { tag: string; version: string } | undefined {
	if (!Array.isArray(releases)) return undefined;
	let best: ForkTag | undefined;
	for (const release of releases) {
		if (typeof release !== "object" || release === null) continue;
		const { tag_name: tagName, draft, prerelease } = release as Record<string, unknown>;
		if (typeof tagName !== "string" || draft !== false || prerelease !== false) continue;
		const parsed = parseForkTag(tagName);
		if (parsed && (!best || compareParsed(parsed, best) > 0)) best = parsed;
	}
	return best && { tag: best.tag, version: best.version };
}

/** Installer one-liner for a repository's GitHub Pages site (`https://<owner>.github.io/<name>/install.sh`). */
export function forkInstallerHint(repo: string): string {
	const [owner, name] = repo.split("/");
	return `curl -fsSL https://${owner}.github.io/${name}/install.sh | sh`;
}

/** A fork release resolved to the build `omp update` installs. */
export interface ForkBuild {
	tag: string;
	build: BuildAnswer;
}

const GITHUB_API = "https://api.github.com";
const RELEASE_LISTING_PAGE_SIZE = 30;
const RELEASE_LISTING_TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The installable build of a published fork release for the platform file `fileName`.
 *
 * Throws unless the release is a published (not draft, not prerelease) release of `tag`
 * carrying exactly one fully uploaded asset of that name, with a size, a SHA-256 digest, and
 * the download URL GitHub serves for `repo`. Forks have no build service, so the digest GitHub
 * computed for the asset is what the download is verified against.
 */
export function forkBuildFromRelease(release: unknown, tag: string, fileName: string, repo: string): BuildAnswer {
	if (!isRecord(release)) throw new Error("Invalid GitHub release metadata");
	if (release.tag_name !== tag) throw new Error(`GitHub release tag mismatch: expected ${tag}`);
	if (release.draft !== false) throw new Error(`GitHub release ${tag} is a draft, not a published release`);
	if (release.prerelease !== false) throw new Error(`GitHub release ${tag} is a prerelease`);
	if (!Array.isArray(release.assets)) throw new Error(`GitHub release ${tag} has no asset list`);

	const matches = release.assets.filter(asset => isRecord(asset) && asset.name === fileName);
	if (matches.length !== 1) throw new Error(`GitHub release ${tag} has ${matches.length} assets named ${fileName}`);
	const asset = matches[0] as Record<string, unknown>;
	if (asset.state !== "uploaded") throw new Error(`GitHub release asset ${fileName} is not fully uploaded`);
	const size = asset.size;
	if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) {
		throw new Error(`GitHub release asset ${fileName} has an invalid size`);
	}
	if (typeof asset.digest !== "string") throw new Error(`GitHub release asset ${fileName} has no digest`);
	const sha256 = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest)?.[1];
	if (!sha256) throw new Error(`GitHub release asset ${fileName} has an unsupported digest`);

	const download = `https://github.com/${repo}/releases/download/${tag}/${fileName}`;
	if (asset.browser_download_url !== download) {
		throw new Error(`GitHub release asset ${fileName} has an unexpected download URL`);
	}
	return { version: versionFromTag(tag), file: { name: fileName, size, sha256: sha256.toLowerCase() }, download };
}

/** Options for {@link fetchLatestForkBuild}; `fetchImpl` is the test seam. */
export interface FetchForkBuildOptions {
	fetchImpl?: Fetch;
	timeoutMs?: number;
	token?: string;
}

/** The newest published fork release of `repo`, resolved to its build for the platform file `fileName`. */
export async function fetchLatestForkBuild(
	repo: string,
	fileName: string,
	options: FetchForkBuildOptions = {},
): Promise<ForkBuild> {
	const timeoutMs = options.timeoutMs ?? RELEASE_LISTING_TIMEOUT_MS;
	const token = options.token ?? ($env.GITHUB_TOKEN || $env.GH_TOKEN);
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	if (token) headers.Authorization = `Bearer ${token}`;

	let response: Response;
	try {
		response = await (options.fetchImpl ?? fetch)(
			`${GITHUB_API}/repos/${repo}/releases?per_page=${RELEASE_LISTING_PAGE_SIZE}`,
			{
				headers,
				signal: withTimeoutSignal(timeoutMs),
			},
		);
	} catch (err) {
		if (isTimeoutError(err)) {
			throw new Error(`Timed out listing releases of ${repo} after ${Math.round(timeoutMs / 1000)}s`, {
				cause: err,
			});
		}
		if (isUnsupportedProxyError(err)) throw new Error(unsupportedProxyMessage(), { cause: err });
		throw err;
	}
	if ((response.status === 403 && !token) || response.status === 429) {
		throw new Error(
			"GitHub API rate limit exceeded while fetching release metadata; retry later or set GITHUB_TOKEN or GH_TOKEN",
		);
	}
	if (!response.ok) throw new Error(`Failed to list releases of ${repo}: ${response.status} ${response.statusText}`);

	const releases = await response.json();
	const latest = selectLatestForkRelease(releases);
	if (!latest) throw new Error(`${repo} has no published collab-v<version>-<n> release`);
	const release = (releases as unknown[]).find(entry => isRecord(entry) && entry.tag_name === latest.tag);
	return { tag: latest.tag, build: forkBuildFromRelease(release, latest.tag, fileName, repo) };
}
