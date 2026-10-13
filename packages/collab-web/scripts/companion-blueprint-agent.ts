/**
 * The agent half of an architecture map (see ./companion-blueprint): the brief an omp session gets, how that
 * session is kept read-only, and how the companion notices that it is done. The session writes the top diagrams
 * as JSON to a file outside the repository; the companion reads that file, verifies it, and ends the session.
 */

import * as path from "node:path";
import type { IndexResult } from "./companion-blueprint-index";
import diffSection from "./companion-blueprint-diff.md" with { type: "text" };
import promptTemplate from "./companion-blueprint-prompt.md" with { type: "text" };
import refreshSection from "./companion-blueprint-refresh.md" with { type: "text" };

/** Tools the session gets: read and search the code, ask the index, and write the one result file. */
export const BLUEPRINT_TOOLS = ["read", "grep", "glob", "ast_grep", "trace", "flow", "write"] as const;

/** Default spending limit of the agent part, USD. */
export const DEFAULT_MAX_COST_USD = 3;

const MAX_STAT_CHARS = 6_000;
const MAX_UNITS_IN_BRIEF = 120;
const MAX_UNIT_EDGES_IN_BRIEF = 40;
const MAX_SYMBOL_LINES = 200;

/**
 * A glob that matches exactly `file`. omp's path-rule globs have no backslash escape: a wildcard character in the
 * path is matched literally by wrapping it in a character class (`[*]`). A backslash cannot be matched at all.
 */
function globLiteral(file: string): string {
	if (file.includes("\\")) throw new Error("the folder path contains a backslash");
	return file.replace(/[*?[\]{}]/g, char => `[${char}]`);
}

/**
 * Config overlay for the architecture agent, layered after the companion's. Execution tools are denied outright,
 * and the file tools may write exactly one file: `outFile`. Defence in depth behind `--tools` (which has no shell)
 * and, where the platform has it, the sandbox profile.
 */
export function blueprintOverlayYaml(outFile: string): string {
	return `tools:
  approvalMode: write
  approval:
    bash: deny
    python: deny
    eval: deny
    browser: deny
    computer: deny
    task: deny
    debug: deny
  outsideProject: allow
  pathRules:
    - glob: ${JSON.stringify(globLiteral(outFile))}
      tools: [write]
      action: allow
    - glob: "**"
      tools: [write, edit, ast_edit]
      action: deny
bash:
  enabled: false
lsp:
  enabled: false
mcp:
  enableProjectConfig: false
`;
}

/** Fill `{{name}}` placeholders; a missing value is an empty string. */
function fill(template: string, values: Record<string, string>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => (Object.hasOwn(values, name) ? values[name]! : ""));
}

/** The package list the brief shows: what the index found, so the agent links into real folders. */
export function describePackages(index: Pick<IndexResult, "units" | "unitEdges">): string {
	const rows = index.units.slice(0, MAX_UNITS_IN_BRIEF).map(unit => {
		const langs = unit.languages.length > 0 ? ` (${unit.languages.join(", ")})` : "";
		const key = unit.topFiles.length > 0 ? `; key files: ${unit.topFiles.slice(0, 3).join(", ")}` : "";
		return `- \`${unit.path === "" ? "." : unit.path}\`: ${unit.manifest ? "package" : "folder"}, ${unit.files} files, ${unit.symbols} symbols${langs}${key}`;
	});
	if (index.units.length > MAX_UNITS_IN_BRIEF) rows.push(`- … and ${index.units.length - MAX_UNITS_IN_BRIEF} more`);
	const edges = index.unitEdges
		.slice(0, MAX_UNIT_EDGES_IN_BRIEF)
		.map(edge => `- \`${edge.from || "."}\` imports from \`${edge.to || "."}\` (${edge.files} file pairs)`);
	return `${rows.join("\n")}${edges.length > 0 ? `\n\nImports between them, strongest first (from the code index):\n\n${edges.join("\n")}` : ""}`;
}

export interface BriefInput {
	repo: string;
	/** Display of the head: `branch main`, `pull request #12`, `the working tree`. */
	target: string;
	commit: string;
	outFile: string;
	maxCostUsd: number;
	index: Pick<IndexResult, "units" | "unitEdges">;
	diff?: {
		baseTarget: string;
		baseCommit: string;
		baseDir: string;
		stat: string;
		/** `path: name (modified)` lines. */
		symbols: string[];
	};
	refresh?: {
		previousCommit: string;
		previousFile: string;
		stat: string;
	};
}

