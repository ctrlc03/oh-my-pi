/** Folder tree and quick-open matching over the companion's flat file list. */

export interface TreeDir {
	name: string;
	/** Root-relative path; "" for the root. */
	path: string;
	dirs: TreeDir[];
	/** Root-relative file paths directly in this folder. */
	files: string[];
}

/** Nest sorted root-relative paths into folders; folders list before files, both by name. */
export function buildTree(files: readonly string[]): TreeDir {
	const root: TreeDir = { name: "", path: "", dirs: [], files: [] };
	const dirs: Record<string, TreeDir> = { "": root };
	const dirOf = (path: string): TreeDir => {
		if (Object.hasOwn(dirs, path)) return dirs[path]!;
		const cut = path.lastIndexOf("/");
		const parent = dirOf(cut < 0 ? "" : path.slice(0, cut));
		const dir: TreeDir = { name: path.slice(cut + 1), path, dirs: [], files: [] };
		parent.dirs.push(dir);
		dirs[path] = dir;
		return dir;
	};
	for (const file of files) {
		const cut = file.lastIndexOf("/");
		dirOf(cut < 0 ? "" : file.slice(0, cut)).files.push(file);
	}
	const byName = (a: string, b: string): number => a.localeCompare(b);
	for (const key in dirs) {
		const dir = dirs[key]!;
		dir.dirs.sort((a, b) => byName(a.name, b.name));
		dir.files.sort((a, b) => byName(baseName(a), baseName(b)));
	}
	return root;
}

export function baseName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

/** Every folder that contains `path`, outermost first ("a", "a/b" for "a/b/c.ts"). */
export function ancestors(path: string): string[] {
	const out: string[] = [];
	for (let i = path.indexOf("/"); i >= 0; i = path.indexOf("/", i + 1)) out.push(path.slice(0, i));
	return out;
}

/**
 * Score `path` against a quick-open query: every query character must appear in
 * order (case-insensitive). Matches in the file name, at word starts, and in
 * runs score higher; shorter paths break ties. Null when it does not match.
 */
export function matchScore(query: string, path: string): number | null {
	const q = query.toLowerCase();
	const p = path.toLowerCase();
	const nameStart = p.lastIndexOf("/") + 1;
	let score = 0;
	let at = 0;
	let prev = -2;
	for (const ch of q) {
		if (ch === " ") continue;
		const found = p.indexOf(ch, at);
		if (found < 0) return null;
		let gain = 1;
		if (found === prev + 1) gain += 4;
		if (found >= nameStart) gain += 2;
		const before = p[found - 1];
		if (found === 0 || before === "/" || before === "-" || before === "_" || before === ".") gain += 3;
		score += gain;
		prev = found;
		at = found + 1;
	}
	return score * 1000 - path.length;
}

/** The best `limit` matches of `query`, best first. */
export function quickOpen(query: string, files: readonly string[], limit: number): string[] {
	const scored: { path: string; score: number }[] = [];
	for (const path of files) {
		const score = matchScore(query, path);
		if (score !== null) scored.push({ path, score });
	}
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit).map(s => s.path);
}
