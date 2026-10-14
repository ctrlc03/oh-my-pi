/**
 * The brief of an architecture map's agent (see ./companion-blueprint): what the omp session is told. How the session
 * is kept read-only and noticed to be done is ./companion-agent. The session writes the top diagrams as JSON to a file
 * outside the repository; the companion reads that file, verifies it, and ends the session.
 */

import { fillTemplate } from "./companion-agent";
import type { IndexResult } from "./companion-blueprint-index";
import diffSection from "./companion-blueprint-diff.md" with { type: "text" };
import promptTemplate from "./companion-blueprint-prompt.md" with { type: "text" };
import refreshSection from "./companion-blueprint-refresh.md" with { type: "text" };

/** Default spending limit of the agent part, USD. */
export const DEFAULT_MAX_COST_USD = 3;

const MAX_STAT_CHARS = 6_000;
const MAX_UNITS_IN_BRIEF = 120;
const MAX_UNIT_EDGES_IN_BRIEF = 40;
const MAX_SYMBOL_LINES = 200;

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
			fillTemplate(diffSection, {
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
			fillTemplate(refreshSection, {
				previousCommit: input.refresh.previousCommit,
				previousFile: input.refresh.previousFile,
				stat: input.refresh.stat.slice(0, MAX_STAT_CHARS),
			}),
		);
	}
	return fillTemplate(promptTemplate, {
		repo: input.repo,
		target: input.target,
		commit: input.commit,
		outFile: input.outFile,
		maxCost: String(input.maxCostUsd),
		packages: describePackages(input.index),
		extra: extras.join("\n\n"),
	}).trim();
}
