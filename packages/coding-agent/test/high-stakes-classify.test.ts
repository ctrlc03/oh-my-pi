/**
 * The publish classifier of high-stakes sessions: which shell commands and eval cells publish (push, pull requests,
 * API writes) and which merely mention it. A table of gated and allowed commands, since the interesting part is the
 * edge of each form: git's global options, wrappers, nested shells, aliases, heredocs.
 */
import { describe, expect, it } from "bun:test";
import {
	classifyPublish,
	classifyScript,
	isPublishPath,
	type PublishFinding,
	type PublishKind,
} from "../src/high-stakes/classify";

const ALIASES: Record<string, string> = {
	p: "push",
	pf: "push --force-with-lease",
	ship: "!git push origin HEAD",
	deploy: "p origin",
	st: "status",
	loop: "loop",
	wip: "-C sub push",
};

function resolveAlias(name: string): string | undefined {
	return ALIASES[name];
}

function kinds(findings: PublishFinding[]): PublishKind[] {
	return [...new Set(findings.map(finding => finding.kind))].sort();
}

/** [command, the kinds it must be found as; empty = allowed]. */
const COMMANDS: Array<[string, PublishKind[]]> = [
	// ── gated: git push in every spelling
	["git push", ["git-push"]],
	["git push origin main", ["git-push"]],
	["git push -u origin HEAD", ["git-push"]],
	["git push -n", ["git-push"]],
	["git push --dry-run origin x", ["git-push"]],
	["git push origin HEAD:refs/heads/x", ["git-push"]],
	["git push --tags", ["git-push"]],
	["git push --delete origin x", ["git-push"]],
	["git -C x push", ["git-push"]],
	["git -C x -C y push", ["git-push"]],
	["git -c k=v push", ["git-push"]],
	["git -c user.name=x -c user.email=y push origin", ["git-push"]],
	["git --git-dir=.git push", ["git-push"]],
	["git --git-dir .git --work-tree . push", ["git-push"]],
	["git --no-pager push", ["git-push"]],
	["git -p push", ["git-push"]],
	["git --bare push", ["git-push"]],
	["git --exec-path=/usr/lib/git-core push", ["git-push"]],
	["git --namespace=foo push", ["git-push"]],
	["git --no-replace-objects --literal-pathspecs push", ["git-push"]],
	["/usr/bin/git push", ["git-push"]],
	['"git" push', ["git-push"]],
	["\\git push", ["git-push"]],
	["git-push origin", ["git-push"]],
	["git send-pack git@example.com:o/r.git main", ["git-push"]],
	["git http-push https://example.com/r.git main", ["git-push"]],
	["git subtree push --prefix=lib origin x", ["git-push"]],
	["git svn dcommit", ["git-push"]],
	["hub push", ["git-push"]],
	// wrappers, assignments, keywords
	["env GIT_X=1 git push", ["git-push"]],
	["env -i HOME=/tmp git push", ["git-push", "hooks-bypass"]],
	["env -u FOO git push", ["git-push"]],
	["FOO=1 command git push", ["git-push"]],
	["FOO=1 BAR=2 git push", ["git-push"]],
	["command -p git push", ["git-push"]],
	["builtin exec git push", ["git-push"]],
	["exec git push", ["git-push"]],
	["time git push", ["git-push"]],
	["time -p git push", ["git-push"]],
	["nohup git push &", ["git-push"]],
	["nice -n 5 git push", ["git-push"]],
	["sudo -u bob git push", ["git-push"]],
	["timeout 30 git push", ["git-push"]],
	["timeout -s KILL 30 git push", ["git-push"]],
	["stdbuf -oL git push", ["git-push"]],
	["ionice -c 3 git push", ["git-push"]],
	["setsid git push", ["git-push"]],
	["caffeinate -i git push", ["git-push"]],
	["watch -n 5 git push", ["git-push"]],
	["echo hi | xargs git push", ["git-push"]],
	["echo x | xargs -I{} git push {}", ["git-push"]],
	["if git push; then echo ok; fi", ["git-push"]],
	["true && git push || echo failed", ["git-push"]],
	["git fetch; git push", ["git-push"]],
	["git add -A\ngit commit -m x\ngit push", ["git-push"]],
	["(git push)", ["git-push"]],
	["{ git push; }", ["git-push"]],
	["find . -name x -exec git push \\;", ["git-push"]],
	["git rebase -x 'git push' main", ["git-push"]],
	["git submodule foreach 'git push'", ["git-push"]],
	["git bisect run git push", ["git-push"]],
	// nested shells and substitutions
	["bash -c 'git push origin HEAD'", ["git-push"]],
	['sh -lc "git push"', ["git-push"]],
	['zsh -ec "cd x && git push"', ["git-push"]],
	["bash --noprofile -c 'git push'", ["git-push"]],
	["bash -c \"bash -c 'git push'\"", ["git-push"]],
	['eval "git push"', ["git-push"]],
	["eval git push origin", ["git-push"]],
	["echo $(git push)", ["git-push"]],
	['echo "pushed: $(git push)"', ["git-push"]],
	["echo `git push`", ["git-push"]],
	['x="`git push`"', ["git-push"]],
	["bash <<'EOF'\ngit push\nEOF", ["git-push"]],
	["bash <<EOF\necho hi\ngit push origin\nEOF", ["git-push"]],
	["bash <<< 'git push'", ["git-push"]],
	["echo 'git push' | sh", ["git-push"]],
	["cat <<EOF\n$(git push)\nEOF", ["git-push"]],
	["python3 - <<EOF\nimport os\nos.system('git push')\nEOF", ["git-push"]],
	["python3 -c \"import os; os.system('git push')\"", ["git-push"]],
	["node -e \"require('child_process').execSync('git push')\"", ["git-push"]],
	// cd tracking
	["cd sub && git push", ["git-push"]],
	["cd sub; git status; git push", ["git-push"]],
	["pushd /tmp/other && git push", ["git-push"]],
	// aliases
	["git -c alias.p=push p", ["git-push"]],
	["git -c alias.x='!git push' x", ["git-push"]],
	["git config alias.p push && git p", ["git-push"]],
	["git config --global alias.zz '!git push' && git zz", ["git-push"]],
	["git p", ["git-push"]],
	["git pf origin", ["git-push"]],
	["git ship", ["git-push"]],
	["git deploy", ["git-push"]],
	["git wip", ["git-push"]],
	// the pre-push hook switched off
	["git push --no-verify", ["git-push", "no-verify"]],
	["git push -f --no-verify origin x", ["git-push", "no-verify"]],
	["git push origin x --no-verif", ["git-push", "no-verify"]],
	["git push --no-v", ["git-push", "no-verify"]],
	["git pf --no-verify", ["git-push", "no-verify"]],
	["bash -c 'git push --no-verify'", ["git-push", "no-verify"]],
	["git -c core.hooksPath=/dev/null push", ["git-push", "hooks-bypass"]],
	["git -c core.hookspath=/dev/null push origin", ["git-push", "hooks-bypass"]],
	["git --config-env=core.hooksPath=HOOKS push", ["git-push", "hooks-bypass"]],
	[
		"GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git push",
		["git-push", "hooks-bypass"],
	],
	["GIT_CONFIG_PARAMETERS=\"'core.hookspath=/x'\" git push", ["git-push", "hooks-bypass"]],
	["GIT_CONFIG_GLOBAL=/tmp/cfg git push", ["git-push", "hooks-bypass"]],
	["XDG_CONFIG_HOME=/tmp/x git push", ["git-push", "hooks-bypass"]],
	["git config core.hooksPath /dev/null", ["hooks-bypass"]],
	["git config --global core.hooksPath /dev/null && git push", ["git-push", "hooks-bypass"]],
	["export GIT_CONFIG_COUNT=1", ["hooks-bypass"]],
	// pull requests
	["gh pr create -f", ["pr"]],
	["gh pr create --title x --body y", ["pr"]],
	["gh -R o/r pr merge 12 --squash", ["pr"]],
	["gh pr merge 3 --auto", ["pr"]],
	["gh pr close 3", ["pr"]],
	["gh pr -R o/r close 3", ["pr"]],
	["gh --repo o/r pr create", ["pr"]],
	["hub pull-request -m x", ["pr"]],
	["glab mr create", ["pr"]],
	["glab mr merge 4", ["pr"]],
	["glab -R o/r mr close 4", ["pr"]],
	["glab merge-request merge 4", ["pr"]],
	// API writes
	["gh api repos/o/r/pulls -f title=x -f head=b -f base=main", ["api-write"]],
	["gh api -X POST repos/o/r/pulls", ["api-write"]],
	["gh api -X PUT repos/o/r/pulls/3/merge", ["api-write"]],
	["gh api --method PUT /repos/o/r/pulls/3/merge", ["api-write"]],
	["gh api -XPATCH repos/o/r/pulls/3 -f state=closed", ["api-write"]],
	["gh api repos/o/r/merges -f base=main -f head=x", ["api-write"]],
	["gh api repos/o/r/git/refs -f ref=refs/heads/x -f sha=abc", ["api-write"]],
	["gh api -X PATCH repos/o/r/git/refs/heads/x -f sha=abc", ["api-write"]],
	["gh api -X DELETE repos/o/r/git/refs/heads/x", ["api-write"]],
	["gh api repos/o/r/git/commits -f message=x", ["api-write"]],
	["gh api repos/o/r/git/trees --input tree.json", ["api-write"]],
	["gh api repos/o/r/git/tags -f tag=v1", ["api-write"]],
	["gh api -X PUT repos/o/r/contents/README.md -f message=x -f content=eA==", ["api-write"]],
	["gh api repos/{owner}/{repo}/pulls -f title=x", ["api-write"]],
	[
		"gh api graphql -f query='mutation{mergePullRequest(input:{pullRequestId:\"x\"}){clientMutationId}}'",
		["api-write"],
	],
	["gh api graphql -F query='mutation { createPullRequest(input: {}) { pullRequest { id } } }'", ["api-write"]],
	["gh api graphql -f query='mutation { createCommitOnBranch(input: {}) { commit { oid } } }'", ["api-write"]],
	["gh api graphql -F query=@mutation.graphql", ["api-write"]],
	["hub api -X POST repos/o/r/pulls -f title=x", ["api-write"]],
	["glab api -X PUT projects/1/merge_requests/3/merge", ["api-write"]],
	['curl -X POST https://api.github.com/repos/o/r/pulls -d \'{"title":"x"}\'', ["api-write"]],
	["curl -H 'Authorization: token x' -d '{}' https://api.github.com/repos/o/r/pulls", ["api-write"]],
	["curl --request PUT https://api.github.com/repos/o/r/pulls/3/merge", ["api-write"]],
	["curl -XPOST https://api.github.com/repos/o/r/git/refs --data @ref.json", ["api-write"]],
	["curl --json '{}' https://api.github.com/repos/o/r/merges", ["api-write"]],
	["curl -X POST https://gitlab.example.com/api/v4/projects/1/merge_requests -d x=y", ["api-write"]],
	["wget --method=POST --body-data='{}' https://api.github.com/repos/o/r/pulls", ["api-write"]],
	["wget --post-data=x https://api.github.com/repos/o/r/pulls", ["api-write"]],
	["http POST https://api.github.com/repos/o/r/pulls title=x", ["api-write"]],
	["http https://api.github.com/repos/o/r/pulls title=x", ["api-write"]],
	["xh PUT api.github.com/repos/o/r/pulls/3/merge", ["api-write"]],
	// ── allowed: reading, listing, local work, and mentions
	['git commit -m "git push later"', []],
	["git commit -m 'gh pr create' --no-verify", []],
	["git commit --no-verify -m x", []],
	["echo git push", []],
	['echo "git push" > notes.txt', []],
	["printf 'gh pr merge\\n'", []],
	["git log --grep=push", []],
	["git log --oneline origin/main..HEAD", []],
	["git status", []],
	["git diff HEAD~1", []],
	["git fetch", []],
	["git fetch origin && git rebase origin/main", []],
	["git pull --rebase", []],
	["git tag v1", []],
	["git switch -c x", []],
	["git checkout -b feature/push", []],
	["git remote -v", []],
	["git remote add origin git@example.com:o/r.git", []],
	["git branch -a", []],
	["git stash && git stash pop", []],
	["git config alias.p push", []],
	["git config --get alias.p", []],
	["git config --list", []],
	["git config user.name x", []],
	["git config core.hooksPath", []],
	["git config --unset core.hooksPath", []],
	["git -c user.name=x commit -m y", []],
	["git -c core.hooksPath=/tmp/hooks commit -m y", []],
	["git st", []],
	["git unknown-subcommand", []],
	["git loop", []],
	["git", []],
	["gh pr view 3", []],
	["gh pr list --state open", []],
	["gh pr checks 3", []],
	["gh pr diff 3", []],
	["gh pr status", []],
	["gh pr checkout 3", []],
	["gh pr comment 3 --body 'merge when ready'", []],
	["gh issue create --title x", []],
	["gh repo view", []],
	["gh api repos/o/r/pulls", []],
	["gh api repos/o/r/pulls/3", []],
	["gh api -X GET repos/o/r/pulls -f state=open", []],
	["gh api repos/o/r/pulls/3/comments -f body=x", []],
	["gh api repos/o/r/issues -f title=x", []],
	["gh api graphql -f query='{ viewer { login } }'", []],
	['gh api graphql -f query=\'query { repository(owner: "o", name: "r") { id } }\'', []],
	["hub pr list", []],
	["glab mr list", []],
	["glab mr view 4", []],
	["curl https://api.github.com/repos/o/r/pulls", []],
	["curl -s -H 'Accept: application/json' https://api.github.com/repos/o/r", []],
	["curl -X POST https://example.com/hook -d x=y", []],
	["curl -G https://api.github.com/repos/o/r/pulls -d state=open", []],
	["wget https://example.com/file.tgz", []],
	["http GET https://api.github.com/repos/o/r/pulls", []],
	["grep push file", []],
	["grep -rn 'git push' src", []],
	["cat push.txt", []],
	["ls", []],
	["ls -la && pwd", []],
	["npm test", []],
	["bun run build", []],
	["cd sub && git status", []],
	["bash script.sh", []],
	["bash -c 'echo hi'", []],
	["bash <<EOF\necho hi\nEOF", []],
	["cat <<EOF > notes.txt\ngit push\nEOF", []],
	["cat <<'EOF'\ngit push origin main\nEOF", []],
	["git commit -F - <<EOF\ngit push is next\nEOF", []],
	["echo $((1<<2))\nls", []],
	["command -v git", []],
	["sudo ls", []],
	["", []],
	["   ", []],
];

