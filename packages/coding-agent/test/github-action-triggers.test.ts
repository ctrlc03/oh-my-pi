import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Dry runs of the GitHub Action for every trigger: fake event payloads go through the
 * real prepare.sh / run.sh / publish.sh with `omp` and `gh` replaced by stubs that
 * record what they were asked to do. Git is real, against bare repositories in a temp dir.
 */

const repoRoot = path.resolve(import.meta.dir, "../../..");
const actionDir = path.join(repoRoot, ".github/actions/omp");
const READ_ONLY_TOOLS = "read,grep,find,glob,ast_grep";

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

const GH_STUB = `#!/usr/bin/env bash
dir="$GH_STUB_DIR"
printf 'CALL %s\\n' "$*" >>"$dir/calls.log"
if [ "$1" = pr ]; then echo https://example/pr/1; exit 0; fi
[ "$1" = api ] || exit 0
shift
endpoint=""
for arg in "$@"; do
	case "$arg" in
	repos/* | search/* | graphql) endpoint="$arg"; break ;;
	esac
done
key="\${endpoint//\\//_}"
expr=""
input=""
while [ $# -gt 0 ]; do
	case "$1" in
	--jq) expr="$2"; shift ;;
	--input) input="$2"; shift ;;
	esac
	shift
done
file="$dir/fx/$key.json"
if [ -n "$input" ]; then
	n="$(ls "$dir/payloads" | wc -l | tr -d ' ')"
	cp "$input" "$dir/payloads/$n-$key.json"
	if [ -n "\${GH_STUB_FAIL_INLINE:-}" ] && [ "$(jq '.comments | length' "$input")" != 0 ]; then exit 1; fi
	file="$dir/fx/$key.post.json"
	[ -f "$file" ] || exit 0
fi
[ -f "$file" ] || { [ -n "$input" ] || [ -n "$expr" ] || echo '[]'; exit 0; }
if [ -n "$expr" ]; then
	jq -r "($expr) | if type == \\"string\\" then . else tojson end" "$file"
else
	cat "$file"
fi
`;

const OMP_STUB = `#!/usr/bin/env bash
dir="$OMP_STUB_DIR"
printf '%s\\n' "$@" >"$dir/argv.txt"
cat >"$dir/stdin.md"
env | grep -c '^GH_TOKEN=' >"$dir/token-count.txt"
[ -z "\${OMP_STUB_WRITE:-}" ] || echo changed >"$OMP_STUB_WRITE"
cat "$dir/events.jsonl"
exit "\${OMP_STUB_EXIT:-0}"
`;

const INPUT_DEFAULTS: Record<string, string> = {
	OMP_TRIGGER: "@omp",
	OMP_ALLOWED_ASSOCIATIONS: "OWNER,MEMBER,COLLABORATOR",
	OMP_ALLOW_FORK_PRS: "false",
	OMP_PR_ACTIONS: "opened,ready_for_review,synchronize",
	OMP_PR_ASSOCIATIONS: "OWNER,MEMBER,COLLABORATOR",
	OMP_TRIAGE_ASSOCIATIONS: "OWNER,MEMBER,COLLABORATOR",
	OMP_BOT_LOGIN: "github-actions[bot]",
	OMP_PROMPT: "",
	OMP_MODEL: "",
	OMP_THINKING: "",
	OMP_MAX_COST: "",
	OMP_MAX_TIME: "30m",
	OMP_APPROVAL_MODE: "write",
	OMP_TOOLS: "",
	OMP_PROJECT_EXTENSIONS: "false",
	OMP_CREATE_PR: "true",
	OMP_BRANCH_PREFIX: "omp/",
	OMP_GIT_USER_NAME: "bot",
	OMP_GIT_USER_EMAIL: "bot@example.com",
	OMP_APPLY_LABELS: "false",
	OMP_MAX_INLINE_COMMENTS: "20",
};

interface Fixture {
	root: string;
	server: string;
	ws: string;
	work: string;
	stub: string;
	baseSha: string;
	prSha: string;
	env: Record<string, string>;
}

