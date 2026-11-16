/** Pure logic of the explorer's git decorations: porcelain `XY` codes as groups and badges, and folder dots. */
import type { GitFileChange } from "../../../lib/companion";
import { ancestors } from "../file-tree";

export type GitGroup = "conflict" | "staged" | "changed" | "untracked";

/** Order the Changes view lists the groups in, with their headings. */
export const GROUP_ORDER: readonly GitGroup[] = ["conflict", "staged", "changed", "untracked"];
export const GROUP_LABEL: Record<GitGroup, string> = {
	conflict: "Merge conflicts",
	staged: "Staged changes",
	changed: "Changes",
	untracked: "Untracked",
};

export type BadgeTone = "add" | "mod" | "del" | "move";

export interface Badge {
	letter: string;
	tone: BadgeTone;
	label: string;
}

function isConflict(status: string): boolean {
	return status.includes("U") || status === "AA" || status === "DD";
}

/** `git status --porcelain=v1` code: `??` untracked, `!!` ignored. */
function isUntracked(status: string): boolean {
	return status === "??";
}

/**
 * The groups a change appears in. A file edited again after staging is in both `staged` and `changed`, as it is in
 * the other git UIs; conflicts and untracked files are in one group alone, and ignored files in none.
 */
export function groupsOf(status: string): GitGroup[] {
	if (status === "!!") return [];
	if (isUntracked(status)) return ["untracked"];
	if (isConflict(status)) return ["conflict"];
	const groups: GitGroup[] = [];
	if (status[0] !== undefined && status[0] !== " ") groups.push("staged");
	if (status[1] !== undefined && status[1] !== " ") groups.push("changed");
	return groups;
}

/** Letter, tone and description of the change a code stands for (the working-tree side when there is one). */
export function badgeOf(status: string): Badge {
	if (isUntracked(status)) return { letter: "U", tone: "add", label: "untracked" };
	if (isConflict(status)) return { letter: "!", tone: "del", label: "merge conflict" };
	const code = status[1] !== undefined && status[1] !== " " ? status[1] : (status[0] ?? "M");
	switch (code) {
		case "A":
			return { letter: "A", tone: "add", label: "added" };
		case "D":
			return { letter: "D", tone: "del", label: "deleted" };
		case "R":
			return { letter: "R", tone: "move", label: "renamed" };
		case "C":
			return { letter: "C", tone: "add", label: "copied" };
		default:
			return { letter: "M", tone: "mod", label: "modified" };
	}
}

/** The changes of one group, in the snapshot's order. */
export function filesIn(files: readonly GitFileChange[], group: GitGroup): GitFileChange[] {
	return files.filter(file => groupsOf(file.status).includes(group));
}

/**
 * A git path (relative to the repository root) as a tree path (relative to the tree's root), or null when the file is
 * outside the tree. The two roots are the same inside a repository; the tree is rooted at the cwd elsewhere.
 */
export function toTreePath(path: string, gitRoot: string, treeRoot: string): string | null {
	if (gitRoot === treeRoot) return path;
	if (!treeRoot.startsWith(`${gitRoot}/`)) return null;
	const prefix = `${treeRoot.slice(gitRoot.length + 1)}/`;
	return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

export interface TreeStatus {
	/** Badge of each changed file, by tree path. */
	files: ReadonlyMap<string, Badge>;
	/** Folders (tree paths) that contain a change at any depth. */
	folders: ReadonlySet<string>;
}

/** Folders that contain at least one of `paths`, at any depth. */
export function changedFolders(paths: Iterable<string>): Set<string> {
	const folders = new Set<string>();
	for (const path of paths) for (const dir of ancestors(path)) folders.add(dir);
	return folders;
}

/** Decorations of the file tree for a git snapshot of the same repository. */
export function treeStatus(files: readonly GitFileChange[], gitRoot: string, treeRoot: string): TreeStatus {
	const badges = new Map<string, Badge>();
	for (const file of files) {
		if (file.status === "!!") continue;
		const path = toTreePath(file.path, gitRoot, treeRoot);
		if (path !== null) badges.set(path, badgeOf(file.status));
	}
	return { files: badges, folders: changedFolders(badges.keys()) };
}
