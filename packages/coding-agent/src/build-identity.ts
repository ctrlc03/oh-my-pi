/**
 * Which release stream this build belongs to. Standalone binaries fold both values in at
 * compile time (`compileCodingAgent` defines them), so a fork's binary updates from the
 * fork's GitHub releases and never from upstream. Source checkouts and npm installs carry no
 * defines and resolve to upstream with no build tag.
 */

/** GitHub repository whose releases upstream builds update from. */
export const UPSTREAM_RELEASE_REPO = "can1357/oh-my-pi";

/** Tag shape of a fork release: `collab-v<semver>-<n>`, e.g. `collab-v18.8.9-1`. */
export const FORK_TAG_PATTERN = /^collab-v(\d+)\.(\d+)\.(\d+)-(\d+)$/;

/** `owner/name` of the GitHub repository this build's releases are published on. */
export const RELEASE_REPO: string = process.env.PI_RELEASE_REPO || UPSTREAM_RELEASE_REPO;

/** Release tag this binary was built from, or null for builds that carry none (source, npm). */
export const BUILD_TAG: string | null = process.env.PI_BUILD_TAG || null;

/** The build comes from a fork's release stream rather than upstream's. */
export const IS_FORK_BUILD: boolean = RELEASE_REPO !== UPSTREAM_RELEASE_REPO;

/** One-line identity for diagnostics and `--help`: the tag (or `dev`) and the repository. */
export function buildLabel(tag: string | null = BUILD_TAG, repo: string = RELEASE_REPO): string {
	return `${tag ?? "dev"} (${repo})`;
}