/** A bare "server" repo with main and `refs/pull/5/head`, a checkout of main, and the stubs. */
function fixture(): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-triggers-"));
	tempDirs.push(root);
	const server = path.join(root, "srv");
	const ws = path.join(root, "ws");
	const work = path.join(root, "work");
	const bin = path.join(root, "bin");
	const stub = path.join(root, "stub");
	for (const dir of [path.join(server, "o"), work, bin, path.join(stub, "fx"), path.join(stub, "payloads")]) {
		fs.mkdirSync(dir, { recursive: true });
	}
	const setup = [
		`git init -q --bare -b main '${server}/o/r.git'`,
		`git clone -q '${server}/o/r.git' '${ws}' 2>/dev/null`,
		`cd '${ws}'`,
		"git config user.email a@b && git config user.name a",
		"echo hi > a.txt && git add . && git commit -qm init",
		"git push -q origin HEAD:main",
		"git checkout -q -b pr && printf 'one\\ntwo\\nthree\\n' > src.txt && git add . && git commit -qm change",
		"git push -q origin HEAD:refs/pull/5/head",
		"git checkout -q main",
	].join(" && ");
	expect(sh(root, setup).code).toBe(0);
	const baseSha = sh(ws, "git rev-parse main").out.trim();
	const prSha = sh(ws, "git rev-parse pr").out.trim();
	fs.writeFileSync(path.join(bin, "gh"), GH_STUB, { mode: 0o755 });
	fs.writeFileSync(path.join(bin, "omp"), OMP_STUB, { mode: 0o755 });
	fs.writeFileSync(path.join(stub, "calls.log"), "");
	const output = path.join(root, "out");
	fs.writeFileSync(output, "");
	const env = {
		...INPUT_DEFAULTS,
		PATH: `${bin}:${process.env.PATH}`,
		GH_TOKEN: "secret-token",
		GH_STUB_DIR: stub,
		OMP_STUB_DIR: stub,
		OMP_BIN: path.join(bin, "omp"),
		GITHUB_SERVER_URL: `file://${server}`,
		GITHUB_REPOSITORY: "o/r",
		GITHUB_RUN_ID: "7",
		GITHUB_WORKSPACE: ws,
		GITHUB_OUTPUT: output,
		GITHUB_STEP_SUMMARY: path.join(root, "summary.md"),
		GITHUB_REF_TYPE: "branch",
		GITHUB_REF_NAME: "main",
		GITHUB_ACTOR: "alice",
		OMP_WORK_DIR: work,
	};
	return { root, server, ws, work, stub, baseSha, prSha, env };
}

function fx(f: Fixture, name: string, value: unknown): void {
	fs.writeFileSync(path.join(f.stub, "fx", `${name}.json`), JSON.stringify(value));
}

/** What the stub omp prints: a JSON event stream whose last assistant message is `text`. */
function agentSays(f: Fixture, text: string): void {
	const event = {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text }], usage: { cost: { total: 0.5 } } },
	};
	fs.writeFileSync(path.join(f.stub, "events.jsonl"), `${JSON.stringify(event)}\n`);
}

function calls(f: Fixture): string[] {
	return fs
		.readFileSync(path.join(f.stub, "calls.log"), "utf8")
		.split(/^CALL /m)
		.filter(Boolean)
		.map(call => call.trim());
}

function payloads(f: Fixture, name: string): Record<string, unknown>[] {
	return fs
		.readdirSync(path.join(f.stub, "payloads"))
		.sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
		.filter(file => file.endsWith(`-${name}.json`))
		.map(file => JSON.parse(fs.readFileSync(path.join(f.stub, "payloads", file), "utf8")));
}

interface Run {
	skipped: boolean;
	prepare: { code: number; out: string };
	run?: { code: number; out: string };
	publish?: { code: number; out: string };
}

