import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createScratchFolder, gitCheckoutAbove } from "../scripts/companion-scratch";
import { SANDBOX_EXEC, sandboxProfile } from "../scripts/companion-sandbox";
import {
	createKeyedLock,
	findTmux,
	launchInTmux,
	MAX_START_PROMPT_CHARS,
	parseStartPrompt,
} from "../scripts/companion-start";

let root: string;
const day = new Date(2026, 9, 11, 9, 30);

beforeAll(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-scratch-test-")));
});

afterAll(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

/** A fresh omp config dir (what `PI_CONFIG_DIR` names) under `root`. */
async function configDir(name: string): Promise<string> {
	const dir = path.join(root, name, ".omp");
	await fs.mkdir(dir, { recursive: true });
	return dir;
}

describe("createScratchFolder", () => {
	it("makes <config dir>/scratch/<date>-<slug>-<id> and resolves with its realpath", async () => {
		const cfg = await configDir("make");
		const folder = await createScratchFolder({
			configDir: cfg,
			hint: "Convert the PNGs!",
			now: day,
			id: () => "abc123",
		});
		expect(folder).toBe(path.join(cfg, "scratch", "2026-10-11-convert-the-pngs-abc123"));
		expect((await fs.stat(folder)).isDirectory()).toBe(true);
		expect(await fs.readdir(folder)).toEqual([]);
	});

	it("names a session without a prompt `session`, and makes the config dir's scratch folder when it is missing", async () => {
		const cfg = path.join(root, "missing", "deeper", ".omp");
		const folder = await createScratchFolder({ configDir: cfg, now: day, id: () => "000001" });
		expect(path.basename(folder)).toBe("2026-10-11-session-000001");
		expect((await fs.stat(folder)).isDirectory()).toBe(true);
	});

	it("gives every call its own folder, also for the same day and prompt", async () => {
		const cfg = await configDir("many");
		const folders = await Promise.all(
			Array.from({ length: 8 }, () => createScratchFolder({ configDir: cfg, hint: "same prompt", now: day })),
		);
		expect(new Set(folders).size).toBe(8);
		for (const folder of folders) expect(path.basename(folder)).toMatch(/^2026-10-11-same-prompt-[0-9a-f]{6}$/);
	});

	it("tries another id when the name is taken, and never reuses (or touches) the folder that was", async () => {
		const cfg = await configDir("collide");
		const ids = ["aaaaaa", "aaaaaa", "bbbbbb"];
		const next = () => ids.shift() as string;
		const first = await createScratchFolder({ configDir: cfg, hint: "x", now: day, id: next });
		await fs.writeFile(path.join(first, "keep.txt"), "mine");
		const second = await createScratchFolder({ configDir: cfg, hint: "x", now: day, id: next });
		expect(path.basename(first)).toBe("2026-10-11-x-aaaaaa");
		expect(path.basename(second)).toBe("2026-10-11-x-bbbbbb");
		expect(await Bun.file(path.join(first, "keep.txt")).text()).toBe("mine");
	});

	it("gives up when no name is free", async () => {
		const cfg = await configDir("exhausted");
		await createScratchFolder({ configDir: cfg, now: day, id: () => "ffffff" });
		await expect(createScratchFolder({ configDir: cfg, now: day, id: () => "ffffff" })).rejects.toThrow(
			"free scratch folder name",
		);
	});

	it("refuses when the config dir is inside a git checkout, and creates nothing there", async () => {
		const repo = path.join(root, "checkout");
		await fs.mkdir(path.join(repo, ".git"), { recursive: true });
		const cfg = path.join(repo, "home", ".omp");
		await expect(createScratchFolder({ configDir: cfg, hint: "x", now: day })).rejects.toThrow(`inside ${repo}`);
		expect(await fs.stat(path.join(repo, "home")).catch(() => null)).toBeNull();
		// A linked worktree has `.git` as a file; so does a submodule.
		const linked = path.join(root, "linked");
		await fs.mkdir(linked, { recursive: true });
		await fs.writeFile(path.join(linked, ".git"), "gitdir: /elsewhere\n");
		await expect(createScratchFolder({ configDir: path.join(linked, ".omp"), now: day })).rejects.toThrow(
			"git checkouts",
		);
	});

	it("refuses a config dir that only reaches a checkout through a symlink", async () => {
		const repo = path.join(root, "behind-link");
		await fs.mkdir(path.join(repo, ".git"), { recursive: true });
		await fs.mkdir(path.join(repo, "cfg"), { recursive: true });
		const link = path.join(root, "link-to-cfg");
		await fs.symlink(path.join(repo, "cfg"), link);
		await expect(createScratchFolder({ configDir: link, now: day })).rejects.toThrow("git checkouts");
	});

	it("does not mind a repository next to the config dir or below the scratch folder's parents' siblings", async () => {
		const cfg = await configDir("sibling");
		await fs.mkdir(path.join(path.dirname(cfg), "project", ".git"), { recursive: true });
		expect(await gitCheckoutAbove(path.join(cfg, "scratch"))).toBeNull();
		expect(await createScratchFolder({ configDir: cfg, now: day })).toContain(`${path.sep}scratch${path.sep}`);
	});
});

describe("parseStartPrompt", () => {
	it("trims, treats blank as none, and refuses what cannot be a prompt", () => {
		expect(parseStartPrompt(undefined)).toBeUndefined();
		expect(parseStartPrompt("  \n ")).toBeUndefined();
		expect(parseStartPrompt("  fix it \n")).toBe("fix it");
		expect(() => parseStartPrompt(3)).toThrow("invalid prompt");
		expect(() => parseStartPrompt("a\0b")).toThrow("invalid prompt");
		expect(() => parseStartPrompt("x".repeat(MAX_START_PROMPT_CHARS + 1))).toThrow("over");
	});
});

describe("createKeyedLock", () => {
	it("runs one key's tasks one after another, even when an earlier one fails, and other keys at once", async () => {
		const lock = createKeyedLock();
		const log: string[] = [];
		const task =
			(label: string, ms: number, fail = false) =>
			async () => {
				log.push(`${label} start`);
				await Bun.sleep(ms);
				log.push(`${label} end`);
				if (fail) throw new Error(label);
				return label;
			};
		const results = await Promise.allSettled([
			lock("a", task("a1", 30, true)),
			lock("a", task("a2", 5)),
			lock("b", task("b1", 5)),
		]);
		expect(results.map(r => r.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
		expect(log.indexOf("a1 end")).toBeLessThan(log.indexOf("a2 start"));
		expect(log.indexOf("b1 end")).toBeLessThan(log.indexOf("a1 end"));
	});
});

const tmuxBin = await findTmux();
const canSandbox = process.platform === "darwin" && (await Bun.file(SANDBOX_EXEC).exists());

describe.skipIf(tmuxBin === null)(
	"a session without a project, started like the companion does, in a private tmux",
	() => {
		let base: string;
		let wrapper: string;
		let fakeOmp: string;
		let cfg: string;

		beforeAll(async () => {
			base = await fs.realpath(await fs.mkdtemp("/tmp/oss-"));
			// A private tmux server (own socket and socket dir; short paths, as a socket path takes about 100 characters): never the default one.
			wrapper = path.join(base, "tmux");
			await fs.writeFile(
				wrapper,
				`#!/bin/sh\ncd '${base}' && TMUX_TMPDIR='${base}' exec '${tmuxBin}' -L oss "$@"\n`,
				{ mode: 0o700 },
			);
			// Stands in for omp: reports where it ran and what it got, in the folder itself (a sandboxed one may write nowhere else),
			// and whether it could also write outside it.
			fakeOmp = path.join(base, "fake-omp");
			await fs.writeFile(
				fakeOmp,
				`#!/bin/sh\n{ pwd; for a in "$@"; do printf '[%s]\\n' "$a"; done; touch '${base}/escaped' 2>/dev/null && echo escaped-yes || echo escaped-no; } > ./report.tmp && mv ./report.tmp ./report\n`,
				{ mode: 0o700 },
			);
			cfg = path.join(base, "home", ".omp");
			await fs.mkdir(path.join(cfg, "agent"), { recursive: true });
		});

		afterAll(async () => {
			const stop = Bun.spawn([wrapper, "kill-server"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
			await stop.exited;
			await fs.rm(base, { recursive: true, force: true });
		});

		async function report(folder: string): Promise<string[]> {
			const deadline = Date.now() + 10_000;
			while (Date.now() < deadline) {
				const text = await Bun.file(path.join(folder, "report"))
					.text()
					.catch(() => null);
				if (text !== null) return text.trim().split("\n");
				await Bun.sleep(20);
			}
			throw new Error("the stand-in omp never ran");
		}

		it("runs omp in the new folder with the prompt, and the folder stays when the session has ended", async () => {
			const folder = await createScratchFolder({ configDir: cfg, hint: "convert pngs", now: day });
			const launched = await launchInTmux({
				tmux: wrapper,
				ompBin: fakeOmp,
				overlayPath: path.join(cfg, "agent", "overlay.yml"),
				promptDir: path.join(cfg, "run", "collab-companion"),
				cwd: folder,
				prompt: "convert pngs",
			});
			expect(launched.cwd).toBe(folder);
			const lines = await report(folder);
			expect(lines[0]).toBe(folder);
			expect(lines.slice(1)).toEqual([
				"[--config]",
				`[${path.join(cfg, "agent", "overlay.yml")}]`,
				"[--]",
				"[convert pngs]",
				"escaped-yes",
			]);
			expect(path.basename(folder)).toMatch(/^2026-10-11-convert-pngs-[0-9a-f]{6}$/);
			// omp exited, so its tmux session is gone; the folder and what the session wrote are not.
			const deadline = Date.now() + 10_000;
			let sessions = "x";
			while (Date.now() < deadline && sessions !== "") {
				const list = Bun.spawn([wrapper, "list-sessions", "-F", "#{session_name}"], {
					stdout: "pipe",
					stderr: "ignore",
					stdin: "ignore",
				});
				sessions = (await new Response(list.stdout).text()).trim();
				await list.exited;
				if (sessions !== "") await Bun.sleep(50);
			}
			expect(sessions).toBe("");
			expect(await Bun.file(path.join(folder, "report")).exists()).toBe(true);
		});

		it.skipIf(!canSandbox)(
			"runs a sandboxed session there: its writes land in the folder, nowhere else",
			async () => {
				await fs.rm(path.join(base, "escaped"), { force: true });
				const folder = await createScratchFolder({ configDir: cfg, hint: "sandboxed work", now: day });
				const launched = await launchInTmux({
					tmux: wrapper,
					ompBin: fakeOmp,
					overlayPath: path.join(cfg, "agent", "overlay.yml"),
					promptDir: path.join(cfg, "run", "collab-companion"),
					cwd: folder,
					sandbox: {
						home: path.join(base, "home"),
						configDir: cfg,
						tmpDir: path.join(base, "sandbox-tmp"),
						companionState: path.join(cfg, "agent", "collab-companion.json"),
						overlayPath: path.join(cfg, "agent", "sandbox.yml"),
					},
				});
				expect(launched.cwd).toBe(folder);
				const lines = await report(folder);
				expect(lines[0]).toBe(folder);
				expect(lines).toContain("[--tools]");
				expect(lines.at(-1)).toBe("escaped-no");
				expect(await Bun.file(path.join(base, "escaped")).exists()).toBe(false);
			},
		);
	},
);

describe.skipIf(!canSandbox)("the sandbox profile for a scratch folder", () => {
	let paths: Parameters<typeof sandboxProfile>[0];
	let cfg: string;

	async function sandboxed(script: string): Promise<number> {
		const proc = Bun.spawn([SANDBOX_EXEC, "-p", sandboxProfile(paths), "/bin/sh", "-c", script], {
			stdout: "ignore",
			stderr: "ignore",
		});
		return await proc.exited;
	}

	beforeAll(async () => {
		const home = path.join(root, "sbx", "home");
		cfg = path.join(home, ".omp");
		const mine = path.join(cfg, "scratch", "2026-10-11-mine-aaaaaa");
		await fs.mkdir(mine, { recursive: true });
		await fs.mkdir(path.join(cfg, "scratch", "2026-10-11-other-bbbbbb"), { recursive: true });
		await fs.mkdir(path.join(cfg, "agent"), { recursive: true });
		paths = {
			folder: mine,
			home,
			configDir: cfg,
			tmpDir: path.join(root, "sbx", "tmp"),
			companionState: path.join(cfg, "agent", "collab-companion.json"),
		};
	});

	it("takes a folder under scratch/, and refuses scratch/ itself and every other part of the config dir", () => {
		expect(() => sandboxProfile(paths)).not.toThrow();
		for (const folder of [
			path.join(cfg, "scratch"),
			cfg,
			path.join(cfg, "agent"),
			path.join(cfg, "scratchy", "x"),
			paths.home,
		]) {
			expect(() => sandboxProfile({ ...paths, folder })).toThrow("pick a project folder");
		}
	});

	it("lets the session write its own folder only, not another scratch folder, the scratch root or the config", async () => {
		expect(await sandboxed(`echo x > '${path.join(paths.folder, "a.txt")}'`)).toBe(0);
		expect(await sandboxed(`echo x > '${path.join(cfg, "scratch", "2026-10-11-other-bbbbbb", "a.txt")}'`)).not.toBe(
			0,
		);
		expect(await sandboxed(`mkdir '${path.join(cfg, "scratch", "2026-10-11-new-cccccc")}'`)).not.toBe(0);
		expect(await sandboxed(`echo x > '${path.join(cfg, "agent", "config.yml")}'`)).not.toBe(0);
	});
});
