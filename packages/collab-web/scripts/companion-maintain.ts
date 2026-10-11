/**
 * Computer maintenance from the app: restarting the companion under its service manager (launchd or
 * systemd) and updating the installed omp, plus the (cached) `omp --version`.
 */

import { managedBy, restartService, startedByHandHint } from "./companion-service";

/** `omp update` downloads and installs a release. */
const UPDATE_TIMEOUT_MS = 300_000;
const VERSION_TIMEOUT_MS = 10_000;
/** The restart reply must reach the relay before the service manager kills this process. */
const RESTART_DELAY_MS = 500;
/** Longest tail of update output returned to the app. */
const OUTPUT_MAX_CHARS = 4_000;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matches terminal escape sequences
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** Run omp and collect stdout then stderr, colour-free; `code` is null when the timeout killed it. */
async function runOmp(
	ompBin: string,
	args: string[],
	timeoutMs: number,
): Promise<{ code: number | null; output: string }> {
	const proc = Bun.spawn([ompBin, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
		env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
		timeout: timeoutMs,
		killSignal: "SIGKILL",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	const output = `${out}\n${err}`.replace(ANSI_RE, "").trim();
	return { code: proc.signalCode === "SIGKILL" ? null : code, output };
}

let cachedVersion: string | null = null;

/** First line of `omp --version`, cached until an update; null when omp does not answer. */
export async function ompVersion(ompBin: string): Promise<string | null> {
	if (cachedVersion !== null) return cachedVersion;
	const result = await runOmp(ompBin, ["--version"], VERSION_TIMEOUT_MS).catch(() => null);
	if (result?.code === 0) cachedVersion = result.output.split("\n")[0] || null;
	return cachedVersion;
}

/** Restart through the service manager after this reply is out; refused for a companion started by hand. */
export function restartCompanion(): string {
	if (managedBy() === null) throw new Error(startedByHandHint());
	setTimeout(() => {
		restartService().catch(err => {
			console.error(`companion: restart failed: ${err instanceof Error ? err.message : String(err)}`);
		});
	}, RESTART_DELAY_MS);
	return "Restarting the companion. It reconnects in a few seconds.";
}

/**
 * `omp update`; refused while a session works, since the update replaces the
 * install those sessions run from. Resolves with the command's trimmed output.
 */
export async function updateOmp(ompBin: string, sessions: readonly { busy: boolean | null }[]): Promise<string> {
	const working = sessions.filter(session => session.busy === true).length;
	if (working > 0) {
		throw new Error(
			`${working} session${working === 1 ? " is" : "s are"} working right now. Updating omp replaces the install they run from; try again when they are idle.`,
		);
	}
	const { code, output } = await runOmp(ompBin, ["update"], UPDATE_TIMEOUT_MS);
	const shown = output.length > OUTPUT_MAX_CHARS ? `…${output.slice(-OUTPUT_MAX_CHARS)}` : output;
	if (code === null)
		throw new Error(`omp update took longer than ${UPDATE_TIMEOUT_MS / 60_000} minutes and was stopped.`);
	if (code !== 0) throw new Error(shown || `omp update exited with ${code}`);
	cachedVersion = null;
	return shown || "omp update finished.";
}