/** prepare.sh, then (unless it skipped) run.sh and publish.sh, as the composite action does. */
function action(f: Fixture, eventName: string, event: unknown, extra: Record<string, string> = {}): Run {
	const eventPath = path.join(f.root, "event.json");
	fs.writeFileSync(eventPath, JSON.stringify(event));
	fs.writeFileSync(f.env.GITHUB_OUTPUT, "");
	const env = { ...f.env, GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventPath, ...extra };
	const prepare = sh(f.ws, `bash '${path.join(actionDir, "prepare.sh")}'`, env);
	const skipped = /^skip=true$/m.test(fs.readFileSync(f.env.GITHUB_OUTPUT, "utf8"));
	if (prepare.code !== 0 || skipped) return { skipped, prepare };
	const run = sh(f.ws, `bash '${path.join(actionDir, "run.sh")}'`, env);
	const publish = sh(f.ws, `bash '${path.join(actionDir, "publish.sh")}'`, env);
	return { skipped, prepare, run, publish };
}

const argv = (f: Fixture) => fs.readFileSync(path.join(f.stub, "argv.txt"), "utf8").trim().split("\n");
const prompt = (f: Fixture) => fs.readFileSync(path.join(f.stub, "stdin.md"), "utf8");
const meta = (f: Fixture) => JSON.parse(fs.readFileSync(path.join(f.work, "meta.json"), "utf8"));
const serverRefs = (f: Fixture) =>
	sh(f.root, `git --git-dir='${f.server}/o/r.git' for-each-ref --format='%(refname)'`).out.trim().split("\n");

function prEvent(f: Fixture, over: Record<string, unknown> = {}, pr: Record<string, unknown> = {}) {
	return {
		action: "opened",
		pull_request: {
			number: 5,
			title: "Add src",
			body: "Adds src.txt",
			draft: false,
			html_url: "https://github.com/o/r/pull/5",
			user: { login: "dev", type: "User" },
			author_association: "COLLABORATOR",
			head: { sha: f.prSha, ref: "pr", repo: { full_name: "o/r" } },
			base: { ref: "main" },
			...pr,
		},
		...over,
	};
}

const PR_FILES = [
	{ filename: "src.txt", status: "added", additions: 3, deletions: 0, patch: "@@ -0,0 +1,3 @@\n+one\n+two\n+three" },
	{ filename: "logo.png", status: "added", additions: 0, deletions: 0 },
];

function reviewAnswer(findings: unknown[]): string {
	return `Looks mostly fine.\n\n\`\`\`json\n${JSON.stringify({ findings })}\n\`\`\``;
}

