/**
 * Bundles the main process and the preload script into `dist/` and records which release this build is for.
 * Both are CommonJS (`.cjs`: this package is `"type": "module"`, and a sandboxed preload cannot be an ES module);
 * `electron` stays external, and everything else is bundled so the packaged app needs no `node_modules`.
 *
 *   OMP_BUILD_TAG=collab-v18.10.4-1 OMP_RELEASE_REPO=owner/name bun scripts/build.ts
 *
 * Without OMP_BUILD_TAG the build is a development build: it never offers or applies updates.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.join(import.meta.dir, "..");
const outdir = path.join(root, "dist");
fs.rmSync(outdir, { recursive: true, force: true });

for (const [entry, name] of [
	["src/main/index.ts", "main"],
	["src/preload/index.ts", "preload"],
] as const) {
	const result = await Bun.build({
		entrypoints: [path.join(root, entry)],
		outdir,
		target: "node",
		format: "cjs",
		external: ["electron"],
		naming: `${name}.cjs`,
		minify: false,
		sourcemap: "none",
	});
	if (!result.success) {
		for (const message of result.logs) console.error(message);
		process.exit(1);
	}
}

const tag = process.env.OMP_BUILD_TAG ?? null;
const repo = process.env.OMP_RELEASE_REPO || "ctrlc03/oh-my-pi";
fs.writeFileSync(path.join(outdir, "build-info.json"), `${JSON.stringify({ tag, repo }, null, "\t")}\n`);
console.log(`built dist/main.cjs and dist/preload.cjs (${tag ?? "development build"})`);
