/**
 * Architecture maps ("blueprints"): layered diagrams of a repository at one commit, generated on the
 * computer by the companion and drawn by the web app. Diagrams open into each other (a node's `child`),
 * from the whole system down to files and symbols, and every arrow cites the code behind it.
 *
 * The top diagrams are written by an agent (`origin: "agent"`); the ones below come from omp's code index
 * with no model (`origin: "index"`). Every {@link BlueprintRef} is checked against the commit before the
 * map is stored: a ref whose token is not on its line is moved to the token's unique line in that file,
 * or dropped with a warning, so a stored map never cites code that is not there.
 *
 * A diff map (`base` set) describes what a branch, a pull request or a session's work changed: nodes and
 * edges carry `change`, and refs of removed things point at the base commit (`side: "base"`).
 *
 * Shared by the companion (which builds, verifies and stores maps) and the web app (which draws them and
 * exports a standalone HTML page). Pure JSON shapes; no runtime code beyond the constants.
 */

/** Format version of {@link Blueprint}. */
export const BLUEPRINT_VERSION = 1;
/** A map with more diagrams than this is refused when stored (a runaway generator, not a real repository). */
export const MAX_BLUEPRINT_DIAGRAMS = 2_000;
/** Lines of context an excerpt returns on each side of the cited line. */
export const BLUEPRINT_EXCERPT_CONTEXT = 12;
/** Lines one "show more" asks for above or below an excerpt. */
export const BLUEPRINT_EXCERPT_STEP = 20;
/**
 * Most lines one excerpt may hold, however wide the range asked for. A whole file of a few thousand lines still opens in
 * one reply, while a single answer stays small enough for the relay (lines are cut at 400 characters, so well under a MB)
 * and for the browser to draw as one block; a larger file is read a window at a time.
 */
export const BLUEPRINT_EXCERPT_MAX_LINES = 2_000;
/** Ranged excerpts one request may ask for: each can be {@link BLUEPRINT_EXCERPT_MAX_LINES} long, so a reply stays bounded. */
export const BLUEPRINT_EXCERPT_MAX_RANGES = 20;

/**
 * Code behind a node or an edge: `token` occurs on line `line` (1-based) of `path` (repository-relative,
 * "/" separators) at the map's commit, or at the base commit when `side` is `"base"`.
 * Written `path@line@token` in prompts and in the HTML export.
 */
export interface BlueprintRef {
	path: string;
	line: number;
	token: string;
	side?: "head" | "base";
}

/** How a node or edge differs from the base commit, in a diff map only. */
export type BlueprintChange = "added" | "modified" | "removed";

/**
 * Open set: the app styles the kinds it knows and draws any other as `component`.
 * `external` is something outside the repository (a third-party API, a chain, a browser).
 */
export type BlueprintNodeKind =
	| "system"
	| "service"
	| "component"
	| "package"
	| "module"
	| "file"
	| "symbol"
	| "store"
	| "queue"
	| "actor"
	| "ui"
	| "external"
	| (string & {});

/** Open set, like {@link BlueprintNodeKind}; drawn as `call` when unknown. */
export type BlueprintEdgeKind = "call" | "import" | "event" | "data" | "http" | "rpc" | "spawn" | (string & {});

export interface BlueprintNode {
	/** Unique within its diagram. */
	id: string;
	label: string;
	kind: BlueprintNodeKind;
	/** One or two plain sentences: what it is for. */
	summary?: string;
	/** Diagram this node opens into (a key of {@link Blueprint.diagrams}). */
	child?: string;
	/** Where it lives: a folder or file path (repository-relative), shown and used to open it in the editor. */
	path?: string;
	refs?: BlueprintRef[];
	change?: BlueprintChange;
}

export interface BlueprintEdge {
	/** Unique within its diagram. */
	id: string;
	from: string;
	to: string;
	/** Short verb phrase drawn on the arrow, e.g. "publishes E3Requested". */
	label: string;
	kind?: BlueprintEdgeKind;
	/** The code that makes this connection. Agent-written edges without a verified ref are dropped. */
	refs: BlueprintRef[];
	change?: BlueprintChange;
}

export interface BlueprintDiagram {
	/** Key in {@link Blueprint.diagrams}. */
	id: string;
	title: string;
	summary?: string;
	/** Diagram one level up (the one with a node whose `child` is this), absent on the root. */
	parent?: string;
	origin: "agent" | "index";
	nodes: BlueprintNode[];
	edges: BlueprintEdge[];
}

export interface BlueprintCommit {
	/** Full commit hash. */
	commit: string;
	/** Branch or ref name the user picked (`main`, `feature/x`, `pr/123`), when there was one. */
	ref?: string;
	subject?: string;
}