describe("pull_request review", () => {
	it("posts one read-only review: summary, valid inline comments, the rest folded into the summary", () => {
		const f = fixture();
		fx(f, "repos_o_r_pulls_5_files", PR_FILES);
		fx(f, "repos_o_r_pulls_5_reviews", [
			{ id: 11, node_id: "R11", user: { login: "github-actions[bot]" }, body: "old\n<!-- omp-review sha=aaaa -->" },
			{ id: 12, node_id: "R12", user: { login: "mallory" }, body: "<!-- omp-review sha=bbbb -->" },
			{ id: 13, node_id: "R13", user: { login: "github-actions[bot]" }, body: "not a review of ours" },
		]);
		fx(f, "repos_o_r_pulls_5_reviews_11_comments", [{ node_id: "C11" }]);
		fx(f, "repos_o_r_pulls_5_reviews.post", { id: 99, node_id: "R99", user: { login: "github-actions[bot]" } });
		agentSays(
			f,
			reviewAnswer([
				{ path: "src.txt", line: 2, severity: "high", body: "bug here" },
				{ path: "src.txt", line: 99, severity: "low", body: "line outside the diff" },
				{ path: "nope.txt", line: 1, body: "file not in the pull request" },
				{ path: "src.txt", line: "3", body: "line is not a number" },
			]),
		);

		const result = action(f, "pull_request", prEvent(f));
		expect(result.skipped).toBe(false);
		expect(result.publish?.code).toBe(0);

		// Checked out at the PR head, prompt carries the diff and the PR text.
		expect(sh(f.ws, "git rev-parse HEAD").out.trim()).toBe(f.prSha);
		expect(prompt(f)).toContain("+two");
		expect(prompt(f)).toContain("Add src");
		expect(meta(f)).toMatchObject({ kind: "review", number: 5, head_sha: f.prSha, untrusted: false });

		// Read-only: fixed approval mode and tools, no extensions, review profile, no token.
		const args = argv(f);
		expect(args.slice(args.indexOf("--approval-mode"), args.indexOf("--approval-mode") + 2)).toEqual([
			"--approval-mode",
			"always-ask",
		]);
		expect(args[args.indexOf("--tools") + 1]).toBe(READ_ONLY_TOOLS);
		expect(args).toContain("--no-extensions");
		expect(args).not.toContain("--no-skills");
		const overlay = fs.readFileSync(path.join(f.work, "readonly.yml"), "utf8");
		expect(args[args.indexOf("--config") + 1]).toBe(path.join(f.work, "readonly.yml"));
		expect(overlay).toContain("enableProjectConfig: false");
		expect(overlay).toContain("outsideProject: deny");
		expect(overlay).toContain("default: review");
		expect(fs.readFileSync(path.join(f.stub, "token-count.txt"), "utf8").trim()).toBe("0");

		// One review through the PR review API, never an approval.
		const [review, ...more] = payloads(f, "repos_o_r_pulls_5_reviews");
		expect(more).toEqual([]);
		expect(review).toMatchObject({ commit_id: f.prSha, event: "COMMENT" });
		expect(review.comments).toEqual([{ path: "src.txt", line: 2, side: "RIGHT", body: "**high**: bug here" }]);
		const body = review.body as string;
		expect(body).toContain("Looks mostly fine.");
		expect(body).toContain("`src.txt:99`");
		expect(body).toContain("`nope.txt:1`");
		expect(body).not.toContain("not a number");
		expect(body).toContain(`<!-- omp-review sha=${f.prSha} -->`);
		expect(calls(f).filter(c => c.startsWith("api repos/o/r/issues/5/comments"))).toEqual([]);

		// Our earlier review and its inline comment are collapsed; others' are left alone.
		const graphql = calls(f).filter(c => c.startsWith("api graphql"));
		expect(graphql.some(c => c.includes("id=R11"))).toBe(true);
		expect(graphql.some(c => c.includes("id=C11"))).toBe(true);
		expect(graphql.some(c => c.includes("id=R12") || c.includes("id=R13") || c.includes("id=R99"))).toBe(false);

		// Nothing was pushed anywhere.
		expect(serverRefs(f).sort()).toEqual(["refs/heads/main", "refs/pull/5/head"]);
	});

	it("retries without inline comments when GitHub rejects them", () => {
		const f = fixture();
		fx(f, "repos_o_r_pulls_5_files", PR_FILES);
		fx(f, "repos_o_r_pulls_5_reviews.post", { id: 99, node_id: "R99", user: { login: "github-actions[bot]" } });
		agentSays(f, reviewAnswer([{ path: "src.txt", line: 1, severity: "medium", body: "first line is wrong" }]));

		const result = action(f, "pull_request", prEvent(f), { GH_STUB_FAIL_INLINE: "1" });
		expect(result.publish?.code).toBe(0);
		const sent = payloads(f, "repos_o_r_pulls_5_reviews");
		expect(sent).toHaveLength(2);
		expect((sent[0].comments as unknown[]).length).toBe(1);
		expect(sent[1].comments).toEqual([]);
		expect(sent[1].body as string).toContain("`src.txt:1`");
		expect(sent[1].body as string).toContain("first line is wrong");
	});

	it("caps inline comments and lists the overflow in the summary", () => {
		const f = fixture();
		fx(f, "repos_o_r_pulls_5_files", PR_FILES);
		fx(f, "repos_o_r_pulls_5_reviews.post", { id: 99, node_id: "R99", user: { login: "github-actions[bot]" } });
		agentSays(
			f,
			reviewAnswer([
				{ path: "src.txt", line: 1, body: "first" },
				{ path: "src.txt", line: 2, body: "second" },
			]),
		);
		action(f, "pull_request", prEvent(f), { OMP_MAX_INLINE_COMMENTS: "1" });
		const [review] = payloads(f, "repos_o_r_pulls_5_reviews");
		expect((review.comments as unknown[]).length).toBe(1);
		expect(review.body as string).toContain("`src.txt:2`");
	});

	it("posts a failure comment and no review when omp fails", () => {
		const f = fixture();
		fx(f, "repos_o_r_pulls_5_files", PR_FILES);
		agentSays(f, "partial");
		const result = action(f, "pull_request", prEvent(f), { OMP_STUB_EXIT: "1" });
		expect(result.publish?.code).toBe(1);
		expect(payloads(f, "repos_o_r_pulls_5_reviews")).toEqual([]);
		expect(calls(f).some(c => c.startsWith("api repos/o/r/issues/5/comments"))).toBe(true);
	});

	interface SkipCase {
		name: string;
		eventName?: string;
		event: (f: Fixture) => Record<string, unknown>;
		inputs?: Record<string, string>;
		alreadyReviewed?: boolean;
	}
	const forkHead = (f: Fixture) => ({ head: { sha: f.prSha, ref: "x", repo: { full_name: "evil/r" } } });
	const skipCases: SkipCase[] = [
		{ name: "activity type not configured", event: f => prEvent(f, { action: "labeled" }) },
		{ name: "draft pull request", event: f => prEvent(f, {}, { draft: true }) },
		{ name: "bot author", event: f => prEvent(f, {}, { user: { login: "dependabot[bot]", type: "Bot" } }) },
		{ name: "author association not allowed", event: f => prEvent(f, {}, { author_association: "NONE" }) },
		{ name: "fork without allow-fork-prs", event: f => prEvent(f, {}, forkHead(f)) },
		{
			name: "fork under pull_request even with allow-fork-prs",
			eventName: "pull_request",
			event: f => prEvent(f, {}, forkHead(f)),
			inputs: { OMP_ALLOW_FORK_PRS: "true" },
		},
		{ name: "commit already reviewed", event: f => prEvent(f), alreadyReviewed: true },
		{
			name: "head moved on since the event",
			event: f => prEvent(f, {}, { head: { sha: "0".repeat(40), ref: "pr", repo: { full_name: "o/r" } } }),
		},
	];
	for (const skipCase of skipCases) {
		it(`skips: ${skipCase.name}`, () => {
			const f = fixture();
			fx(f, "repos_o_r_pulls_5_files", PR_FILES);
			if (skipCase.alreadyReviewed) {
				const body = `x\n<!-- omp-review sha=${f.prSha} -->`;
				fx(f, "repos_o_r_pulls_5_reviews", [
					{ id: 1, node_id: "R1", user: { login: "github-actions[bot]" }, body },
				]);
			}
			const result = action(f, skipCase.eventName ?? "pull_request_target", skipCase.event(f), skipCase.inputs);
			expect(result.skipped).toBe(true);
			expect(fs.existsSync(path.join(f.stub, "argv.txt"))).toBe(false);
			expect(payloads(f, "repos_o_r_pulls_5_reviews")).toEqual([]);
		});
	}

	it("runs on synchronize and ready_for_review when configured, not on opened", () => {
		const f = fixture();
		fx(f, "repos_o_r_pulls_5_files", PR_FILES);
		fx(f, "repos_o_r_pulls_5_reviews.post", { id: 99, node_id: "R99", user: { login: "github-actions[bot]" } });
		agentSays(f, reviewAnswer([]));
		expect(
			action(f, "pull_request", prEvent(f, { action: "opened" }), { OMP_PR_ACTIONS: "synchronize" }).skipped,
		).toBe(true);
		expect(
			action(f, "pull_request", prEvent(f, { action: "synchronize" }), { OMP_PR_ACTIONS: "synchronize" }).skipped,
		).toBe(false);
	});

	it("reviews a fork pull request (pull_request_target) read-only, without skills, rules or project config, whatever the inputs say", () => {
		const f = fixture();
		fx(f, "repos_o_r_pulls_5_files", PR_FILES);
		fx(f, "repos_o_r_pulls_5_reviews.post", { id: 99, node_id: "R99", user: { login: "github-actions[bot]" } });
		agentSays(f, reviewAnswer([]));
		const fork = { head: { sha: f.prSha, ref: "x", repo: { full_name: "evil/r" } } };
		const result = action(f, "pull_request_target", prEvent(f, {}, fork), {
			OMP_ALLOW_FORK_PRS: "true",
			OMP_APPROVAL_MODE: "yolo",
			OMP_TOOLS: "bash,edit",
			OMP_PROJECT_EXTENSIONS: "true",
		});
		expect(result.publish?.code).toBe(0);
		expect(meta(f)).toMatchObject({ cross_repo: true, untrusted: true });
		const args = argv(f);
		expect(args[args.indexOf("--approval-mode") + 1]).toBe("always-ask");
		expect(args[args.indexOf("--tools") + 1]).toBe(READ_ONLY_TOOLS);
		expect(args).toEqual(expect.arrayContaining(["--no-extensions", "--no-skills", "--no-rules"]));
		expect(result.run?.out).not.toContain("yolo");
		expect(serverRefs(f).sort()).toEqual(["refs/heads/main", "refs/pull/5/head"]);
	});
});

