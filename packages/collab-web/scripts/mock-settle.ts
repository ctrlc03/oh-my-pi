/**
 * The `git-settings` request and the settle cleanup for scripts/mock-companion.ts, so the worktree settings and
 * a cleanup result can be tried in a browser without omp or tmux. It runs the real code (./companion-worktrees,
 * ./companion-settle) against a throw-away git repository: the worktrees, the approval of the repository's
 * `.omp/worktree-settle`, the command that runs in the tree when its session settles, the sandbox profile and the
 * recorded result are real; only the sessions are fake host entries standing in those worktrees (one of them sandboxed,
 * whose worktree is therefore skipped).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CompanionHost, CompanionReply, CompanionRequest } from "../src/lib/companion";
import { createWorktree } from "./companion-gitflow";
import { createSettleCleanup, loadSettleState, saveSettleState } from "./companion-settle";
import type { SettledSession } from "./companion-sessionorg";
import {
	applySetupTrust,
	effectiveWorktreesDir,
	loadGitFlowFile,
	parseGitFlowSettings,
	projectSettleStatuses,
	projectSetupStatuses,
	replaceSettings,
	saveGitFlowFile,
	worktreeLocations,
} from "./companion-worktrees";

const REPO_SETTLE_SCRIPT = `#!/bin/sh
# Free the disk a settled worktree holds on to.
rm -rf node_modules target
echo "cleaned $OMP_WORKTREE_PATH"
`;

async function sh(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(err.trim() || `${args.join(" ")} failed`);
	return out.trim();
}

export interface MockSettle {
	/** Fields the mock companion's `hosts` frame needs for the app to show the worktree settings. */
	capabilities: { canGitFlow: true };
	/** Clean up after sessions the organiser reported as settled. */
	run(sessions: readonly SettledSession[]): Promise<void>;
	handles(request: CompanionRequest): boolean;
	answer(request: CompanionRequest): Promise<CompanionReply>;
}

export async function createMockSettle(options: {
	dir: string;
	/** The mock companion's live session list: two sessions working in worktrees are added to it. */
	hosts: CompanionHost[];
}): Promise<MockSettle> {
	const repo = path.join(options.dir, "settle-repo");
	const defaultWorktrees = path.join(options.dir, "settle-worktrees");
	const gitFlowPath = path.join(options.dir, "collab-companion-git.json");
	const statePath = path.join(options.dir, "collab-companion-settle.json");
	await fs.mkdir(path.join(repo, ".omp"), { recursive: true });
	if (!(await Bun.file(path.join(repo, ".git", "HEAD")).exists())) {
		await sh(repo, "git", "init", "-q", "-b", "main");
		await sh(repo, "git", "config", "user.name", "mock");
		await sh(repo, "git", "config", "user.email", "mock@example.com");
		await sh(repo, "git", "config", "commit.gpgsign", "false");
		await Bun.write(path.join(repo, "README.md"), "# settle demo\n");
		await Bun.write(path.join(repo, ".omp", "worktree-settle"), REPO_SETTLE_SCRIPT);
		await sh(repo, "git", "add", ".");
		await sh(repo, "git", "commit", "-q", "-m", "init");
	}
	const root = await fs.realpath(repo);
	let gitFlow = await loadGitFlowFile(gitFlowPath);
	const unapprovedSettles = new Set<string>([root]);
	const unapprovedSetups = new Set<string>();

	const settleCleanup = createSettleCleanup({
		initial: await loadSettleState(statePath),
		save: state => saveSettleState(statePath, state),
		flow: () => gitFlow,
		dirs: () => worktreeLocations(gitFlow, defaultWorktrees),
		listing: async () =>
			options.hosts.map(host => ({
				sessionId: host.sessionId,
				cwd: host.cwd,
				sandboxed: host.sandboxed === true,
			})),
		onUnapproved: unapproved => unapprovedSettles.add(unapproved),
		onError: err =>
			console.error(`mock-companion: settle cleanup failed: ${err instanceof Error ? err.message : String(err)}`),
	});

	/** A session working in a fresh worktree with something worth cleaning up in it. */
	const demoSession = async (n: number, name: string, branch: string, sandboxed: boolean): Promise<void> => {
		const folder = path.join(defaultWorktrees, path.basename(root), branch.replaceAll("/", "-"));
		const exists = await fs.stat(folder).then(
			() => true,
			() => false,
		);
		const tree = exists ? { path: folder } : await createWorktree(root, defaultWorktrees, branch);
		const resolved = await fs.realpath(tree.path);
		await fs.mkdir(path.join(resolved, "node_modules", "left-pad"), { recursive: true });
		await Bun.write(path.join(resolved, "node_modules", "left-pad", "index.js"), "module.exports = () => 0;\n");
		await Bun.write(path.join(resolved, "target.log"), "build output\n");
		if (sandboxed) await settleCleanup.recordSandboxed(resolved);
		await settleCleanup.recordSession(`session-wt-${n}`, resolved);
		options.hosts.push({
			instanceId: `inst-wt-${n}`,
			sessionId: `session-wt-${n}`,
			sessionName: name,
			cwd: resolved,
			model: "anthropic/claude-sonnet-5-5",
			startedAt: Date.now() - n * 3_600_000,
			participants: 1,
			busy: false,
			inputRequired: false,
			relayConnected: true,
			sandboxed,
		});
	};
	await demoSession(1, "worktree-cleanup", "mock/cleanup-demo", false);
	await demoSession(2, "worktree-sandboxed", "mock/cleanup-sandboxed", true);

	return {
		capabilities: { canGitFlow: true },
		run: sessions => settleCleanup.run(sessions),
		handles: request => request.t === "git-settings",
		async answer(request) {
			if (request.t !== "git-settings") throw new Error(`the mock companion does not answer ${request.t}`);
			if (request.settings !== undefined) {
				const next = {
					...request.settings,
					settleScript: request.settings.settleScript ?? gitFlow.settings.settleScript,
				};
				gitFlow = replaceSettings(gitFlow, parseGitFlowSettings(next, true), defaultWorktrees);
				await saveGitFlowFile(gitFlowPath, gitFlow);
			}
			if (request.trust !== undefined) {
				gitFlow = await applySetupTrust(
					gitFlow,
					request.trust.kind === "settle" ? unapprovedSettles : unapprovedSetups,
					request.trust,
				);
				await saveGitFlowFile(gitFlowPath, gitFlow);
			}
			return {
				t: "git-settings",
				reqId: request.reqId,
				settings: gitFlow.settings,
				worktreesDir: effectiveWorktreesDir(gitFlow.settings, defaultWorktrees),
				projects: await projectSetupStatuses(gitFlow, unapprovedSetups),
				settleCleanup: {
					projects: await projectSettleStatuses(gitFlow, unapprovedSettles),
					results: await settleCleanup.results(),
				},
			};
		},
	};
}
