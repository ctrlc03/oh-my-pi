/**
 * Headless `omp -p` runs the companion makes on its own account, shared by generated git text
 * (./companion-gitmsg) and quiz grading (./companion-quiz-grade): a cheap model role, no session file, no tools, no
 * extensions, skills, rules or LSP, the prompt on stdin, a hard spend cap and a timeout.
 */

export interface RunResult {
	code: number;
	out: string;
	err: string;
}

/** Runs `argv` with `stdin` as input in `cwd`; rejects when the program cannot start or times out. */
export type RunOmp = (argv: string[], stdin: string, cwd: string) => Promise<RunResult>;

export interface HeadlessOptions {
	ompBin: string;
	/** Model id or role (`@smol`). */
	model: string;
	systemPrompt: string;
	/** Stop the run once it has spent this many USD. */
	maxCostUsd: number;
	/** More omp flags, before the model. */
	extra?: readonly string[];
}

/** The argv of a headless omp: cheap model, no session file, tools, extensions, skills, rules or LSP, and a hard spend cap. */
export function headlessOmpArgs(options: HeadlessOptions): string[] {
	return [
		options.ompBin,
		"-p",
		"--no-session",
		"--no-tools",
		"--no-extensions",
		"--no-skills",
		"--no-rules",
		"--no-lsp",
		"--no-title",
		"--thinking",
		"off",
		"--max-cost",
		String(options.maxCostUsd),
		...(options.extra ?? []),
		"--model",
		options.model,
		"--system-prompt",
		options.systemPrompt,
	];
}

/** A {@link RunOmp} that kills the process after `timeoutMs`. */
export function headlessRunner(timeoutMs: number): RunOmp {
	return async (argv, stdin, cwd) => {
		const proc = Bun.spawn(argv, {
			cwd,
			stdin: new Blob([stdin]),
			stdout: "pipe",
			stderr: "pipe",
			timeout: timeoutMs,
			killSignal: "SIGKILL",
		});
		const [out, err, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (proc.signalCode !== null) throw new Error(`timed out after ${timeoutMs / 1000}s`);
		return { code, out, err };
	};
}