describe("classifyPublish", () => {
	it("has a broad table", () => {
		expect(COMMANDS.length).toBeGreaterThanOrEqual(60);
		expect(COMMANDS.filter(([, expected]) => expected.length > 0).length).toBeGreaterThanOrEqual(40);
		expect(COMMANDS.filter(([, expected]) => expected.length === 0).length).toBeGreaterThanOrEqual(20);
	});

	for (const [command, expected] of COMMANDS) {
		it(`${expected.length === 0 ? "allows" : `gates as ${expected.join("+")}`}: ${JSON.stringify(command)}`, () => {
			expect(kinds(classifyPublish(command, { resolveAlias }))).toEqual([...expected].sort());
		});
	}
});

describe("classifyPublish folders", () => {
	const dirs = (command: string): Array<string | undefined> =>
		classifyPublish(command, { resolveAlias }).map(finding => finding.dir);

	it("reports the folder a push runs in", () => {
		expect(dirs("git push")).toEqual([undefined]);
		expect(dirs("git -C x push")).toEqual(["x"]);
		expect(dirs("git -C x -C y push")).toEqual(["x/y"]);
		expect(dirs("git -C /abs push")).toEqual(["/abs"]);
		expect(dirs("cd sub && git push")).toEqual(["sub"]);
		expect(dirs("cd a && cd b && git push")).toEqual(["a/b"]);
		expect(dirs("cd /abs && cd b && git push")).toEqual(["/abs/b"]);
		expect(dirs("cd sub && git -C inner push")).toEqual(["sub/inner"]);
		expect(dirs("git --work-tree=/w push")).toEqual(["/w"]);
		expect(dirs("git --git-dir=/r/.git push")).toEqual(["/r"]);
		expect(dirs("env -C /e git push")).toEqual(["/e"]);
		expect(dirs("GIT_WORK_TREE=/w git push")).toEqual(["/w"]);
		expect(dirs("bash -c 'cd sub && git push'")).toEqual(["sub"]);
		expect(dirs("git wip")).toEqual(["sub"]);
	});

	it("does not carry a cd out of a nested command substitution", () => {
		expect(dirs("echo $(cd sub && git push); git push")).toEqual(["sub", undefined]);
	});
});

