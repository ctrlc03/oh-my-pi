/**
 * Release selection for fork builds, whose GitHub releases are tagged
 * `collab-v<semver>-<n>` and are not mirrored on npm. Pure functions over
 * GitHub's release listing so the policy is testable without the network.
 */
import { FORK_TAG_PATTERN } from "../build-identity";

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