describe("issues triage", () => {
	const issue = (over: Record<string, unknown> = {}, action = "opened") => ({
		action,
		issue: {
			number: 3,
			title: "App crashes on startup with broken config",
			body: "It crashes.",
			user: { login: "bob", type: "User" },
			author_association: "COLLABORATOR",
			html_url: "https://github.com/o/r/issues/3",
			...over,
		},
		repository: { default_branch: "main" },
	});

	function seed(f: Fixture, answer: string): void {
		fx(f, "repos_o_r_labels", [
			{ name: "bug", description: "Something is broken" },
			{ name: "docs", description: null },
		]);
		fx(f, "search_issues", {
			items: [
				{ number: 3, title: "App crashes on startup with broken config", state: "open", html_url: "u3" },
				{ number: 12, title: "Crash at startup", state: "open", html_url: "u12" },
			],
		});
		agentSays(f, answer);
	}
	const triageAnswer = (json: unknown) =>
		`Thanks, could you share your version?\n\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\``;
	const commentCalls = (f: Fixture) => calls(f).filter(c => c.startsWith("api repos/o/r/issues/3/comments"));

	it("proposes labels without applying them and posts a single comment", () => {
		const f = fixture();
		seed(f, triageAnswer({ labels: ["bug", "made-up"], duplicate_of: 12 }));
		const result = action(f, "issues", issue());
		expect(result.publish?.code).toBe(0);

		// The prompt lists the real labels and the search candidates, minus the issue itself.
		const text = prompt(f);
		expect(text).toContain("`bug`: Something is broken");
		expect(text).toContain("#12 [open] Crash at startup");
		expect(text).not.toContain("#3 [open]");
		expect(calls(f).some(c => c.includes("repo:o/r is:issue in:title"))).toBe(true);

		const args = argv(f);
		expect(args[args.indexOf("--approval-mode") + 1]).toBe("always-ask");
		expect(args[args.indexOf("--tools") + 1]).toBe(READ_ONLY_TOOLS);
		expect(fs.readFileSync(path.join(f.work, "readonly.yml"), "utf8")).not.toContain("profile");

		expect(commentCalls(f)).toHaveLength(1);
		const comment = fs.readFileSync(path.join(f.work, "comment.md"), "utf8");
		expect(comment).toContain("could you share your version");
		expect(comment).toContain("Suggested labels: `bug` (not applied)");
		expect(comment).not.toContain("made-up");
		expect(comment).toContain("Possible duplicate of #12");
		expect(comment).not.toContain("```json");
		expect(calls(f).some(c => c.includes("labels[]"))).toBe(false);
	});

	it("applies only existing labels when apply-labels is true", () => {
		const f = fixture();
		seed(f, triageAnswer({ labels: ["bug", "made-up", "docs"], duplicate_of: null }));
		const result = action(f, "issues", issue(), { OMP_APPLY_LABELS: "true" });
		expect(result.publish?.code).toBe(0);
		const apply = calls(f).filter(c => c.includes("issues/3/labels"));
		expect(apply).toHaveLength(1);
		expect(apply[0]).toContain("labels[]=bug");
		expect(apply[0]).toContain("labels[]=docs");
		expect(apply[0]).not.toContain("made-up");
		expect(commentCalls(f)).toHaveLength(1);
		expect(fs.readFileSync(path.join(f.work, "comment.md"), "utf8")).toContain("Labels applied: `bug`, `docs`");
	});

	it("ignores a duplicate that was not a search candidate", () => {
		const f = fixture();
		seed(f, triageAnswer({ labels: [], duplicate_of: 999 }));
		action(f, "issues", issue());
		expect(fs.readFileSync(path.join(f.work, "comment.md"), "utf8")).not.toContain("duplicate");
	});

	it("posts the comment as is when the answer has no json block", () => {
		const f = fixture();
		seed(f, "Just a comment.");
		const result = action(f, "issues", issue(), { OMP_APPLY_LABELS: "true" });
		expect(result.publish?.code).toBe(0);
		expect(commentCalls(f)).toHaveLength(1);
		expect(calls(f).some(c => c.includes("labels[]"))).toBe(false);
	});

	it("skips edited issues, bots, pull requests and unlisted associations", () => {
		const f = fixture();
		seed(f, "x");
		expect(action(f, "issues", issue({}, "edited")).skipped).toBe(true);
		expect(action(f, "issues", issue({ user: { login: "ci[bot]", type: "Bot" } })).skipped).toBe(true);
		expect(action(f, "issues", issue({ author_association: "NONE" })).skipped).toBe(true);
		expect(action(f, "issues", issue({ pull_request: {} })).skipped).toBe(true);
		expect(fs.existsSync(path.join(f.stub, "argv.txt"))).toBe(false);
		expect(
			action(f, "issues", issue({ author_association: "NONE" }), { OMP_TRIAGE_ASSOCIATIONS: "NONE" }).skipped,
		).toBe(false);
	});
});