describe("classifyPublish aliases", () => {
	it("asks the resolver only for a subcommand that is not a built-in", () => {
		const asked: string[] = [];
		classifyPublish("git status && git commit -m x && git p && git fetch", {
			resolveAlias: name => {
				asked.push(name);
				return ALIASES[name];
			},
		});
		expect(asked).toEqual(["p"]);
	});

	it("does not ask when the alias was defined earlier in the same command", () => {
		const asked: string[] = [];
		const found = classifyPublish("git -c alias.q=push q", {
			resolveAlias: name => {
				asked.push(name);
				return undefined;
			},
		});
		expect(asked).toEqual([]);
		expect(kinds(found)).toEqual(["git-push"]);
	});

	it("never lets an alias override a built-in command", () => {
		expect(classifyPublish("git -c alias.status=push status")).toEqual([]);
		expect(classifyPublish("git status", { resolveAlias: () => "push" })).toEqual([]);
	});

	it("follows a chain of aliases, up to depth 5", () => {
		const chain: Record<string, string> = { a1: "a2", a2: "a3", a3: "a4", a4: "push" };
		expect(kinds(classifyPublish("git a1", { resolveAlias: name => chain[name] }))).toEqual(["git-push"]);
		const tooLong: Record<string, string> = {
			b1: "b2",
			b2: "b3",
			b3: "b4",
			b4: "b5",
			b5: "b6",
			b6: "b7",
			b7: "push",
		};
		expect(classifyPublish("git b1", { resolveAlias: name => tooLong[name] })).toEqual([]);
	});

	it("survives an alias that expands to itself", () => {
		expect(classifyPublish("git loop", { resolveAlias })).toEqual([]);
	});

	it("reads a shell alias as a shell command", () => {
		expect(classifyPublish("git echoer hi", { resolveAlias: () => "!echo git push" })).toEqual([]);
		expect(kinds(classifyPublish("git x", { resolveAlias: () => "!git push" }))).toEqual(["git-push"]);
	});

	it("does nothing with git commands when no resolver is given", () => {
		expect(classifyPublish("git p")).toEqual([]);
	});
});