/** The first message of the architecture session. */
export function buildBrief(input: BriefInput): string {
	const extras: string[] = [];
	if (input.diff) {
		const symbols = input.diff.symbols.slice(0, MAX_SYMBOL_LINES).map(line => `- ${line}`);
		if (input.diff.symbols.length > MAX_SYMBOL_LINES)
			symbols.push(`- … and ${input.diff.symbols.length - MAX_SYMBOL_LINES} more`);
		extras.push(
			fill(diffSection, {
				target: input.target,
				baseTarget: input.diff.baseTarget,
				baseCommit: input.diff.baseCommit,
				baseDir: input.diff.baseDir,
				stat: input.diff.stat.slice(0, MAX_STAT_CHARS),
				symbols: symbols.length > 0 ? symbols.join("\n") : "(none found in indexed languages)",
			}),
		);
	}
	if (input.refresh) {
		extras.push(
			fill(refreshSection, {
				previousCommit: input.refresh.previousCommit,
				previousFile: input.refresh.previousFile,
				stat: input.refresh.stat.slice(0, MAX_STAT_CHARS),
			}),
		);
	}
	return fill(promptTemplate, {
		repo: input.repo,
		target: input.target,
		commit: input.commit,
		outFile: input.outFile,
		maxCost: String(input.maxCostUsd),
		packages: describePackages(input.index),
		extra: extras.join("\n\n"),
	}).trim();
}

/** Folder name of a checkout the session works in: how the session is listed ("Architecture · repo @ ref"). */
export function sessionFolderName(repo: string, label: string): string {
	const clean = (text: string): string => text.replace(/[/\\"\0-\x1f]/g, "-").trim();
	return `Architecture · ${clean(repo)} @ ${clean(label)}`;
}

/** The file the agent writes to, inside `outDir`. */
export function agentOutputFile(outDir: string, id: string): string {
	return path.join(outDir, `${id}.json`);
}

// ── noticing that the agent is done ──────────────────────────────────────────

/** What the session was last seen doing, from the companion's session list. */
export interface AgentHost {
	busy: boolean | null;
}

export interface AgentWatch {
	/** The session, or null when it is no longer listed. */
	host(): Promise<AgentHost | null>;
	/** The result file: its raw text and a change signature (size and mtime), or null when it is not there. */
	output(): Promise<{ text: string; signature: string } | null>;
	now(): number;
	sleep(ms: number): Promise<void>;
	cancelled(): boolean;
}

export type AgentOutcome =
	| { kind: "done"; text: string }
	/** The session ended without a usable file (a spending limit, a crash, stopped from the app). */
	| { kind: "ended" }
	/** The session sat idle without writing the file. */
	| { kind: "stalled" }
	| { kind: "timeout" }
	| { kind: "cancelled" };

export interface AgentWatchOptions {
	pollMs: number;
	/** The file must stay unchanged, with the session idle or gone, this long before it counts as the result. */
	settleMs: number;
	/** Idle without a file this long counts as stalled. */
	idleMs: number;
	/** Not listed for this long, with no file, counts as ended. */
	goneMs: number;
	timeoutMs: number;
}

export const DEFAULT_WATCH: AgentWatchOptions = {
	pollMs: 2_000,
	settleMs: 6_000,
	idleMs: 120_000,
	goneMs: 10_000,
	timeoutMs: 45 * 60_000,
};

/**
 * Wait until the session has written its result and finished, or has ended or stalled without one. A result
 * counts once its file has stopped changing while the session is idle or gone: a file written mid-run, with
 * more turns to come, is not taken early.
 */
export async function waitForAgent(
	watch: AgentWatch,
	options: AgentWatchOptions = DEFAULT_WATCH,
): Promise<AgentOutcome> {
	const started = watch.now();
	let idleSince: number | null = null;
	let goneSince: number | null = null;
	let stable: { signature: string; since: number } | null = null;
	for (;;) {
		if (watch.cancelled()) return { kind: "cancelled" };
		const now = watch.now();
		if (now - started > options.timeoutMs) return { kind: "timeout" };
		const [host, output] = await Promise.all([watch.host(), watch.output()]);
		goneSince = host === null ? (goneSince ?? now) : null;
		idleSince = host !== null && host.busy === false ? (idleSince ?? now) : null;
		if (output === null) {
			stable = null;
			if (goneSince !== null && now - goneSince >= options.goneMs) return { kind: "ended" };
			if (idleSince !== null && now - idleSince >= options.idleMs) return { kind: "stalled" };
		} else {
			if (stable === null || stable.signature !== output.signature)
				stable = { signature: output.signature, since: now };
			const finished = host === null || host.busy === false;
			if (finished && now - stable.since >= options.settleMs) return { kind: "done", text: output.text };
		}
		await watch.sleep(options.pollMs);
	}
}
