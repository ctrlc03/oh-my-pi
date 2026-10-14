/**
 * Which command runs the companion on this computer, and the environment it runs in.
 *
 * The desktop app does not carry an `omp` of its own: it runs the one this computer already has, the fork build the
 * installer puts at `~/.local/bin/omp` (README, "Why the app does not bundle omp"). A GUI app is started with a
 * bare PATH, so the binary is looked for in a fixed order instead of by whatever PATH says:
 *
 *  1. `OMP_BIN` in the environment (the companion's own override);
 *  2. the path the app was told in its settings;
 *  3. the path the installer recorded (`~/.local/share/omp-collab/install`, `path=`);
 *  4. `~/.local/bin`, then the PATH the app got, then Homebrew's and `~/.bun/bin`.
 *
 * A candidate must exist, be executable and answer `companion --help`: an `omp` without the companion (the
 * upstream build) is skipped, not started. An `omp` that is a link to a source checkout's `src/cli.ts` (a `bun link`)
 * has no `companion` command; the companion of that checkout runs instead (`bun scripts/companion.ts`), as it does
 * for an unpackaged app, which is how it is developed.
 */
import * as path from "node:path";

export interface OmpCandidate {
	path: string;
	source: "env" | "settings" | "installer" | "search";
}

export interface CompanionCommand {
	kind: "omp" | "checkout";
	/** The command that runs the companion, before its flags. */
	argv: string[];
	/** The `omp` the companion runs sessions with, for `OMP_BIN`; null for a checkout (the companion finds one itself). */
	omp: string | null;
	/** What to show a person: `omp` at `/path`, or a checkout. */
	label: string;
}

/** `path=` of the installer's state file (`scripts/install-collab.sh` writes `path=`, `sha256=`, `source=`). */
export function parseInstallerState(text: string | null): string | null {
	if (text === null) return null;
	for (const line of text.split("\n")) {
		if (line.startsWith("path=")) {
			const value = line.slice("path=".length).trim();
			return path.isAbsolute(value) ? value : null;
		}
	}
	return null;
}

/** Where the installer records what it installed. */
export function installerStateFile(home: string, env: Record<string, string | undefined>): string {
	return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "omp-collab", "install");
}

/** Directories searched for `omp` and `bun`: the user's usual places first, then what the app was given. */
export function searchDirs(home: string, callerPath: string | undefined, platform: NodeJS.Platform): string[] {
	const dirs = [
		path.join(home, ".local", "bin"),
		...(callerPath ?? "").split(path.delimiter),
		...(platform === "darwin" ? ["/opt/homebrew/bin"] : []),
		"/usr/local/bin",
		path.join(home, ".bun", "bin"),
	];
	return [...new Set(dirs.filter(dir => dir !== "" && path.isAbsolute(dir)))];
}

/** The places an `omp` may be, best first, each once. */
export function ompCandidates(input: {
	env: Record<string, string | undefined>;
	home: string;
	settingsPath: string | null;
	installerState: string | null;
	platform: NodeJS.Platform;
}): OmpCandidate[] {
	const out: OmpCandidate[] = [];
	const add = (candidate: string | null | undefined, source: OmpCandidate["source"]): void => {
		if (candidate && path.isAbsolute(candidate) && !out.some(known => known.path === candidate)) {
			out.push({ path: candidate, source });
		}
	};
	add(input.env.OMP_BIN, "env");
	add(input.settingsPath, "settings");
	add(parseInstallerState(input.installerState), "installer");
	for (const dir of searchDirs(input.home, input.env.PATH, input.platform)) add(path.join(dir, "omp"), "search");
	return out;
}

/** The command for a checkout: `bun <repo>/packages/collab-web/scripts/companion.ts`. */
export function checkoutCommand(repoDir: string, bun: string): CompanionCommand {
	const script = path.join(repoDir, "packages", "collab-web", "scripts", "companion.ts");
	return { kind: "checkout", argv: [bun, script], omp: null, label: `checkout (${script})` };
}

/** The checkout an `omp` runs from when its real path is a checkout's `packages/coding-agent/src/cli.ts`, else null. */
export function checkoutRootOf(realOmp: string): string | null {
	const tail = path.join("packages", "coding-agent", "src", "cli.ts");
	if (!realOmp.endsWith(`${path.sep}${tail}`)) return null;
	return realOmp.slice(0, -tail.length - 1);
}

export function ompCommand(omp: string): CompanionCommand {
	return { kind: "omp", argv: [omp, "companion"], omp, label: `omp at ${omp}` };
}

/**
 * PATH for the companion: where its tools live (the omp it runs, tmux and git from Homebrew), then the PATH the app
 * got and the system directories. The same shape the launchd and systemd definitions give it.
 */
export function companionPath(input: {
	omp: string | null;
	home: string;
	callerPath: string | undefined;
	platform: NodeJS.Platform;
}): string {
	const dirs = [
		...(input.omp === null ? [] : [path.dirname(input.omp)]),
		...searchDirs(input.home, input.callerPath, input.platform),
		"/usr/bin",
		"/bin",
		"/usr/sbin",
		"/sbin",
	];
	return [...new Set(dirs)].join(path.delimiter);
}

/**
 * The companion's environment: the app's, minus what is Electron's own (a child that inherits `ELECTRON_RUN_AS_NODE`
 * would run as Node), with the PATH above and `OMP_BIN` for a compiled omp.
 */
export function companionEnv(
	base: Record<string, string | undefined>,
	command: CompanionCommand,
	home: string,
	platform: NodeJS.Platform,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(base)) {
		if (value !== undefined && !key.startsWith("ELECTRON_")) env[key] = value;
	}
	env.PATH = companionPath({ omp: command.omp, home, callerPath: base.PATH, platform });
	if (command.omp !== null) env.OMP_BIN = command.omp;
	return env;
}

export interface ResolveDeps {
	/** The file is there and runnable. */
	runnable(file: string): Promise<boolean>;
	/** `<file> companion --help` succeeds: the build has the companion. */
	hasCompanion(file: string): Promise<boolean>;
	/** The companion of the checkout `file` runs from ({@link checkoutRootOf}) with the bun that runs it; else null. */
	sourceCheckout(file: string): Promise<CompanionCommand | null>;
	readInstallerState(): Promise<string | null>;
	/** An unpackaged app's checkout and the bun that runs it; null when packaged or either is missing. */
	checkout(): Promise<CompanionCommand | null>;
}

export type Resolution = { ok: true; command: CompanionCommand } | { ok: false; tried: string[] };

/** The command that runs the companion here, or what was tried. */
export async function resolveCompanion(
	input: {
		env: Record<string, string | undefined>;
		home: string;
		settingsPath: string | null;
		platform: NodeJS.Platform;
	},
	deps: ResolveDeps,
): Promise<Resolution> {
	const checkout = await deps.checkout();
	if (checkout !== null) return { ok: true, command: checkout };
	const candidates = ompCandidates({ ...input, installerState: await deps.readInstallerState() });
	const tried: string[] = [];
	for (const candidate of candidates) {
		if (!(await deps.runnable(candidate.path))) continue;
		const source = await deps.sourceCheckout(candidate.path);
		if (source !== null) return { ok: true, command: source };
		if (await deps.hasCompanion(candidate.path)) return { ok: true, command: ompCommand(candidate.path) };
		tried.push(`${candidate.path} (no companion)`);
	}
	return { ok: false, tried: tried.length > 0 ? tried : candidates.map(candidate => candidate.path) };
}
