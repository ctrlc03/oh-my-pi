import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/** The worker's runtime-cache predicate, lifted from the generator's template so the test runs the shipped code. */
const source = fs.readFileSync(path.join(import.meta.dir, "..", "scripts", "build-sw.ts"), "utf8");
const body = /function isRuntimeAsset\(url\) \{[\s\S]*?\n\}/.exec(source)?.[0];
if (body === undefined) throw new Error("isRuntimeAsset not found in build-sw.ts");

function predicate(base: string): (url: URL) => boolean {
	return new Function("BASE_PATH", `${body}; return isRuntimeAsset;`)(base) as (url: URL) => boolean;
}

describe("service worker runtime cache", () => {
	const at = (base: string, rel: string): boolean => predicate(base)(new URL(rel, `https://x.example${base}`));

	it("caches hashed build files and Excalidraw assets", () => {
		expect(at("/", "abc123.js")).toBe(true);
		expect(at("/", "abc123.css")).toBe(true);
		expect(at("/", "excalidraw-assets/fonts/Virgil/Virgil-Regular.woff2")).toBe(true);
		expect(at("/", "excalidraw-assets/index.css")).toBe(true);
	});

	it("works under a path prefix", () => {
		expect(at("/omp/", "abc123.js")).toBe(true);
		expect(predicate("/omp/")(new URL("https://x.example/other/abc123.js"))).toBe(false);
	});

	it("never caches other same-origin requests", () => {
		expect(at("/", "api/session")).toBe(false);
		expect(at("/", "data.json")).toBe(false);
		expect(at("/", "nested/app.js")).toBe(false);
		expect(at("/", "excalidraw-assets")).toBe(false);
	});

	it("never caches a URL with a query", () => {
		expect(at("/", "abc123.js?token=1")).toBe(false);
		expect(at("/", "excalidraw-assets/index.css?x")).toBe(false);
	});

	it("stores only whole 200 answers, without ignoring the query", () => {
		const handler = /isRuntimeAsset\(url\)\) \{[\s\S]*?return;\n\t\}/.exec(source)?.[0] ?? "";
		expect(handler).toContain("res.status === 200");
		expect(handler).not.toContain("ignoreSearch");
	});
});
