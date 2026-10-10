/**
 * The app route of the Fix-it flow, `fix:<urlencoded owner/repo>/<number>`: built by the companion for a
 * failed-checks notification and by the GitHub sheet, read by the app when it opens.
 */

export const FIX_PREFIX = "fix:";

const REPO_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

export interface FixTarget {
	/** `owner/name`. */
	repo: string;
	number: number;
}

export function fixRoute(repo: string, number: number): string {
	return `${FIX_PREFIX}${encodeURIComponent(repo)}/${number}`;
}

const PR_URL_RE = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/;

/** `owner/name` of the repository a pull request URL belongs to, or null for any other URL. */
export function prRepo(url: string): string | null {
	return PR_URL_RE.exec(url)?.[1] ?? null;
}

/** The pull request a route names, or null when it is not a well-formed `fix:` route. */
export function parseFixRoute(route: string): FixTarget | null {
	if (!route.startsWith(FIX_PREFIX)) return null;
	const slash = route.lastIndexOf("/");
	if (slash < 0) return null;
	let repo: string;
	try {
		repo = decodeURIComponent(route.slice(FIX_PREFIX.length, slash));
	} catch {
		return null;
	}
	const digits = route.slice(slash + 1);
	if (!REPO_RE.test(repo) || !/^[1-9]\d{0,9}$/.test(digits)) return null;
	return { repo, number: Number(digits) };
}
