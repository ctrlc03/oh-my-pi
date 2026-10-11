import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Mermaid and Excalidraw weigh megabytes; the app's entry bundle must never pull them in. Two checks: the
 * source (only the two engine modules import the packages, and only through `import()`), and a real bundle
 * (no module of either package lands in the entry's output).
 */

const root = path.join(import.meta.dir, "..");
const src = path.join(root, "src");

const HEAVY = /^(mermaid|@excalidraw\/[\w-]+)(\/|$)/;
const ENGINES = ["lib/mermaid-engine.ts", "lib/excalidraw-engine.ts"];

const sources = [...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: src })].map(file => ({
	file,
	text: fs.readFileSync(path.join(src, file), "utf8"),
}));

/** Import statements as [full statement, specifier]. `import type` statements are marked by the first element. */
function staticImports(text: string): { statement: string; specifier: string }[] {
	const found: { statement: string; specifier: string }[] = [];
	for (const match of text.matchAll(
		/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm,
	)) {
		found.push({ statement: match[0].trim(), specifier: match[1] ?? match[2]! });
	}
	return found;
}

describe("diagram engines stay lazy", () => {
	it("imports the heavy packages at run time only from the two engine modules", () => {
		const offenders: string[] = [];
		for (const { file, text } of sources) {
			if (ENGINES.includes(file)) continue;
			for (const { statement, specifier } of staticImports(text)) {
				if (HEAVY.test(specifier) && !/^(import|export)\s+type\b/.test(statement))
					offenders.push(`${file}: ${statement}`);
			}
			for (const match of text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
				if (HEAVY.test(match[1]!)) offenders.push(`${file}: ${match[0]}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("reaches the engine modules only through dynamic import()", () => {
		const offenders: string[] = [];
		for (const { file, text } of sources) {
			for (const { statement, specifier } of staticImports(text)) {
				const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
				if (ENGINES.some(engine => target === engine.replace(/\.ts$/, "") || target === engine)) {
					if (!/^(import|export)\s+type\b/.test(statement)) offenders.push(`${file}: ${statement}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	it("is reached through dynamic import() somewhere, so the engines are not dead code", () => {
		const all = sources.map(source => source.text).join("\n");
		expect(all).toMatch(/import\(\s*["']\.\/mermaid-engine["']\s*\)/);
		expect(all).toMatch(/import\(\s*["']\.\/excalidraw-engine["']\s*\)/);
	});

	it("keeps both packages out of the entry bundle", async () => {
		const result = await Bun.build({
			entrypoints: [path.join(root, "index.html")],
			splitting: true,
			minify: false,
			metafile: true,
			define: { "process.env.NODE_ENV": '"production"' },
		});
		expect(result.success).toBe(true);
		const outputs = result.metafile?.outputs ?? {};
		const entries = Object.entries(outputs).filter(
			([, info]) => info.entryPoint?.endsWith("index.html") && info.bytes > 0,
		);
		expect(entries.length).toBeGreaterThan(0);
		for (const [name, info] of Object.entries(outputs)) {
			const heavy = Object.keys(info.inputs).filter(input => /node_modules\/(mermaid|@excalidraw)\//.test(input));
			if (name.endsWith(".html")) continue;
			// The module that hosts either engine is a lazy chunk; the entry output is the one the page loads.
			if (info.entryPoint?.endsWith("index.html")) expect(heavy).toEqual([]);
		}
		const engineChunks = Object.values(outputs).filter(info =>
			/(mermaid|excalidraw)-engine\.ts$/.test(info.entryPoint ?? ""),
		);
		expect(engineChunks.length).toBe(2);
	}, 120_000);
});
