#!/usr/bin/env bun
/**
 * Build the standalone architecture-map viewer into `<outdir>/architecture-assets/` (`standalone.js`,
 * `standalone.css`); `<outdir>` is the first argument, `dist/` by default. `build-app.ts` runs it after `bun build`,
 * before `build-sw.ts`.
 *
 * "Download HTML" in the map viewer inlines these two files, with the map and its code excerpts, into a single page
 * that opens from disk with no network. They are one self-contained script (no code splitting) and one stylesheet,
 * so the exported page needs nothing else. They stay out of the service worker's precache (it lists top-level files
 * only); the worker caches them the first time an export fetches them.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

const root = path.join(import.meta.dir, "..");
const dist = path.resolve(process.argv[2] ?? path.join(root, "dist"));
const target = path.join(dist, "architecture-assets");

await fs.rm(target, { recursive: true, force: true });
const result = await Bun.build({
	entrypoints: [path.join(root, "src", "components", "architecture", "standalone.tsx")],
	outdir: target,
	target: "browser",
	format: "iife",
	minify: true,
	splitting: false,
	naming: "standalone.[ext]",
	define: { "process.env.NODE_ENV": '"production"' },
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}
const sizes = result.outputs.map(output => `${path.basename(output.path)} ${(output.size / 1024).toFixed(1)} KB`);
console.log(`build-architecture-standalone: ${path.relative(process.cwd(), target)} (${sizes.join(", ")})`);
