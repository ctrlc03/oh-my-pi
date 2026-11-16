#!/usr/bin/env bun
/**
 * Build Monaco into `dist/monaco-assets/`: the editor engine as its own bundle (`monaco.js` and `monaco.css`,
 * with one small chunk per language tokenizer) and its web worker (`editor.worker.js`). Runs after `bun build`
 * (see build-app.ts), before `build-sw.ts`.
 *
 * It is a separate build because the app's own bundler cannot do this job: it would fold Monaco's stylesheet
 * (150 KB, with the icon font) into the page's one stylesheet that every phone loads, and it leaves
 * `new Worker(new URL("./x.js", import.meta.url))` untouched, so the worker would not exist in `dist/`.
 * The page imports `monaco-assets/monaco.js` only when the Monaco engine is chosen (src/components/ide/backend/
 * index.ts); the engine creates the worker from a URL next to itself, so a path prefix needs no setup.
 *
 * Offline and the local app's policy: nothing here evals (`script-src 'self'` holds), the worker is
 * same-origin (`worker-src 'self'`), and the icon font (codicon) is inlined into the stylesheet as a `data:` URL,
 * which `font-src 'self' data:` allows and the local server needs no `.ttf` type for. The service worker
 * does not precache this folder (it lists top-level files); it caches each file the first time the editor uses it.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

const root = path.join(import.meta.dir, "..");
const dist = path.resolve(process.argv[2] ?? path.join(root, "dist"));
const target = path.join(dist, "monaco-assets");

await fs.rm(target, { recursive: true, force: true });
await fs.mkdir(target, { recursive: true });

const define = { "process.env.NODE_ENV": '"production"' };

const engine = await Bun.build({
	entrypoints: [path.join(root, "src/components/ide/backend/monaco.ts")],
	outdir: target,
	target: "browser",
	format: "esm",
	splitting: true,
	minify: true,
	define,
	naming: { entry: "monaco.[ext]", chunk: "[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" },
});
if (!engine.success) throw new Error(`monaco bundle failed:\n${engine.logs.join("\n")}`);

const worker = await Bun.build({
	entrypoints: [Bun.resolveSync("monaco-editor/editor/editor.worker.js", root)],
	outdir: target,
	target: "browser",
	// A classic worker: every browser that runs the editor takes `new Worker(url)`.
	format: "iife",
	minify: true,
	define,
	naming: "editor.worker.[ext]",
});
if (!worker.success) throw new Error(`monaco worker bundle failed:\n${worker.logs.join("\n")}`);

// Inline the icon font: a `.ttf` is a file type the local server does not serve, and `data:` is in its `font-src`.
const cssPath = path.join(target, "monaco.css");
let css = await Bun.file(cssPath).text();
let inlined = 0;
for (const font of new Bun.Glob("*.ttf").scanSync({ cwd: target })) {
	const bytes = await Bun.file(path.join(target, font)).arrayBuffer();
	const url = `data:font/ttf;base64,${Buffer.from(bytes).toString("base64")}`;
	const before = css;
	css = css.replaceAll(`url(./${font})`, `url(${url})`).replaceAll(`url("./${font}")`, `url("${url}")`);
	if (css !== before) {
		inlined++;
		await fs.rm(path.join(target, font));
	}
}

// The bundler also writes the stylesheet again under a language chunk's name (a subset of the entry's, which
// the loader never requests). Drop it, but only after checking nothing in it would be lost.
const rulesOf = (text: string): Set<string> =>
	new Set(
		text
			.split("}")
			.map(rule => rule.trim())
			.filter(Boolean),
	);
const entryRules = rulesOf(css.replace(/url\(data:[^)]*\)/g, "url()"));
for (const stray of new Bun.Glob("*.css").scanSync({ cwd: target })) {
	if (stray === "monaco.css") continue;
	const strayRules = rulesOf((await Bun.file(path.join(target, stray)).text()).replace(/url\(data:[^)]*\)/g, "url()"));
	for (const rule of strayRules) {
		if (!entryRules.has(rule)) throw new Error(`${stray} has a rule monaco.css lacks: ${rule.slice(0, 80)}`);
	}
	await fs.rm(path.join(target, stray));
}
if (/url\(["']?\.\/[^)]*\.ttf/.test(css)) throw new Error("monaco.css still references a font file");
await Bun.write(cssPath, css);

const files = [...new Bun.Glob("**/*").scanSync({ cwd: target, onlyFiles: true })];
// Everything the engine and worker reach must be here; a missing piece would only fail in the browser.
for (const required of ["monaco.js", "monaco.css", "editor.worker.js"]) {
	if (!files.includes(required)) throw new Error(`monaco-assets/${required} was not built`);
}
const bytes = files.reduce((sum, file) => sum + Bun.file(path.join(target, file)).size, 0);
console.log(
	`build-monaco-assets: ${path.relative(process.cwd(), target)} (${files.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB, ${inlined} font inlined)`,
);
