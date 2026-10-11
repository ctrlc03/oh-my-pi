import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const actionDir = path.resolve(import.meta.dir, "../../../.github/actions/omp");

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function sh(cwd: string, command: string, env: Record<string, string> = {}): { code: number; out: string } {
	const proc = Bun.spawnSync(["bash", "-c", command], {
		cwd,
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: proc.exitCode, out: `${proc.stdout}${proc.stderr}` };
}

/** A bare "server" repo, a checkout of it, and the files publish.sh reads. */
function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-publish-"));
	tempDirs.push(root);
	const server = path.join(root, "srv");
	const ws = path.join(root, "ws");
	const work = path.join(root, "work");
	const bin = path.join(root, "bin");
	fs.mkdirSync(path.join(server, "o"), { recursive: true });
	fs.mkdirSync(work);
	fs.mkdirSync(bin);
	const setup = [
		`git init -q --bare -b main '${server}/o/r.git'`,
		`git clone -q '${server}/o/r.git' '${ws}' 2>/dev/null`,
		`cd '${ws}'`,
		"git config user.email a@b && git config user.name a",
		"echo hi > a.txt && git add . && git commit -qm init",
		"git push -q origin HEAD:main",
	].join(" && ");
	expect(sh(root, setup).code).toBe(0);
	const startSha = sh(ws, "git rev-parse HEAD").out.trim();
	fs.writeFileSync(
		path.join(work, "meta.json"),
		JSON.stringify({
			number: 5,
			is_pr: false,
			title: "t",
			author: "me",
			comment_url: "u",
			head_ref: "",
			base_ref: "main",
			cross_repo: false,
			start_sha: startSha,
		}),
	);
	fs.writeFileSync(path.join(work, "status"), "0\n");
	fs.writeFileSync(path.join(work, "cost"), "0\n");
	fs.writeFileSync(path.join(work, "answer.md"), "answer\n");
	fs.writeFileSync(path.join(bin, "gh"), '#!/usr/bin/env bash\n[ "$1" != pr ] || echo https://example/pr/1\n');
	fs.chmodSync(path.join(bin, "gh"), 0o755);
	const output = path.join(root, "out");
	fs.writeFileSync(output, "");
	const env = {
		PATH: `${bin}:${process.env.PATH}`,
		GH_TOKEN: "secret-token",
		GITHUB_SERVER_URL: `file://${server}`,
		GITHUB_REPOSITORY: "o/r",
		GITHUB_RUN_ID: "7",
		GITHUB_WORKSPACE: ws,
		GITHUB_OUTPUT: output,
		OMP_WORK_DIR: work,
		OMP_CREATE_PR: "true",
		OMP_BRANCH_PREFIX: "omp/",
		OMP_GIT_USER_NAME: "bot",
		OMP_GIT_USER_EMAIL: "bot@example.com",
	};
	return { root, server, ws, env };
}

describe("github action publish.sh", () => {
	it("never runs commands the agent wired into the workspace's git configuration", () => {
		const { root, server, ws, env } = fixture();
		const hooks = path.join(root, "hooks");
		const include = path.join(root, "include.cfg");
		const canary = (name: string) => path.join(root, `pwned-${name}`);
		fs.mkdirSync(hooks);
		fs.writeFileSync(path.join(hooks, "pre-commit"), `#!/bin/sh\ntouch '${canary("hook")}'\n`, { mode: 0o755 });
		fs.writeFileSync(include, `[filter "y"]\n\tclean = touch '${canary("include")}'\n`);

		// What a write-mode agent can do: edit files, including .git and .gitattributes.
		fs.writeFileSync(path.join(ws, "new.txt"), "new\n");
		fs.writeFileSync(path.join(ws, ".gitattributes"), "* filter=x diff=x\n");
		fs.writeFileSync(path.join(ws, ".git", "info", "attributes"), "* filter=y\n");
		fs.appendFileSync(
			path.join(ws, ".git", "config"),
			[
				`[filter "x"]\n\tclean = touch '${canary("clean")}'; cat\n\tsmudge = touch '${canary("smudge")}'; cat\n`,
				`[diff "x"]\n\ttextconv = touch '${canary("textconv")}'; cat\n`,
				`[core]\n\tfsmonitor = touch '${canary("fsmonitor")}'; echo\n\tsshCommand = touch '${canary("ssh")}'\n\taskPass = touch '${canary("askpass")}'\n\thooksPath = ${hooks}\n`,
				`[include]\n\tpath = ${include}\n`,
				`[alias]\n\tstatus = !touch '${canary("alias")}'\n`,
			].join(""),
		);

		const result = sh(ws, `bash '${path.join(actionDir, "publish.sh")}'`, env);
		expect(result.out).not.toContain("::error::");
		expect(result.code).toBe(0);
		expect(fs.readdirSync(root).filter(name => name.startsWith("pwned-"))).toEqual([]);

		// The change still went out: one commit on the issue branch holding the workspace files.
		const branch = "omp/issue-5-7";
		const show = sh(root, `git --git-dir='${server}/o/r.git' show --stat --format=%s ${branch}`);
		expect(show.code).toBe(0);
		expect(show.out).toContain("omp: t");
		expect(show.out).toContain("new.txt");
		expect(show.out).toContain(".gitattributes");
	});

	it("refuses to publish an embedded repository instead of recording a gitlink", () => {
		const { root, server, ws, env } = fixture();
		expect(
			sh(
				ws,
				"mkdir sub && git -C sub init -q && echo x > sub/f && git -C sub add f && git -C sub -c user.name=a -c user.email=a@b commit -qm s",
			).code,
		).toBe(0);

		const result = sh(ws, `bash '${path.join(actionDir, "publish.sh")}'`, env);
		expect(result.out).toContain("embedded git repository");
		expect(result.code).toBe(1);
		const refs = sh(root, `git --git-dir='${server}/o/r.git' for-each-ref --format='%(refname)'`).out;
		expect(refs.trim()).toBe("refs/heads/main");
	});
});
