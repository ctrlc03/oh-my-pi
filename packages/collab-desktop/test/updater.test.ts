import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { UpdateOffer } from "../src/main/release";
import {
	downloadVerified,
	type Fetch,
	fetchOffer,
	type Run,
	shellQuote,
	stageUpdate,
	swapScript,
} from "../src/main/updater";

const dirs: string[] = [];
const tmp = (): string => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-updater-test-"));
	dirs.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const BYTES = new TextEncoder().encode("pretend this is an app zip".repeat(100));

const offerFor = (bytes: Uint8Array, over: Partial<UpdateOffer> = {}): UpdateOffer => ({
	tag: "collab-v18.10.5-1",
	name: "collab-desktop-darwin-arm64.zip",
	url: "https://github.com/o/r/releases/download/collab-v18.10.5-1/collab-desktop-darwin-arm64.zip",
	size: bytes.byteLength,
	githubSha256: null,
	checksumsUrl: "https://github.com/o/r/releases/download/collab-v18.10.5-1/SHA256SUMS.txt",
	...over,
});

/** A fetch that serves the checksums file and the zip from memory, in two chunks. */
function serve(zip: Uint8Array, sums: string): { fetch: Fetch; requested: string[] } {
	const requested: string[] = [];
	const fetch: Fetch = async url => {
		requested.push(url);
		if (url.endsWith("SHA256SUMS.txt")) return new Response(sums);
		const half = Math.floor(zip.byteLength / 2);
		return new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(zip.slice(0, half));
					controller.enqueue(zip.slice(half));
					controller.close();
				},
			}),
		);
	};
	return { fetch, requested };
}

describe("downloadVerified", () => {
	it("writes the file once its size and checksum match", async () => {
		const dest = path.join(tmp(), "t", "app.zip");
		const { fetch } = serve(BYTES, `${sha(BYTES)}  collab-desktop-darwin-arm64.zip\n`);
		const progress: number[] = [];
		const result = await downloadVerified(offerFor(BYTES), dest, {
			fetch,
			onProgress: received => progress.push(received),
		});
		expect(result.sha256).toBe(sha(BYTES));
		expect(new Uint8Array(fs.readFileSync(dest))).toEqual(BYTES);
		expect(fs.existsSync(`${dest}.part`)).toBe(false);
		expect(progress.at(-1)).toBe(BYTES.byteLength);
	});

	it("keeps nothing when the checksum does not match", async () => {
		const dest = path.join(tmp(), "app.zip");
		const { fetch } = serve(BYTES, `${"0".repeat(64)}  collab-desktop-darwin-arm64.zip\n`);
		await expect(downloadVerified(offerFor(BYTES), dest, { fetch })).rejects.toThrow("checksum mismatch");
		expect(fs.existsSync(dest)).toBe(false);
		expect(fs.existsSync(`${dest}.part`)).toBe(false);
	});

	it("refuses a file larger than the release says, and one that is short", async () => {
		const dir = tmp();
		const sums = `${sha(BYTES)}  collab-desktop-darwin-arm64.zip\n`;
		await expect(
			downloadVerified(offerFor(BYTES, { size: 10 }), path.join(dir, "a.zip"), { fetch: serve(BYTES, sums).fetch }),
		).rejects.toThrow("larger");
		await expect(
			downloadVerified(offerFor(BYTES, { size: BYTES.byteLength + 1 }), path.join(dir, "b.zip"), {
				fetch: serve(BYTES, sums).fetch,
			}),
		).rejects.toThrow("bytes");
		expect(fs.readdirSync(dir)).toEqual([]);
	});

	it("refuses when the checksums file does not list the app or disagrees with GitHub", async () => {
		const dest = path.join(tmp(), "app.zip");
		await expect(
			downloadVerified(offerFor(BYTES), dest, { fetch: serve(BYTES, `${sha(BYTES)}  other.zip\n`).fetch }),
		).rejects.toThrow("no entry");
		await expect(
			downloadVerified(offerFor(BYTES, { githubSha256: "f".repeat(64) }), dest, {
				fetch: serve(BYTES, `${sha(BYTES)}  collab-desktop-darwin-arm64.zip\n`).fetch,
			}),
		).rejects.toThrow("disagree");
	});

	it("does not download the app when the checksums cannot be fetched", async () => {
		const requested: string[] = [];
		const fetch: Fetch = async url => {
			requested.push(url);
			return new Response("nope", { status: 404 });
		};
		await expect(downloadVerified(offerFor(BYTES), path.join(tmp(), "x.zip"), { fetch })).rejects.toThrow("404");
		expect(requested.length).toBe(1);
	});
});

describe("fetchOffer", () => {
	it("lists the releases of the repository and selects from them", async () => {
		const urls: string[] = [];
		const base = "https://github.com/o/r/releases/download/collab-v2.0.0-1";
		const fetch: Fetch = async url => {
			urls.push(url);
			return Response.json([
				{
					tag_name: "collab-v2.0.0-1",
					draft: false,
					prerelease: false,
					assets: [
						{
							name: "collab-desktop-darwin-arm64.zip",
							state: "uploaded",
							size: 9,
							browser_download_url: `${base}/collab-desktop-darwin-arm64.zip`,
						},
						{
							name: "SHA256SUMS.txt",
							state: "uploaded",
							size: 9,
							browser_download_url: `${base}/SHA256SUMS.txt`,
						},
					],
				},
			]);
		};
		const offer = await fetchOffer({
			repo: "o/r",
			current: "collab-v1.0.0-1",
			platform: "darwin",
			arch: "arm64",
			fetch,
		});
		expect(offer?.tag).toBe("collab-v2.0.0-1");
		expect(urls).toEqual(["https://api.github.com/repos/o/r/releases?per_page=30"]);
	});

	it("fails on an HTTP error", async () => {
		const fetch: Fetch = async () => new Response("", { status: 403 });
		await expect(
			fetchOffer({ repo: "o/r", current: null, platform: "darwin", arch: "arm64", fetch }),
		).rejects.toThrow("403");
	});
});

