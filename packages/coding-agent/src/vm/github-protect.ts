/**
 * `omp vm github protect <owner/repo>`: repository rulesets that keep a VM's GitHub App token from
 * rewriting history. The App can still push branches and open pull requests; deleting or force-pushing
 * the default branch and touching release tags is blocked for everyone except repository admins.
 * Rulesets are created with the user's own `gh` (the App holds no administration permission).
 */
import * as readline from "node:readline";

export interface GhResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** Runs `gh <args>`; `input` goes to its stdin. */
export type GhRunner = (args: string[], input?: string) => Promise<GhResult>;

export const defaultGhRunner: GhRunner = async (args, input) => {
	const proc = Bun.spawn(["gh", ...args], {
		stdin: input === undefined ? "ignore" : new Blob([input]),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
};

export interface GithubRuleset {
	name: string;
	target: "branch" | "tag";
	enforcement: "active";
	conditions: { ref_name: { include: string[]; exclude: string[] } };
	rules: Array<{ type: string }>;
	bypass_actors: Array<{ actor_type: string; actor_id: number; bypass_mode: string }>;
}

/** Repository role 5 is "admin": admins keep pushing. */
const ADMIN_BYPASS = [{ actor_type: "RepositoryRole", actor_id: 5, bypass_mode: "always" }];

export function buildProtectRulesets(): GithubRuleset[] {
	return [
		{
			name: "omp-vm: protect default branch",
			target: "branch",
			enforcement: "active",
			conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
			rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "update" }],
			bypass_actors: ADMIN_BYPASS,
		},
		{
			name: "omp-vm: protect release tags",
			target: "tag",
			enforcement: "active",
			conditions: { ref_name: { include: ["refs/tags/v*", "refs/tags/collab-v*"], exclude: [] } },
			rules: [{ type: "creation" }, { type: "update" }, { type: "deletion" }],
			bypass_actors: ADMIN_BYPASS,
		},
	];
}

export interface GithubProtectDeps {
	runGh: GhRunner;
	out: (line: string) => void;
	/** Answers the confirmation prompt. Defaults to asking on the terminal. */
	confirm?: (question: string) => Promise<boolean>;
	isTTY?: boolean;
}

async function askOnTerminal(question: string): Promise<boolean> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await new Promise<string>(resolve => rl.question(`${question} [y/N] `, resolve));
		return /^y(es)?$/i.test(answer.trim());
	} finally {
		rl.close();
	}
}

function describeRuleset(ruleset: GithubRuleset): string {
	const refs = ruleset.conditions.ref_name.include.join(", ");
	const rules = ruleset.rules.map(rule => rule.type).join(", ");
	return `  ${ruleset.name} (${ruleset.target} ${refs}): blocks ${rules}; repository admins bypass`;
}

export async function protectRepository(repo: string, args: string[], deps: GithubProtectDeps): Promise<void> {
	if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(repo)) {
		throw new Error(`Expected a repository as owner/repo, got '${repo}'`);
	}
	const yes = args.includes("--yes") || args.includes("-y");
	const listed = await deps.runGh(["api", `repos/${repo}/rulesets?per_page=100`]);
	if (listed.exitCode !== 0) {
		const detail = listed.stderr.trim();
		// GitHub Free has no rulesets on private repositories.
		const hint = /Upgrade to GitHub Pro/i.test(detail)
			? "\nRulesets on a private repository need GitHub Pro, Team or Enterprise (or a public repository). Without them, keep the App off repositories whose default branch or tags must not move."
			: "";
		throw new Error(`gh could not list rulesets of ${repo}: ${detail}${hint}`);
	}
	let existing: string[];
	try {
		existing = (JSON.parse(listed.stdout) as Array<{ name: string }>).map(entry => entry.name);
	} catch {
		throw new Error(`gh returned unreadable rulesets for ${repo}`);
	}
	const wanted = buildProtectRulesets();
	const missing = wanted.filter(ruleset => !existing.includes(ruleset.name));
	for (const ruleset of wanted) {
		if (!missing.includes(ruleset)) deps.out(`Ruleset '${ruleset.name}' already exists on ${repo}; skipping.`);
	}
	if (missing.length === 0) return;

	deps.out(`Will create on ${repo}:`);
	for (const ruleset of missing) deps.out(describeRuleset(ruleset));
	if (!yes) {
		if (!(deps.isTTY ?? process.stdin.isTTY === true)) {
			throw new Error("Refusing to change repository rulesets without confirmation: pass --yes");
		}
		if (
			!(await (deps.confirm ?? askOnTerminal)(`Create ${missing.length === 1 ? "this ruleset" : "these rulesets"}?`))
		) {
			deps.out("Aborted; nothing was changed.");
			return;
		}
	}
	for (const ruleset of missing) {
		const created = await deps.runGh(
			["api", "--method", "POST", `repos/${repo}/rulesets`, "--input", "-"],
			JSON.stringify(ruleset),
		);
		if (created.exitCode !== 0) {
			throw new Error(`gh could not create ruleset '${ruleset.name}' on ${repo}: ${created.stderr.trim()}`);
		}
		deps.out(`Created ruleset '${ruleset.name}'.`);
	}
}
