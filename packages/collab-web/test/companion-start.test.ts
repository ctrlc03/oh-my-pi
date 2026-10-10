import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { findTmux, launchInTmux } from "../scripts/companion-start";

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
	});
});
