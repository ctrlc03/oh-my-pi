#!/usr/bin/env bun
/**
 * Copy Excalidraw's stylesheet and fonts into `dist/excalidraw-assets/`. Runs after `bun build` (see the
 * `build` script), before `build-sw.ts`.
 *
 * The bundler cannot carry these: the library loads its fonts by URL at run time (from `window.EXCALIDRAW_ASSET_PATH`,
 * which lib/excalidraw-load.ts points here) and its stylesheet imports them relatively. They stay out of the
 * service worker's precache (it lists top-level files only); the worker caches each one the first time the
 * canvas uses it, so the canvas works offline after its first use without a large first install.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

const dist = path.resolve(process.argv[2] ?? path.join(import.meta.dir, "..", "dist"));
const target = path.join(dist, "excalidraw-assets");
// The package's `exports` hide its files; its entry point sits in the folder that holds them.
const source = path.dirname(Bun.resolveSync("@excalidraw/excalidraw", path.join(import.meta.dir, "..")));

await fs.rm(target, { recursive: true, force: true });
await fs.mkdir(target, { recursive: true });
await fs.copyFile(path.join(source, "index.css"), path.join(target, "index.css"));
await fs.cp(path.join(source, "fonts"), path.join(target, "fonts"), { recursive: true });
const fonts = [...new Bun.Glob("fonts/**/*.woff2").scanSync({ cwd: target })];
console.log(`build-assets: ${path.relative(process.cwd(), target)} (index.css, ${fonts.length} font files)`);