describe("schedule and workflow_dispatch", () => {
	const schedule = { schedule: "0 3 * * 1", repository: { default_branch: "main" } };

	it("runs the prompt input and opens a pull request through the publish path", () => {
		const f = fixture();
		agentSays(f, "Bumped two dependencies.");
		const result = action(f, "schedule", schedule, {
			OMP_PROMPT: "Update outdated dependencies",
			OMP_STUB_WRITE: path.join(f.ws, "deps.txt"),
		});
		expect(result.publish?.code).toBe(0);

		expect(prompt(f)).toContain("Update outdated dependencies");
		expect(prompt(f)).toContain("schedule run");
		expect(meta(f)).toMatchObject({ kind: "task", title: "Update outdated dependencies", base_ref: "main" });
		// The task is the maintainer's: normal write mode, no read-only overlay.
		const args = argv(f);
		expect(args[args.indexOf("--approval-mode") + 1]).toBe("write");
		expect(args).not.toContain("--config");

		const show = sh(f.root, `git --git-dir='${f.server}/o/r.git' show --stat --format=%s omp/task-7`);
		expect(show.out).toContain("omp: Update outdated dependencies");
		expect(show.out).toContain("deps.txt");
		const create = calls(f).find(c => c.startsWith("pr create"));
		expect(create).toContain("--base main --head omp/task-7");
		expect(create).toContain("--title omp: Update outdated dependencies");
		expect(fs.readFileSync(path.join(f.work, "pr-body.md"), "utf8")).toContain("Bumped two dependencies.");
		expect(fs.readFileSync(f.env.GITHUB_OUTPUT, "utf8")).toContain("pull-request-url=https://example/pr/1");
		// No thread to comment on: the reply is the job summary.
		expect(calls(f).some(c => c.includes("/comments"))).toBe(false);
		expect(fs.readFileSync(f.env.GITHUB_STEP_SUMMARY, "utf8")).toContain("Bumped two dependencies.");
	});

	it("takes the prompt from the dispatch inputs and targets the branch it ran on", () => {
		const f = fixture();
		agentSays(f, "done");
		const event = { inputs: { prompt: "Bump versions\nthen run the tests" }, repository: { default_branch: "main" } };
		const result = action(f, "workflow_dispatch", event, {
			GITHUB_REF_NAME: "release",
			OMP_STUB_WRITE: path.join(f.ws, "bump.txt"),
		});
		expect(result.publish?.code).toBe(0);
		expect(prompt(f)).toContain("then run the tests");
		expect(meta(f)).toMatchObject({ title: "Bump versions", base_ref: "release" });
		expect(calls(f).find(c => c.startsWith("pr create"))).toContain("--base release");
	});

	it("opens no pull request when nothing changed, and fails without a prompt", () => {
		const f = fixture();
		agentSays(f, "Nothing to update.");
		const result = action(f, "schedule", schedule, { OMP_PROMPT: "Update dependencies" });
		expect(result.publish?.code).toBe(0);
		expect(calls(f).some(c => c.startsWith("pr create"))).toBe(false);
		expect(serverRefs(f)).not.toContain("refs/heads/omp/task-7");
		expect(fs.readFileSync(f.env.GITHUB_STEP_SUMMARY, "utf8")).toContain("Nothing to update.");

		const empty = action(f, "workflow_dispatch", { inputs: {}, repository: { default_branch: "main" } });
		expect(empty.prepare.code).toBe(1);
		expect(empty.prepare.out).toContain("::error::");
	});
});