describe("classifyPublish findings", () => {
	it("says what was found", () => {
		expect(classifyPublish("git push --no-verify")).toEqual([
			{ kind: "git-push", what: "git push" },
			{ kind: "no-verify", what: "git push --no-verify" },
		]);
		expect(classifyPublish("gh pr merge 3")).toEqual([{ kind: "pr", what: "gh pr merge" }]);
		expect(classifyPublish("glab mr create")).toEqual([{ kind: "pr", what: "glab mr create" }]);
		expect(classifyPublish("gh api -X PUT repos/o/r/pulls/3/merge")).toEqual([
			{ kind: "api-write", what: "gh api PUT repos/o/r/pulls/3/merge" },
		]);
		expect(classifyPublish("curl -X POST https://api.github.com/repos/o/r/pulls -d x=y")).toEqual([
			{ kind: "api-write", what: "curl POST api.github.com/repos/o/r/pulls" },
		]);
	});

	it("reports each publish of a chain", () => {
		const found = classifyPublish("git push && gh pr create && git push");
		expect(found.map(finding => finding.what)).toEqual(["git push", "gh pr create"]);
	});

	it("gives up on a command nested too deeply to read, instead of letting it through", () => {
		let command = "git push";
		for (let level = 0; level < 12; level++) command = `bash -c ${JSON.stringify(command)}`;
		expect(kinds(classifyPublish(command))).toContain("unreadable");
	});
});

