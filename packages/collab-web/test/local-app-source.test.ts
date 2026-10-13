import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AppState, createLocalAppHandler } from "../scripts/local-app";
import { sourceHash, startSourceApp } from "../scripts/local-app-source";

let root: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "local-app-source-"));
	await write("packages/collab-web/src/main.tsx", "export {};");
	await write("packages/collab-web/public/favicon.svg", "<svg/>");
	await write("packages/collab-web/index.html", "<html></html>");
	await write("packages/wire/src/index.ts", "export const a = 1;");
	await write("bun.lock", "{}");
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

async function write(rel: string, text: string): Promise<void> {
	await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
	await Bun.write(path.join(root, rel), text);
}

const INDEX = (name: string) => `<!doctype html><html><body>${name}<script>1</script></body></html>`;

/** A build that writes `index.html` naming `label`, after `gate` (when given) resolves. */
function fakeBuild(label: string, gate?: Promise<void>, calls: string[] = []): (outdir: string) => Promise<void> {
	return async outdir => {
		calls.push(label);
		await gate;
		await fs.mkdir(outdir, { recursive: true });
		await Bun.write(path.join(outdir, "index.html"), INDEX(label));
	};
}

async function served(app: { state(): AppState }): Promise<string> {
	const response = await createLocalAppHandler(app.state)(new Request("http://127.0.0.1/"));
	return `${response.status} ${await response.text()}`;
}

describe("source hash", () => {
	it("changes with any build input and with nothing else", async () => {
		const before = await sourceHash(root, "1.0.0");
		expect(await sourceHash(root, "1.0.0")).toBe(before);

		await write("packages/collab-web/src/main.tsx", "export const x = 1;");
		const edited = await sourceHash(root, "1.0.0");
		expect(edited).not.toBe(before);

		await write("packages/collab-web/src/deep/new.ts", "");
		const added = await sourceHash(root, "1.0.0");
		expect(added).not.toBe(edited);

		await write("packages/wire/src/index.ts", "export const a = 2;");
		const wire = await sourceHash(root, "1.0.0");
		expect(wire).not.toBe(added);

		await write("bun.lock", '{"v":2}');
		const lock = await sourceHash(root, "1.0.0");
		expect(lock).not.toBe(wire);

		expect(await sourceHash(root, "1.0.1")).not.toBe(lock);

		// Files the build never reads do not invalidate it.
		await write("packages/collab-web/test/x.test.ts", "x");
		await write("packages/collab-web/scripts/companion.ts", "x");
		await write("README.md", "x");
		expect(await sourceHash(root, "1.0.0")).toBe(lock);
	});

	it("tells moved bytes from unchanged ones", async () => {
		await write("packages/collab-web/src/a.ts", "ab");
		await write("packages/collab-web/src/b.ts", "c");
		const one = await sourceHash(root, "1");
		await write("packages/collab-web/src/a.ts", "a");
		await write("packages/collab-web/src/b.ts", "bc");
		expect(await sourceHash(root, "1")).not.toBe(one);
	});
});

describe("the app built from source", () => {
	it("builds when there is no build, shows 'building' until it is ready, then serves it and reuses it next time", async () => {
		const cacheDir = path.join(root, "cache");
		const gate = Promise.withResolvers<void>();
		const calls: string[] = [];
		const logs: string[] = [];
		const first = startSourceApp({
			cacheDir,
			repoDir: root,
			build: fakeBuild("one", gate.promise, calls),
			log: line => logs.push(line),
		});
		await Bun.sleep(30);
		const early = await createLocalAppHandler(first.state)(
			new Request("http://127.0.0.1/", { headers: { "sec-fetch-mode": "navigate" } }),
		);
		expect(early.status).toBe(503);
		expect(await early.text()).toContain("Building");
		gate.resolve();
		await first.settled;
		expect(await served(first)).toContain("200 <!doctype html><html><body>one");
		expect(calls).toEqual(["one"]);

		// Same sources: the build on disk is served and nothing is built.
		const second = startSourceApp({
			cacheDir,
			repoDir: root,
			build: fakeBuild("two", undefined, calls),
			log: () => {},
		});
		await second.settled;
		expect(calls).toEqual(["one"]);
		expect(await served(second)).toContain("one");
	});

	it("keeps serving the previous build while a changed source builds, then switches and prunes old builds", async () => {
		const cacheDir = path.join(root, "cache");
		const build = (label: string, gate?: Promise<void>) =>
			startSourceApp({ cacheDir, repoDir: root, build: fakeBuild(label, gate), log: () => {} });
		await build("v1").settled;
		await Bun.sleep(15);
		await write("packages/collab-web/src/main.tsx", "export const v = 2;");
		await build("v2").settled;
		await Bun.sleep(15);
		await write("packages/collab-web/src/main.tsx", "export const v = 3;");
		const gate = Promise.withResolvers<void>();
		const third = build("v3", gate.promise);
		await Bun.sleep(30);
		expect(await served(third)).toContain("v2");
		gate.resolve();
		await third.settled;
		expect(await served(third)).toContain("v3");
		// Newest two kept; v1 pruned; no half-built directory left behind.
		const left = (await fs.readdir(cacheDir)).sort();
		expect(left).toHaveLength(2);
		expect(left.every(name => /^[0-9a-f]{16}$/.test(name))).toBe(true);
		const labels = await Promise.all(left.map(name => Bun.file(path.join(cacheDir, name, "index.html")).text()));
		expect(labels.some(text => text.includes("v3"))).toBe(true);
		expect(labels.some(text => text.includes("v2"))).toBe(true);
	});

	it("serves what it has when a rebuild fails, and reports a failure only when there is nothing to serve", async () => {
		const cacheDir = path.join(root, "cache");
		await startSourceApp({ cacheDir, repoDir: root, build: fakeBuild("good"), log: () => {} }).settled;
		await Bun.sleep(15);
		await write("packages/collab-web/src/main.tsx", "export const broken = true;");
		const failing = startSourceApp({
			cacheDir,
			repoDir: root,
			build: async () => {
				throw new Error("boom");
			},
			log: () => {},
		});
		await failing.settled;
		expect(await served(failing)).toContain("good");

		const empty = startSourceApp({
			cacheDir: path.join(root, "empty"),
			repoDir: root,
			build: async () => {
				throw new Error("boom");
			},
			log: () => {},
		});
		await empty.settled;
		expect((await served(empty)).startsWith("503")).toBe(true);
		// A failed build leaves no staging directory.
		expect(await fs.readdir(path.join(root, "empty"))).toEqual([]);
	});

	it("removes staging directories of processes that are gone", async () => {
		const cacheDir = path.join(root, "cache");
		const dead = path.join(cacheDir, "0123456789abcdef.tmp-2147483646");
		await fs.mkdir(dead, { recursive: true });
		await Bun.write(path.join(dead, "index.html"), "half");
		await startSourceApp({ cacheDir, repoDir: root, build: fakeBuild("x"), log: () => {} }).settled;
		expect(await Bun.file(path.join(dead, "index.html")).exists()).toBe(false);
	});
});
