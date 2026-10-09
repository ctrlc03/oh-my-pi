/**
 * `omp codemap`: build, inspect, and query the persistent code index from the
 * shell. Same index and queries as the `trace` tool; `PATH` is the repository
 * root to index (default: the current directory).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { formatBytes, formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { Codemap, renderFlow, renderSearch, renderTrace, runFlow } from "../codemap";
import { InternalUrlFilesystem } from "../internal-urls/url-filesystem";
import { openStandaloneJudge } from "../judgment/standalone";

export const CODEMAP_ACTIONS = ["build", "stats", "trace", "search", "flow"] as const;
export type CodemapAction = (typeof CODEMAP_ACTIONS)[number];

export interface CodemapCommandArgs {
	action: CodemapAction;
	/** `PATH` for build/stats; the symbol, search words, or question for trace/search/flow. */
	first: string | undefined;
	/** `PATH` for trace/search/flow. */
	second: string | undefined;
	depth: number;
	/** flow: symbol to start from. */
	from: string | undefined;
	/** flow: edges to follow. */
	hops: number;
	json: boolean;
}

function fail(message: string): never {
	console.error(chalk.red(`Error: ${message}`));
	process.exit(1);
}

/** `name  count` lines, largest first, for a stats breakdown. */
function breakdown(counts: Record<string, number>): string {
	return Object.entries(counts)
		.sort((a, b) => b[1] - a[1])
		.map(([name, n]) => `${name} ${formatNumber(n)}`)
		.join(" · ");
}

/** Run one `omp codemap` action and print its result. Exits non-zero on bad arguments. */
export async function runCodemapCommand(cmd: CodemapCommandArgs): Promise<void> {
	const cwd = process.cwd();
	const needsQuery = cmd.action === "trace" || cmd.action === "search" || cmd.action === "flow";
	if (needsQuery && !cmd.first?.trim()) {
		fail(
			`codemap ${cmd.action} needs a ${cmd.action === "trace" ? "symbol" : cmd.action === "flow" ? "question" : "query"}`,
		);
	}
	const rootInput = (needsQuery ? cmd.second : cmd.first) ?? ".";
	const root = path.resolve(cwd, rootInput);
	if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail(`not a directory: ${rootInput}`);

	const codemap = await Codemap.open(root, { cwd });
	try {
		const { stats } = codemap;
		if (cmd.action === "build") {
			if (cmd.json) console.log(JSON.stringify({ root: codemap.root, ...stats }, null, 2));
			else {
				console.log(
					`${chalk.bold(codemap.root)}: ${formatNumber(stats.files)} source files · ${formatNumber(stats.reparsed)} re-parsed, ${formatNumber(stats.unchanged)} unchanged, ${formatNumber(stats.removed)} removed · ${formatNumber(stats.symbols)} symbols, ${formatNumber(stats.refs)} refs written · ${formatDuration(stats.ms)}`,
				);
				if (stats.oversized > 0) console.log(chalk.dim(`${stats.oversized} files over 1 MiB skipped`));
				if (stats.unparsed > 0) console.log(chalk.yellow(`${stats.unparsed} re-parsed files could not be parsed`));
			}
		} else if (cmd.action === "stats") {
			const summary = codemap.summary();
			if (cmd.json) console.log(JSON.stringify(summary, null, 2));
			else {
				console.log(chalk.bold(summary.root));
				console.log(
					`index      ${summary.dbPath} (${formatBytes(summary.dbBytes)}, ${summary.fts ? "FTS5" : "LIKE search, no FTS5"})`,
				);
				console.log(
					`files      ${formatNumber(summary.files)} (${summary.unparsedFiles} unparsed) — ${breakdown(summary.languages)}`,
				);
				console.log(`symbols    ${formatNumber(summary.symbols)} — ${breakdown(summary.symbolKinds)}`);
				console.log(`refs       ${formatNumber(summary.refs)} — ${breakdown(summary.refKinds)}`);
				console.log(
					`refresh    ${formatDuration(stats.ms)}, ${stats.reparsed} re-parsed, ${stats.removed} removed`,
				);
			}
		} else if (cmd.action === "trace") {
			const result = codemap.query.trace(cmd.first!.trim(), Math.min(3, Math.max(1, cmd.depth)));
			console.log(cmd.json ? JSON.stringify(result, null, 2) : renderTrace(result));
		} else if (cmd.action === "flow") {
			// Without a native judge the walk is structural; a prompted model cannot give calibrated probabilities.
			const standalone = await openStandaloneJudge(root, "flow");
			try {
				const result = await runFlow(codemap, {
					question: cmd.first!.trim(),
					from: cmd.from?.trim() || undefined,
					hops: cmd.hops,
					judge: standalone.native ? standalone.judge : undefined,
					searchRoot: root,
					filesystem: new InternalUrlFilesystem({ context: { cwd }, tier: "read" }),
					onProgress: message => console.error(chalk.dim(message)),
				});
				console.log(cmd.json ? JSON.stringify(result, null, 2) : renderFlow(result));
			} finally {
				standalone.close();
			}
		} else {
			const result = codemap.query.search(cmd.first!.trim());
			console.log(cmd.json ? JSON.stringify(result, null, 2) : renderSearch(result));
		}
	} finally {
		codemap.close();
	}
}