export interface Blueprint {
	v: typeof BLUEPRINT_VERSION;
	id: string;
	/** Display name, e.g. "interfold @ feature/x" or "PR #2250". */
	title: string;
	repo: {
		/** Absolute path of the repository's primary checkout on the computer. */
		root: string;
		name: string;
		/** `owner/name` of the GitHub remote, when there is one. */
		github?: string;
	};
	head: BlueprintCommit;
	/** Set on diff maps: what `head` is compared with (the merge base with the target branch). */
	base?: BlueprintCommit;
	createdAt: number;
	/** `provider/model` that wrote the agent diagrams. */
	model?: string;
	costUsd?: number;
	/** Entry diagram. */
	root: string;
	diagrams: Record<string, BlueprintDiagram>;
	/** Everything the build fixed, dropped or skipped, in plain words. */
	warnings: string[];
}

/** One row of the maps list: enough to show and pick a map without loading it. */
export interface BlueprintSummary {
	id: string;
	title: string;
	repoRoot: string;
	head: BlueprintCommit;
	base?: BlueprintCommit;
	createdAt: number;
	status: "running" | "ready" | "failed";
	/** While running: the step in plain words ("Indexing the code", "Writing the system diagram" …). */
	progress?: string;
	/** When failed. */
	error?: string;
	/** The omp session writing the agent diagrams, while running (open it to watch, or stop it). */
	instanceId?: string;
	/** `head.ref` has moved past `head.commit` since the map was made. */
	stale?: boolean;
	diagramCount?: number;
	costUsd?: number;
}

/** What to map. `base` makes a diff map; `refresh` rebuilds an existing map at the ref's new tip, reusing what did not change. */
export interface BlueprintCreate {
	/** Any folder inside the repository. */
	cwd: string;
	/**
	 * Branch, tag, commit, `pr/<number>` (fetched from the GitHub remote), or `@worktree`: the folder's
	 * current files including uncommitted and untracked changes, snapshotted into a commit object without
	 * touching the checkout or its index (for mapping what an agent just did). Omitted = the checked-out HEAD.
	 */
	ref?: string;
	/**
	 * Compare with this ref (diff map), or `@default`: the merge base with the repository's default branch.
	 * For `pr/<n>` the PR's base branch is used when omitted.
	 */
	base?: string;
	/** Id of an existing map to rebuild at the ref's new tip, reusing what did not change. */
	refresh?: string;
	/** Spend limit for the agent part, USD. */
	maxCostUsd?: number;
	model?: string;
}

/**
 * A ref in an excerpt request, optionally asking for more than the default window: lines `from` to `to` (1-based,
 * inclusive) of the file at the ref's commit and side. The range is widened to hold the cited line, cut to the file and
 * to {@link BLUEPRINT_EXCERPT_MAX_LINES}; one that is not a pair of whole numbers with `from <= to` is ignored. A
 * companion that predates ranges ignores both fields and answers the default window, without `total`.
 */
export interface BlueprintExcerptRef extends BlueprintRef {
	from?: number;
	to?: number;
}

/** Lines around a ref at the map's head (or base) commit, read from git, so they stay right after the branch moves on. */
export interface BlueprintExcerpt {
	path: string;
	/** First line number of `lines`. */
	start: number;
	lines: string[];
	/** The cited line, 1-based. */
	line: number;
	side: "head" | "base";
	commit: string;
	/** Detected from the extension for highlighting (`ts`, `rs`, `sol` …). */
	language?: string;
	/**
	 * Lines in the whole file. Present when the companion can read ranges, so a viewer knows whether there is more above
	 * (`start > 1`) or below (`start + lines.length - 1 < total`); absent, it offers no "show more".
	 */
	total?: number;
}

/**
 * Companion requests (sent in the companion room like the other `t`-tagged requests, answered by
 * `reqId`). The companion advertises `canBlueprint` in its hello when it supports them.
 *
 * - `blueprint-list` `{ cwd? }` → `{ maps: BlueprintSummary[] }` (all repositories when `cwd` is omitted)
 * - `blueprint-create` `BlueprintCreate` → `{ id }` (the map appears in the list as `running`)
 * - `blueprint-get` `{ id }` → `{ map: Blueprint }`
 * - `blueprint-excerpt` `{ id, refs: BlueprintExcerptRef[] }` → `{ excerpts: (BlueprintExcerpt | null)[] }` (same order)
 * - `blueprint-delete` `{ id }` → `{}` (stops it first when running)
 * - `blueprint-refs` `{ cwd, q? }` → `{ branches: string[]; current?: string; prs?: { number: number; title: string; head: string; base: string }[] }`
 *
 * The companion pushes `{ t: "blueprint-changed", id }` when a map's summary changes (progress, done, failed).
 */
export type BlueprintRequest =
	| { t: "blueprint-list"; reqId: number; cwd?: string }
	| ({ t: "blueprint-create"; reqId: number } & BlueprintCreate)
	| { t: "blueprint-get"; reqId: number; id: string }
	| { t: "blueprint-excerpt"; reqId: number; id: string; refs: BlueprintExcerptRef[] }
	| { t: "blueprint-delete"; reqId: number; id: string }
	| { t: "blueprint-refs"; reqId: number; cwd: string; q?: string };

export interface BlueprintRefsAnswer {
	branches: string[];
	current?: string;
	prs?: { number: number; title: string; head: string; base: string }[];
}
