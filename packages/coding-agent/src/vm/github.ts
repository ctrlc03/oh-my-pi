/**
 * GitHub for VM sessions: the App (config, JWT, installation tokens) and the `omp vm github` actions.
 * See docs/vm-sessions.md.
 */
import { openPath } from "../utils/open";
import { type GithubAppCredentials, listInstallations, loadGithubApp, saveGithubApp } from "./github-core";
import { defaultGhRunner, type GithubProtectDeps, protectRepository } from "./github-protect";
import { type GithubSetupDeps, setupGithubApp } from "./github-setup";
import { getVmRoot } from "./paths";

export {
	createAppJwt,
	type GithubAppConfig,
	type GithubAppCredentials,
	InstallationTokens,
	type InstallationTokensOptions,
	loadGithubApp,
	saveGithubApp,
} from "./github-core";
export type { GhRunner } from "./github-protect";

export type VmGithubAction = "setup" | "status" | "protect";

export interface VmGithubFlags {
	owner?: string;
	json?: boolean;
	appId?: number;
	key?: string;
}

/** Test seams; the CLI passes none. */
export interface VmGithubDeps extends Partial<GithubSetupDeps>, Partial<Pick<GithubProtectDeps, "confirm" | "isTTY">> {}

async function showStatus(flags: VmGithubFlags, deps: GithubSetupDeps): Promise<void> {
	const loaded = await loadGithubApp(deps.root);
	if (!loaded) {
		if (flags.json) deps.out(JSON.stringify({ configured: false }));
		else deps.out("No GitHub App is configured. Run `omp vm github setup`.");
		return;
	}
	const credentials: GithubAppCredentials = loaded;
	let refreshed = true;
	try {
		const installations = await listInstallations(credentials, deps.fetch, deps.now());
		if (JSON.stringify(installations) !== JSON.stringify(credentials.config.installations)) {
			credentials.config.installations = installations;
			await saveGithubApp(credentials.config, credentials.privateKey, deps.root);
		}
	} catch {
		refreshed = false;
	}
	const owners = Object.keys(credentials.config.installations).sort();
	if (flags.json) {
		deps.out(JSON.stringify({ configured: true, slug: credentials.config.slug, owners }));
		return;
	}
	deps.out(`GitHub App: ${credentials.config.slug} (${credentials.config.htmlUrl})`);
	deps.out(`Bot: ${credentials.config.bot.name} <${credentials.config.bot.email}>`);
	deps.out(
		owners.length === 0
			? `Not installed anywhere yet: ${credentials.config.htmlUrl}/installations/new`
			: `Installed on: ${owners.join(", ")}`,
	);
	if (!refreshed) deps.out("Could not reach GitHub to refresh installations; showing the saved list.");
}

/** `omp vm github <setup|status|protect>`. `protect` also reads `--yes` from `args`. */
export async function runVmGithubCommand(
	action: VmGithubAction,
	args: string[],
	flags: VmGithubFlags,
	deps: VmGithubDeps = {},
): Promise<void> {
	const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
	const runGh = deps.runGh ?? defaultGhRunner;
	if (action === "protect") {
		const repo = args.find(arg => !arg.startsWith("-"));
		if (!repo) throw new Error("Usage: omp vm github protect <owner/repo> [--yes]");
		await protectRepository(repo, args, { runGh, out, confirm: deps.confirm, isTTY: deps.isTTY });
		return;
	}
	const setupDeps: GithubSetupDeps = {
		fetch: deps.fetch ?? globalThis.fetch,
		now: deps.now ?? Date.now,
		sleep: deps.sleep ?? (ms => Bun.sleep(ms)),
		openUrl: deps.openUrl ?? openPath,
		runGh,
		out,
		root: deps.root ?? getVmRoot(),
	};
	if (action === "status") await showStatus(flags, setupDeps);
	else await setupGithubApp(flags, setupDeps);
}
