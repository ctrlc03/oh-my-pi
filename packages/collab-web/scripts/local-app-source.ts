/**
 * The app the companion serves when it runs from a checkout (`bun packages/collab-web/scripts/companion.ts`, the
 * LaunchAgent's command), where no binary carries a prebuilt copy: the companion builds it itself.
 *
 * Builds live in `<cache>/<hash>/`, where `hash` covers every input of the build (see {@link sourceHash}). At startup:
 * - a build for the current hash exists: serve it;
 * - otherwise build in the background into `<hash>.tmp-<pid>` and rename it into place when it is complete. Until then
 *   the newest older build is served if there is one, else the "building" page (`./local-app`);
 * - once the new build serves, all but the newest two are removed.
 *
 * Starting the companion never waits for any of this.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type AppState, loadDirectoryBuild } from "./local-app";

/** Builds kept after a new one is ready: it and the one before, which a page already open may still be loading from. */
const KEEP_BUILDS = 2;
const HASH_RE = /^[0-9a-f]{16}$/;
const TMP_RE = /^[0-9a-f]{16}\.tmp-(\d+)$/;

/** What the build reads, relative to the repository root. A directory counts every file under it. */
const INPUTS: readonly string[] = [
	"packages/collab-web/src",
	"packages/collab-web/public",
	"packages/collab-web/index.html",
	"packages/collab-web/package.json",
	"packages/collab-web/tsconfig.json",
	"packages/collab-web/scripts/build-app.ts",
	"packages/collab-web/scripts/build-assets.ts",
	"packages/collab-web/scripts/build-sw.ts",
	// Workspace packages the app imports from.
	"packages/wire/src",
	"packages/utils/src",
	"packages/tui/src/chrome",
	// Dependency versions.
	"bun.lock",
];

async function filesUnder(root: string): Promise<string[]> {
	const stat = await fs.stat(root).catch(() => null);
	if (stat === null) return [];
	if (stat.isFile()) return [root];
	return (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root, onlyFiles: true, dot: true })))
		.map(rel => path.join(root, rel))
		.sort();
}

/**
 * A hash of everything the build reads: the sources and public files of the app, the workspace packages it imports,
 * the lockfile, and the Bun version. Equal hashes mean a build would produce the same files; any change to an input
 * changes it. Inputs that do not exist are skipped (an installed package has no lockfile).
 */
export async function sourceHash(repoDir: string, bunVersion: string = Bun.version): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(`bun ${bunVersion}\n`);
	for (const input of INPUTS) {
		const files = await filesUnder(path.join(repoDir, input));
		const contents = await Promise.all(files.map(file => Bun.file(file).bytes()));
		files.forEach((file, index) => {
			// The length frames the content, so moving bytes from one file to the next changes the hash.
			hasher.update(`${path.relative(repoDir, file)}\0${contents[index]!.byteLength}\0`);
			hasher.update(contents[index]!);
		});
	}
	return hasher.digest("hex").slice(0, 16);
}

export interface SourceAppOptions {
	/** Where builds are kept: `<config>/cache/collab-web`. */
	cacheDir: string;
	/** The repository root the hash and the build are taken from. */
	repoDir: string;
	/** Fill `outdir` with a complete build of the app. */
	build: (outdir: string) => Promise<void>;
	log: (line: string) => void;
}

export interface SourceApp {
	state(): AppState;
	/** Settles when startup is over: a build is being served, or the build failed with none to fall back on. */
	settled: Promise<void>;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Complete builds in `cacheDir`, newest first; half-built directories of dead processes are deleted on the way. */
async function listBuilds(cacheDir: string): Promise<string[]> {
	const names = await fs.readdir(cacheDir).catch(() => []);
	const builds: { name: string; at: number }[] = [];
	for (const name of names) {
		const tmp = TMP_RE.exec(name);
		if (tmp !== null) {
			if (!pidAlive(Number(tmp[1]))) await fs.rm(path.join(cacheDir, name), { recursive: true, force: true });
			continue;
		}
		if (!HASH_RE.test(name)) continue;
		const index = await fs.stat(path.join(cacheDir, name, "index.html")).catch(() => null);
		if (index !== null) builds.push({ name, at: index.mtimeMs });
	}
	return builds.sort((a, b) => b.at - a.at).map(build => build.name);
}

export function startSourceApp(options: SourceAppOptions): SourceApp {
	let state: AppState = { kind: "building" };
	let served: string | null = null;
	const serve = async (hash: string): Promise<void> => {
		state = { kind: "ready", build: await loadDirectoryBuild(path.join(options.cacheDir, hash)) };
		served = hash;
	};

	const run = async (): Promise<void> => {
		await fs.mkdir(options.cacheDir, { recursive: true });
		const hash = await sourceHash(options.repoDir);
		const existing = await listBuilds(options.cacheDir);
		if (existing.includes(hash)) {
			await serve(hash);
			options.log(`local app: serving build ${hash}`);
		} else {
			const previous = existing[0];
			if (previous !== undefined) {
				await serve(previous);
				options.log(`local app: serving build ${previous} while ${hash} builds`);
			} else {
				options.log(`local app: building ${hash}`);
			}
			const target = path.join(options.cacheDir, hash);
			const staging = `${target}.tmp-${process.pid}`;
			try {
				const started = Date.now();
				await options.build(staging);
				await fs.rename(staging, target).catch(async err => {
					// Another companion finished the same build first: its copy is as good.
					if (!(await Bun.file(path.join(target, "index.html")).exists())) throw err;
				});
				await serve(hash);
				options.log(`local app: built ${hash} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
			} catch (err) {
				if (previous === undefined) state = { kind: "failed" };
				options.log(
					`local app: build failed${previous === undefined ? "" : `, still serving ${previous}`}: ${err instanceof Error ? err.message : String(err)}`,
				);
			} finally {
				await fs.rm(staging, { recursive: true, force: true });
			}
		}
		// The build being served stays whatever its age (reverting a source change serves an older one again).
		const others = (await listBuilds(options.cacheDir)).filter(name => name !== served);
		for (const stale of others.slice(served === null ? KEEP_BUILDS : KEEP_BUILDS - 1)) {
			await fs.rm(path.join(options.cacheDir, stale), { recursive: true, force: true });
		}
	};

	const settled = run().catch(err => {
		state = { kind: "failed" };
		options.log(`local app: unavailable: ${err instanceof Error ? err.message : String(err)}`);
	});
	return { state: () => state, settled };
}