describe("event gating", () => {
	it("never runs on push or other unlisted events", () => {
		const f = fixture();
		const result = action(f, "push", { ref: "refs/heads/main" });
		expect(result.skipped).toBe(true);
		expect(result.prepare.code).toBe(0);
		expect(fs.existsSync(path.join(f.stub, "argv.txt"))).toBe(false);
	});

	it("still handles comment mentions", () => {
		const f = fixture();
		agentSays(f, "On it.");
		const comment = (association: string) => ({
			action: "created",
			issue: { number: 3, title: "t", body: "b" },
			comment: {
				body: "@omp please look",
				html_url: "u",
				user: { login: "bob", type: "User" },
				author_association: association,
			},
			repository: { default_branch: "main" },
		});
		expect(action(f, "issue_comment", comment("NONE")).skipped).toBe(true);
		const result = action(f, "issue_comment", comment("OWNER"));
		expect(result.publish?.code).toBe(0);
		expect(meta(f).kind).toBe("mention");
		expect(argv(f)[argv(f).indexOf("--approval-mode") + 1]).toBe("write");
		expect(calls(f).some(c => c.startsWith("api repos/o/r/issues/3/comments"))).toBe(true);
	});

	it("is not used by any workflow in this repository", () => {
		const dir = path.join(repoRoot, ".github/workflows");
		for (const file of fs.readdirSync(dir)) {
			expect(fs.readFileSync(path.join(dir, file), "utf8")).not.toContain("actions/omp");
		}
	});

	it.skipIf(!Bun.which("shellcheck"))("passes shellcheck", () => {
		const scripts = fs.readdirSync(actionDir).filter(file => file.endsWith(".sh"));
		const result = sh(actionDir, `shellcheck -x -P SCRIPTDIR ${scripts.join(" ")}`);
		expect(result.out).toBe("");
		expect(result.code).toBe(0);
	});
});