describe("isPublishPath", () => {
	it("matches the endpoints whose writes publish", () => {
		for (const route of [
			"repos/o/r/pulls",
			"repos/o/r/pulls/12",
			"repos/o/r/pulls/12/merge",
			"repos/o/r/pulls/{number}/update-branch",
			"repos/o/r/merges",
			"repos/o/r/merge-upstream",
			"repos/o/r/git/refs",
			"repos/o/r/git/refs/heads/x",
			"repos/o/r/git/commits",
			"repos/o/r/git/trees",
			"repos/o/r/git/tags",
			"repos/o/r/contents/a/b.txt",
			"api/v4/projects/1/merge_requests",
			"api/v4/projects/1/merge_requests/3/merge",
			"api/v4/projects/1/repository/commits",
		]) {
			expect(isPublishPath(route)).toBe(true);
		}
	});

	it("leaves the rest alone", () => {
		for (const route of [
			"repos/o/r",
			"repos/o/r/pulls/12/comments",
			"repos/o/r/pulls/12/reviews",
			"repos/o/r/pulls/12/requested_reviewers",
			"repos/o/r/issues",
			"repos/o/r/git/blobs",
			"repos/o/r/git/ref/heads/x",
			"user",
			"graphql",
		]) {
			expect(isPublishPath(route)).toBe(false);
		}
	});
});

