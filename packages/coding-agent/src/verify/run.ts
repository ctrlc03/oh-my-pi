import * as path from "node:path";
import { executeBash } from "../exec/bash-executor";

export interface VerifyRunOptions {
	cwd: string;
	/** Shell-session key; keeps verification off the agent's own bash session. */
	sessionKey: string;
	/** Per-command deadline; `0` disables it. */
	timeoutMs: number;
	signal?: AbortSignal;
}

/** Result of running the configured verification commands in order. */
export type VerifyOutcome =
	| { kind: "passed" }
	| { kind: "failed"; command: string; exitCode: number | undefined; timedOut: boolean; output: string }
	| { kind: "cancelled" };

/** Runs `commands` through the shell in `options.cwd`, stopping at the first one that does not exit 0. */
export async function runVerifyCommands(
	commands: readonly string[],
	options: VerifyRunOptions,
): Promise<VerifyOutcome> {
	for (const command of commands) {
		const result = await executeBash(command, {
			cwd: options.cwd,
			sessionKey: options.sessionKey,
			timeout: options.timeoutMs,
			signal: options.signal,
		});
		if (result.timedOut) {
			return { kind: "failed", command, exitCode: undefined, timedOut: true, output: result.output };
		}
		if (result.cancelled || options.signal?.aborted) return { kind: "cancelled" };
		if (result.exitCode !== 0) {
			return { kind: "failed", command, exitCode: result.exitCode, timedOut: false, output: result.output };
		}
	}
	return { kind: "passed" };
}

/** Keeps the last `maxChars` characters of `output`, reporting how many leading characters were dropped. */
export function tailOutput(output: string, maxChars: number): { text: string; truncatedChars: number } {
	const trimmed = output.trim();
	if (maxChars <= 0) return { text: "", truncatedChars: trimmed.length };
	if (trimmed.length <= maxChars) return { text: trimmed, truncatedChars: 0 };
	return { text: trimmed.slice(trimmed.length - maxChars), truncatedChars: trimmed.length - maxChars };
}

/** Compiles each `verify.paths` glob once; an empty list matches everything. */
export function createChangedPathMatcher(globs: readonly string[], cwd: string): (changedPath: string) => boolean {
	const patterns = globs.map(glob => new Bun.Glob(glob));
	if (patterns.length === 0) return () => true;
	return changedPath => {
		const absolute = path.resolve(cwd, changedPath);
		const relative = path.relative(cwd, absolute).split(path.sep).join("/");
		const candidates = relative.startsWith("..") || path.isAbsolute(relative) ? [absolute] : [relative, absolute];
		return patterns.some(pattern => candidates.some(candidate => pattern.match(candidate)));
	};
}