describe("stageUpdate", () => {
	/** A `run` that fakes ditto (makes a bundle), plutil (answers from `plist`) and codesign. */
	function fakeRun(
		plist: Record<string, string>,
		options: { apps?: string[]; codesign?: number } = {},
	): { run: Run; calls: string[] } {
		const calls: string[] = [];
		const run: Run = async (command, args) => {
			calls.push(path.basename(command));
			if (command.endsWith("ditto")) {
				for (const app of options.apps ?? ["omp collab.app"])
					fs.mkdirSync(path.join(args[3]!, app, "Contents"), { recursive: true });
				return { code: 0, out: "" };
			}
			if (command.endsWith("plutil")) {
				const value = plist[args[1]!];
				return value === undefined ? { code: 1, out: "no such key" } : { code: 0, out: `${value}\n` };
			}
			return { code: options.codesign ?? 0, out: "invalid signature" };
		};
		return { run, calls };
	}
	const expectation = { bundleId: "sh.omp.collab.desktop", tag: "collab-v18.10.5-1" };
	const good = { CFBundleIdentifier: "sh.omp.collab.desktop", OmpBuildTag: "collab-v18.10.5-1" };

	it("unpacks and returns the verified bundle", async () => {
		const staging = path.join(tmp(), "staging");
		const { run, calls } = fakeRun(good);
		const bundle = await stageUpdate("/z.zip", staging, expectation, run);
		expect(bundle).toBe(path.join(staging, "omp collab.app"));
		expect(calls).toEqual(["ditto", "plutil", "plutil", "codesign"]);
	});

	it("refuses another app, another build, a broken signature, or a zip with several apps", async () => {
		const staging = path.join(tmp(), "staging");
		await expect(
			stageUpdate("/z.zip", staging, expectation, fakeRun({ ...good, CFBundleIdentifier: "com.other" }).run),
		).rejects.toThrow("not this app");
		await expect(
			stageUpdate("/z.zip", staging, expectation, fakeRun({ ...good, OmpBuildTag: "collab-v1.0.0-1" }).run),
		).rejects.toThrow("expected collab-v18.10.5-1");
		await expect(stageUpdate("/z.zip", staging, expectation, fakeRun(good, { codesign: 1 }).run)).rejects.toThrow(
			"signature",
		);
		await expect(
			stageUpdate("/z.zip", staging, expectation, fakeRun(good, { apps: ["a.app", "b.app"] }).run),
		).rejects.toThrow("2 apps");
	});
});

describe("swapScript", () => {
	it("quotes paths so a name with spaces or quotes stays one word", () => {
		expect(shellQuote("/Applications/omp collab.app")).toBe("'/Applications/omp collab.app'");
		expect(shellQuote("it's")).toBe("'it'\\''s'");
	});

	function sandbox(): { bundle: string; staged: string; stagingDir: string; root: string } {
		const root = tmp();
		const bundle = path.join(root, "Apps", "omp collab.app");
		const stagingDir = path.join(root, "Apps", ".omp-collab-update");
		const staged = path.join(stagingDir, "omp collab.app");
		for (const [dir, version] of [
			[bundle, "old"],
			[staged, "new"],
		] as const) {
			fs.mkdirSync(path.join(dir, "Contents"), { recursive: true });
			fs.writeFileSync(path.join(dir, "Contents", "version"), version);
		}
		return { bundle, staged, stagingDir, root };
	}
	const run = (script: string): number => Bun.spawnSync(["/bin/sh", script]).exitCode ?? 1;
	const plan = (s: ReturnType<typeof sandbox>, over: object = {}) => ({
		pid: 2 ** 22 + 12345,
		bundle: s.bundle,
		staged: s.staged,
		stagingDir: s.stagingDir,
		relaunch: false,
		waitSeconds: 2,
		...over,
	});

	it("replaces the bundle with the staged one and cleans up", () => {
		const s = sandbox();
		const script = path.join(s.root, "swap.sh");
		fs.writeFileSync(script, swapScript(plan(s)));
		expect(run(script)).toBe(0);
		expect(fs.readFileSync(path.join(s.bundle, "Contents", "version"), "utf8")).toBe("new");
		expect(fs.existsSync(`${s.bundle}.old`)).toBe(false);
		expect(fs.existsSync(s.stagingDir)).toBe(false);
	});

	it("puts the old bundle back when the move fails", () => {
		const s = sandbox();
		fs.rmSync(s.staged, { recursive: true });
		const script = path.join(s.root, "swap.sh");
		fs.writeFileSync(script, swapScript(plan(s)));
		expect(run(script)).toBe(1);
		expect(fs.readFileSync(path.join(s.bundle, "Contents", "version"), "utf8")).toBe("old");
		expect(fs.existsSync(`${s.bundle}.old`)).toBe(false);
	});

	it("waits for the app to exit and gives up, touching nothing, if it does not", () => {
		const s = sandbox();
		const script = path.join(s.root, "swap.sh");
		fs.writeFileSync(script, swapScript(plan(s, { pid: process.pid, waitSeconds: 1 })));
		expect(run(script)).toBe(1);
		expect(fs.readFileSync(path.join(s.bundle, "Contents", "version"), "utf8")).toBe("old");
	});

	it("opens the new app only when asked to relaunch", () => {
		const s = sandbox();
		expect(swapScript(plan(s, { relaunch: true }))).toContain('open "$BUNDLE"');
		expect(swapScript(plan(s, { relaunch: false }))).not.toContain("open ");
	});
});