/** [eval cell source, kinds; empty = allowed]. */
const SCRIPTS: Array<[string, PublishKind[]]> = [
	['import subprocess\nsubprocess.run(["git", "push"])', ["git-push"]],
	['subprocess.run(["git", "-C", repo, "push", "origin"], check=True)', ["git-push"]],
	["subprocess.run(['git','-C',x,'push'])", ["git-push"]],
	['subprocess.run("git push origin main", shell=True)', ["git-push"]],
	['subprocess.check_call(["git", "push", "--no-verify"])', ["git-push", "no-verify"]],
	['subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "push"])', ["git-push", "hooks-bypass"]],
	['subprocess.run("git", "-C", str(d), "push")', ["git-push"]],
	['os.system("git push")', ["git-push"]],
	['os.system(f"cd {d} && git push origin {branch}")', ["git-push"]],
	['os.popen("gh pr create -f").read()', ["pr"]],
	['child_process.execSync("git push origin HEAD")', ["git-push"]],
	["await Bun.$`git push`", ["git-push"]],
	[`await Bun.$\`git push \${remote} \${branch}\``, ["git-push"]],
	['Bun.spawn(["git", "push"])', ["git-push"]],
	['Bun.spawnSync(["git", "-C", dir, "push", "origin"])', ["git-push"]],
	['await execa("git", ["push"])', ["git-push"]],
	['spawn("git", ["-C", dir, "push"])', ["git-push"]],
	['const cmd = "git -C " + dir + " push"; exec(cmd)', ["git-push"]],
	[`exec(\`gh pr merge \${n} --squash\`)`, ["pr"]],
	[`run(\`gh pr close \${n}\`)`, ["pr"]],
	['subprocess.run(["gh", "pr", "create", "--fill"])', ["pr"]],
	['subprocess.run(["glab", "mr", "merge"])', ["pr"]],
	['await fetch("https://api.github.com/repos/o/r/pulls", { method: "POST", body })', ["api-write"]],
	[`fetch(\`https://api.github.com/repos/\${o}/\${r}/pulls/\${n}/merge\`, {method: "PUT"})`, ["api-write"]],
	['requests.post("https://api.github.com/repos/o/r/pulls", json=payload)', ["api-write"]],
	['requests.put(url + "/repos/o/r/pulls/3/merge")', ["api-write"]],
	['octokit.request("POST /repos/{owner}/{repo}/pulls", { title })', ["api-write"]],
	["await octokit.rest.pulls.create({ owner, repo, title })", ["api-write"]],
	["await octokit.rest.git.createRef({ owner, repo, ref, sha })", ["api-write"]],
	["repo.create_pull(title=t, body=b, head=h, base=m)", ["api-write"]],
	['gql = "mutation { mergePullRequest(input: {}) { clientMutationId } }"', ["api-write"]],
	['subprocess.run(["gh", "api", "-X", "PUT", "repos/o/r/pulls/3/merge"])', ["api-write"]],
	["!git push origin main", ["git-push"]],
	["x = 1\nprint(x)", []],
	['print("hello world")', []],
	['subprocess.run(["git", "status"])', []],
	['subprocess.run(["git", "log", "--oneline"], capture_output=True)', []],
	['subprocess.run("git commit -m wip", shell=True)', []],
	['os.system("ls -la")', []],
	["await Bun.$`git fetch origin`", []],
	['await fetch("https://api.github.com/repos/o/r/pulls")', []],
	['requests.get("https://api.github.com/repos/o/r/pulls").json()', []],
	['requests.post("https://example.com/hook", json={})', []],
	['await fetch("https://api.github.com/repos/o/r/issues", { method: "POST" })', []],
	['# git push is how it ends\nprint("done")', []],
	['// gh pr create later\nconsole.log("done")', []],
	['subprocess.run(["git", "commit", "-m", "x"])\nprint("push done")', []],
	["const push = 1; const git = 2; console.log(push + git)", []],
	["", []],
];

describe("classifyScript", () => {
	it("has a table", () => {
		expect(SCRIPTS.length).toBeGreaterThanOrEqual(40);
	});

	for (const [code, expected] of SCRIPTS) {
		it(`${expected.length === 0 ? "allows" : `gates as ${expected.join("+")}`}: ${JSON.stringify(code)}`, () => {
			expect(kinds(classifyScript(code, { resolveAlias }))).toEqual([...expected].sort());
		});
	}

	it("sees a push in a python or node one-liner of a shell command", () => {
		expect(kinds(classifyPublish('python3 -c \'import subprocess; subprocess.run(["git", "push"])\''))).toEqual([
			"git-push",
		]);
		expect(kinds(classifyPublish("bun -e 'await Bun.$`git push`'"))).toEqual(["git-push"]);
	});

	it("reads \\n in a string as a line break", () => {
		expect(kinds(classifyScript('os.system("git add .\\ngit push")'))).toEqual(["git-push"]);
	});
});
