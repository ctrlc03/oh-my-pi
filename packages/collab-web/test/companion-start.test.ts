import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { findTmux, foreignHostCommand, launchInTmux } from "../scripts/companion-start";

const tmuxBin = await findTmux();

describe.skipIf(tmuxBin === null)("launchInTmux with a real tmux", () => {
	let root: string;
	let wrapper: string;
	let fakeOmp: string;

	beforeAll(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-start-test-")));
		// (`tmux -c` expands `#{...}` formats, so a name using one shows whether tmux ever sees the folder.)
		// A private tmux server (own socket dir), started from `root`, so a `#(touch pwned)` expanded by the
		// server would create `root/pwned`. Never the default socket.
		wrapper = path.join(root, "tmux");
		await fs.writeFile(
			wrapper,
			`#!/bin/sh\ncd '${root}' && TMUX_TMPDIR='${root}' exec '${tmuxBin}' -L omp-start-test "$@"\n`,
			{ mode: 0o700 },
		);
		// Stands in for omp: records where it ran and what it was given, then exits.
		fakeOmp = path.join(root, "fake-omp");
		await fs.writeFile(
			fakeOmp,
			`#!/bin/sh\n{ pwd; for a in "$@"; do printf '[%s]\\n' "$a"; done; } > "${root}/out.tmp" && mv "${root}/out.tmp" "${root}/out"\n`,
			{ mode: 0o700 },
		);
	});

	afterAll(async () => {
		const stop = Bun.spawn([wrapper, "kill-server"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
		await stop.exited;
		await fs.rm(root, { recursive: true, force: true });
	});

	/** Wait for the stand-in omp's report: the awaited condition is the file, the sleep only paces the poll. */
	async function report(): Promise<string> {
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			const text = await Bun.file(path.join(root, "out"))
				.text()
				.catch(() => null);
			if (text !== null) return text;
			await Bun.sleep(20);
		}
		throw new Error("the stand-in omp never ran");
	}

	it("never lets tmux expand a folder name, and still runs omp there with the prompt", async () => {
		const folder = path.join(root, "#{session_name}#(touch pwned)");
		await fs.mkdir(folder);
		await fs.rm(path.join(root, "out"), { force: true });
		const launched = await launchInTmux({
			tmux: wrapper,
			ompBin: fakeOmp,
			overlayPath: path.join(root, "overlay.yml"),
			promptDir: path.join(root, "run"),
			cwd: folder,
			resume: "abc123",
			prompt: "-- fix #(touch pwned) $HOME",
		});
		expect(launched.cwd).toBe(folder);
		const lines = (await report()).trim().split("\n");
		expect(lines[0]).toBe(folder);
		expect(lines.slice(1)).toEqual([
			"[--config]",
			`[${path.join(root, "overlay.yml")}]`,
			"[-r]",
			"[abc123]",
			"[--]",
			"[-- fix #(touch pwned) $HOME]",
		]);
		expect(await Bun.file(path.join(root, "pwned")).exists()).toBe(false);
		// The prompt went through a file in the private hand-off folder, which the shell deleted.
		expect((await fs.stat(path.join(root, "run"))).mode & 0o777).toBe(0o700);
		expect(await fs.readdir(path.join(root, "run"))).toEqual([]);
	});

	it("passes a per-run spend limit as --max-cost, before the prompt", async () => {
		await fs.rm(path.join(root, "out"), { force: true });
		await launchInTmux({
			tmux: wrapper,
			ompBin: fakeOmp,
			overlayPath: path.join(root, "overlay.yml"),
			promptDir: path.join(root, "run"),
			cwd: root,
			prompt: "fix it",
			maxCostUsd: 1.5,
		});
		const lines = (await report()).trim().split("\n");
		const at = lines.indexOf("[--max-cost]");
		expect(lines.slice(at, at + 2)).toEqual(["[--max-cost]", "[1.5]"]);
		expect(at).toBeLessThan(lines.indexOf("[--]"));
	});

	it("passes the model as --model, before the prompt, and refuses one that reads as a flag", async () => {
		await fs.rm(path.join(root, "out"), { force: true });
		await launchInTmux({
			tmux: wrapper,
			ompBin: fakeOmp,
			overlayPath: path.join(root, "overlay.yml"),
			promptDir: path.join(root, "run"),
			cwd: root,
			prompt: "fix it",
			model: "anthropic/claude-sonnet-4-5",
		});
		const lines = (await report()).trim().split("\n");
		const at = lines.indexOf("[--model]");
		expect(lines[at + 1]).toBe("[anthropic/claude-sonnet-4-5]");
		expect(at).toBeLessThan(lines.indexOf("[--]"));
		await expect(
			launchInTmux({
				tmux: wrapper,
				ompBin: fakeOmp,
				overlayPath: path.join(root, "overlay.yml"),
				promptDir: path.join(root, "run"),
				cwd: root,
				model: "--yolo",
			}),
		).rejects.toThrow("invalid model");
	});

	it("runs a vendor agent's host with every value as its own argument and hands over the prompt file", async () => {
		const folder = path.join(root, "a folder; touch pwned2 #{session_name}");
		await fs.mkdir(folder);
		await fs.rm(path.join(root, "out"), { force: true });
		const fanout = '{"group":"g","model":"agent:custom:x/","agent":{"id":"custom:x","name":"X"}}';
		const launched = await launchInTmux({
			tmux: wrapper,
			ompBin: "/unused/omp",
			overlayPath: path.join(root, "never", "overlay.yml"),
			promptDir: path.join(root, "run2"),
			localRelayUrl: "ws://127.0.0.1:1234",
			cwd: folder,
			resume: "custom-team-0123456789abcdef",
			prompt: "$(touch pwned2) -- 'x'",
			maxCostUsd: 2.5,
			model: "anthropic/sonnet[1m]",
			foreign: {
				host: [fakeOmp, "/repo/foreign/host-main.ts"],
				agent: "custom:team-agent",
				permission: "full",
				relayUrl: "wss://relay.example",
				webUrl: "https://web.example/",
				fanout,
			},
		});
		expect(launched.cwd).toBe(folder);
		const lines = (await report()).trim().split("\n");
		const promptFiles = await fs.readdir(path.join(root, "run2"));
		expect(promptFiles).toHaveLength(1);
		const promptFile = path.join(root, "run2", promptFiles[0]!);
		expect(lines).toEqual([
			folder,
			"[/repo/foreign/host-main.ts]",
			"[--agent]",
			"[custom:team-agent]",
			"[--cwd]",
			`[${folder}]`,
			"[--resume]",
			"[custom-team-0123456789abcdef]",
			"[--model]",
			"[anthropic/sonnet[1m]]",
			"[--permission]",
			"[full]",
			"[--max-cost]",
			"[2.5]",
			"[--prompt-file]",
			`[${promptFile}]`,
			"[--fanout]",
			`[${fanout}]`,
			"[--relay]",
			"[wss://relay.example]",
			"[--web]",
			"[https://web.example/]",
			"[--local-relay]",
			"[ws://127.0.0.1:1234]",
		]);
		// The prompt is in the private hand-off folder, for the host to read and delete; no omp overlay was written.
		expect(await Bun.file(promptFile).text()).toBe("$(touch pwned2) -- 'x'");
		expect((await fs.stat(promptFile)).mode & 0o777).toBe(0o600);
		expect((await fs.stat(path.join(root, "run2"))).mode & 0o777).toBe(0o700);
		expect(await Bun.file(path.join(root, "never", "overlay.yml")).exists()).toBe(false);
		expect(await Bun.file(path.join(root, "pwned2")).exists()).toBe(false);
		expect(await Bun.file(path.join(folder, "pwned2")).exists()).toBe(false);
	});

	it("refuses a vendor agent id or model that is not plain", async () => {
		const base = {
			tmux: wrapper,
			ompBin: "/unused/omp",
			overlayPath: path.join(root, "never", "overlay.yml"),
			promptDir: path.join(root, "run2"),
			cwd: root,
		};
		const foreign = {
			host: [fakeOmp, "/repo/foreign/host-main.ts"],
			agent: "claude",
			permission: "supervised" as const,
		};
		await expect(launchInTmux({ ...base, foreign: { ...foreign, agent: "claude; touch pwned3" } })).rejects.toThrow(
			"invalid agent",
		);
		await expect(launchInTmux({ ...base, foreign: { ...foreign, agent: "custom:UP" } })).rejects.toThrow(
			"invalid agent",
		);
		await expect(
			launchInTmux({ ...base, foreign: { ...foreign, permission: "yolo" as unknown as "full" } }),
		).rejects.toThrow("invalid agent");
		for (const model of ["--yolo", "a b", "x;y", "$(id)"])
			await expect(launchInTmux({ ...base, model, foreign })).rejects.toThrow("invalid model");
		expect(await Bun.file(path.join(root, "pwned3")).exists()).toBe(false);
	});
});

describe("foreignHostCommand", () => {
	const foreign = {
		host: ["/usr/bin/bun", "/repo/host-main.ts"],
		agent: "claude",
		permission: "supervised" as const,
	};

	it("is the host entry with only the options that were given", () => {
		expect(foreignHostCommand(foreign, { cwd: "/work/app" })).toEqual([
			"/usr/bin/bun",
			"/repo/host-main.ts",
			"--agent",
			"claude",
			"--cwd",
			"/work/app",
			"--permission",
			"supervised",
		]);
	});

	it("marks a worktree session", () => {
		const command = foreignHostCommand({ ...foreign, worktree: true }, { cwd: "/work/tree" });
		expect(command).toContain("--worktree");
		expect(foreignHostCommand({ ...foreign, worktree: false }, { cwd: "/work/tree" })).not.toContain("--worktree");
	});

	it("keeps a hostile value one argument, never a shell string", () => {
		const evil = "x; rm -rf ~ $(id) `id` '\"";
		const command = foreignHostCommand(foreign, { cwd: evil, model: evil, resume: evil, promptFile: evil });
		expect(command.filter(arg => arg === evil)).toHaveLength(4);
		expect(command.every(arg => !arg.includes(" ") || arg === evil)).toBe(true);
	});
});
