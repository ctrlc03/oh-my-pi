/**
 * Headless Personal runs (`omp --profile personal -p`): the nightly review and source polls. The child gets only
 * PATH, HOME and PI_CONFIG_DIR, runs in the profile's workspace under a `--max-cost` cap, and is killed on
 * timeout or abort. Exit status 3 means the cap was hit.
 */

import * as os from "node:os";

/** `omp` exits with this status when `--max-cost` stopped the run. */
export const OMP_EXIT_BUDGET = 3;

export interface PersonalOmpRun {
	ompBin: string;
	prompt: string;
	maxCostUsd: number;
	/** Config overlay file (`PersonalProfile.writeOverlay`). */
	overlayFile: string;
	/** The profile's workspace. */
	cwd: string;
	timeoutMs: number;
	signal?: AbortSignal;
	/** Further omp flags (`--no-session` …), placed right before the prompt. */
	extraArgs?: readonly string[];
}

export interface PersonalOmpResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export function personalOmpArgv(run: PersonalOmpRun): string[] {
	return [
		run.ompBin,
		"--profile",
		"personal",
		"-p",
		"--max-cost",
		String(run.maxCostUsd),
		"--config",
		run.overlayFile,
		...(run.extraArgs ?? []),
		"--",
		run.prompt,
	];
}

/** Run one headless turn to its end. Never rejects for a failing child: the exit code says. */
export async function runPersonalOmp(run: PersonalOmpRun): Promise<PersonalOmpResult> {
	const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: os.homedir() };
	if (process.env.PI_CONFIG_DIR) env.PI_CONFIG_DIR = process.env.PI_CONFIG_DIR;
	const proc = Bun.spawn(personalOmpArgv(run), { cwd: run.cwd, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, run.timeoutMs);
	const onAbort = (): void => void proc.kill();
	run.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { exitCode, stdout, stderr, timedOut };
	} finally {
		clearTimeout(timer);
		run.signal?.removeEventListener("abort", onAbort);
	}
}
