#!/usr/bin/env bun
/**
 * Build the collab web app into a directory: the bundle, the public files, Excalidraw's assets and the service
 * worker. This is the one pipeline behind `bun run build` (Pages: `dist/`), the build the companion makes of
 * itself in a checkout (`local-app-source.ts`) and the build the release binary embeds (`build-collab-binary.ts`).
 *
 *   bun scripts/build-app.ts [--outdir <dir>] [--local]
 *
 * `--local` is for the copy this computer serves to its own browser: it drops the analytics beacon (the Pages
 * workflow deletes it from `index.html` before building, with the same effect), so the app makes no request
 * to any host but the relays and the companion. Nothing else differs.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

const root = path.join(import.meta.dir, "..");

/** The analytics comment and `<script>` line of `index.html`; each sits on its own line in the built page. */
const ANALYTICS_RE =
	/^[\t ]*<!-- Analytics\..*-->\n[\t ]*<script[^>\n]*src="https:\/\/um\.can\.ac\/[^"\n]*"[^>\n]*><\/script>\n/m;

/** Run one step. `quiet` keeps its output out of the caller's: it is part of the error when the step fails. */
async function run(command: string[], quiet: boolean): Promise<void> {
	const proc = Bun.spawn(command, {
		cwd: root,
		stdin: "ignore",
		stdout: quiet ? "pipe" : "inherit",
		stderr: quiet ? "pipe" : "inherit",
	});
	const [out, err, code] = await Promise.all([
		quiet ? new Response(proc.stdout).text() : "",
		quiet ? new Response(proc.stderr).text() : "",
		proc.exited,
	]);
	if (code !== 0)
		throw new Error(`${command.join(" ")} exited with ${code}${quiet ? `\n${out}${err}`.trimEnd() : ""}`);
}

/** Build the app into `outdir`, which is emptied first. `quiet`: print nothing unless a step fails. */
export async function buildApp(outdir: string, options: { local: boolean; quiet?: boolean }): Promise<void> {
	const bun = process.execPath;
	const quiet = options.quiet ?? false;
	await fs.rm(outdir, { recursive: true, force: true });
	await run(
		[
			bun,
			"build",
			"./index.html",
			`--outdir=${outdir}`,
			"--minify",
			"--splitting",
			`--metafile=${path.join(outdir, ".meta.json")}`,
			"--define",
			'process.env.NODE_ENV="production"',
			"--entry-naming=[hash].[ext]",
			"--chunk-naming=[hash].[ext]",
			"--asset-naming=[hash].[ext]",
		],
		quiet,
	);
	const html = (await Array.fromAsync(new Bun.Glob("*.html").scan({ cwd: outdir }))).sort();
	if (html.length !== 1) throw new Error(`expected one built html file, found ${html.join(", ") || "none"}`);
	if (html[0] !== "index.html") await fs.rename(path.join(outdir, html[0]!), path.join(outdir, "index.html"));
	await fs.cp(path.join(root, "public"), outdir, { recursive: true });
	await run([bun, path.join(import.meta.dir, "build-assets.ts"), outdir], quiet);
	if (options.local) {
		const indexPath = path.join(outdir, "index.html");
		const page = await Bun.file(indexPath).text();
		const stripped = page.replace(ANALYTICS_RE, "");
		// A page without the block (the Pages workflow's sed already removed it) is fine; a block that survives is not.
		if (stripped.includes("um.can.ac")) throw new Error("built index.html still references the analytics host");
		await Bun.write(indexPath, stripped);
	}
	await run([bun, path.join(import.meta.dir, "build-sw.ts"), outdir], quiet);
}

function argValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

if (import.meta.main) {
	await buildApp(path.resolve(argValue("--outdir") ?? path.join(root, "dist")), {
		local: process.argv.includes("--local"),
	});
}
