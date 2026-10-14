/**
 * Builds the app and runs it unpackaged, against the real HOME unless you point it elsewhere:
 *
 *   bun run dev
 *   OMP_DESKTOP_DATA_DIR=/tmp/omp-desktop HOME=/tmp/omp-home bun run dev
 *
 * An unpackaged app starts the companion from this checkout (`bun packages/collab-web/scripts/companion.ts`).
 */
import * as path from "node:path";
import { electronExecutable } from "./electron-dist";

const root = path.join(import.meta.dir, "..");

const build = Bun.spawnSync([process.execPath, path.join(root, "scripts", "build.ts")], {
	stdio: ["inherit", "inherit", "inherit"],
});
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);

const run = Bun.spawn([electronExecutable(), root, ...process.argv.slice(2)], {
	stdio: ["inherit", "inherit", "inherit"],
});
process.exit(await run.exited);
