/**
 * `omp vm github setup`: create the GitHub App through GitHub's manifest flow, or adopt an existing one.
 *
 * Manifest flow: a throwaway server on 127.0.0.1 serves a page that POSTs the manifest to GitHub; GitHub
 * redirects back to `/callback?code&state` with a one-time code, which is exchanged for the App's private
 * key and ids. The user then installs the App on their account/org; omp polls until an installation shows.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import {
	createAppJwt,
	GITHUB_API,
	GITHUB_APP_PERMISSIONS,
	type GithubAppConfig,
	type GithubAppCredentials,
	githubApi,
	listInstallations,
	saveGithubApp,
} from "./github-core";
import type { GhRunner } from "./github-protect";
import { githubAppKeyPath } from "./paths";

export const GITHUB_APP_HOMEPAGE = "https://github.com/ctrlc03/oh-my-pi";
const CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;
const INSTALL_POLL_MS = 3000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

export interface GithubSetupDeps {
	fetch: typeof fetch;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	/** Best-effort browser launch. */
	openUrl: (url: string) => void;
	runGh: GhRunner;
	out: (line: string) => void;
	root: string;
}

export interface GithubSetupFlags {
	owner?: string;
	appId?: number;
	key?: string;
}

interface AppRegistration {
	id: number;
	clientId: string;
	slug: string;
	htmlUrl: string;
	pem: string;
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
}

export function buildManifest(name: string, redirectUrl: string): Record<string, unknown> {
	return {
		name,
		url: GITHUB_APP_HOMEPAGE,
		hook_attributes: { url: "https://example.invalid/", active: false },
		redirect_url: redirectUrl,
		public: false,
		default_permissions: GITHUB_APP_PERMISSIONS,
		default_events: [],
	};
}

function formPage(action: string, manifest: Record<string, unknown>): string {
	return `<!doctype html><meta charset="utf-8"><title>omp vm github setup</title>
<body onload="document.forms[0].submit()">
<form method="post" action="${escapeHtml(action)}">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<noscript><button type="submit">Continue to GitHub</button></noscript>
</form>
<p>Redirecting to GitHub to create the App...</p>
</body>`;
}

function resultPage(message: string): string {
	return `<!doctype html><meta charset="utf-8"><title>omp vm github setup</title><body><p>${escapeHtml(message)}</p></body>`;
}

async function ghLogin(runGh: GhRunner): Promise<string | undefined> {
	try {
		const result = await runGh(["api", "user", "--jq", ".login"]);
		const login = result.stdout.trim();
		return result.exitCode === 0 && /^[A-Za-z0-9-]+$/.test(login) ? login : undefined;
	} catch {
		return undefined;
	}
}

/** Looks up the App's bot user and persists the App. The private key is the only copy: keep it on failure. */
async function registerApp(registration: AppRegistration, deps: GithubSetupDeps): Promise<GithubAppCredentials> {
	let botUserId: number;
	try {
		const bot = await githubApi<{ id: number }>(`${GITHUB_API}/users/${registration.slug}%5Bbot%5D`, {
			fetch: deps.fetch,
		});
		botUserId = bot.id;
	} catch (error) {
		await fs.mkdir(deps.root, { recursive: true, mode: 0o700 });
		await fs.writeFile(githubAppKeyPath(deps.root), registration.pem, { mode: 0o600 });
		throw new Error(
			`The App ${registration.slug} (id ${registration.id}) was created and its key saved to ${githubAppKeyPath(deps.root)}, ` +
				`but its bot user could not be looked up: ${error instanceof Error ? error.message : String(error)}. ` +
				`Finish with: omp vm github setup --app-id ${registration.id} --key ${githubAppKeyPath(deps.root)}`,
		);
	}
	const botName = `${registration.slug}[bot]`;
	const config: GithubAppConfig = {
		appId: registration.id,
		clientId: registration.clientId,
		slug: registration.slug,
		htmlUrl: registration.htmlUrl,
		bot: { name: botName, email: `${botUserId}+${botName}@users.noreply.github.com` },
		installations: {},
	};
	await saveGithubApp(config, registration.pem, deps.root);
	return { config, privateKey: registration.pem };
}

/** Starts the local server and resolves with the registered App once GitHub has redirected back. */
async function runManifestFlow(owner: string | undefined, deps: GithubSetupDeps): Promise<GithubAppCredentials> {
	const login = await ghLogin(deps.runGh);
	const name = `omp-vm-${login ?? crypto.randomBytes(3).toString("hex")}`.slice(0, 34);
	const state = crypto.randomBytes(16).toString("hex");
	const target = owner
		? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new`
		: "https://github.com/settings/apps/new";
	const outcome = Promise.withResolvers<GithubAppCredentials>();
	// A failed attempt must not surface as an unhandled rejection when nobody awaits `outcome` yet.
	outcome.promise.catch(() => undefined);
	let consumed = false;
	let redirectUrl = "";
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const html = { "Content-Type": "text/html; charset=utf-8" };
			if (url.pathname === "/" && request.method === "GET") {
				const page = formPage(`${target}?state=${state}`, buildManifest(name, redirectUrl));
				return new Response(page, { headers: html });
			}
			if (url.pathname !== "/callback" || request.method !== "GET")
				return new Response("Not found", { status: 404 });
			const code = url.searchParams.get("code");
			if (url.searchParams.get("state") !== state || !code || consumed) {
				return new Response(resultPage("Invalid or repeated callback; nothing was created."), {
					status: 400,
					headers: html,
				});
			}
			consumed = true;
			try {
				const converted = await githubApi<{
					id: number;
					client_id: string;
					slug: string;
					html_url: string;
					pem: string;
				}>(`${GITHUB_API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
					fetch: deps.fetch,
					method: "POST",
				});
				const credentials = await registerApp(
					{
						id: converted.id,
						clientId: converted.client_id,
						slug: converted.slug,
						htmlUrl: converted.html_url,
						pem: converted.pem,
					},
					deps,
				);
				outcome.resolve(credentials);
				return new Response(resultPage("GitHub App created. You can close this tab and return to the terminal."), {
					headers: html,
				});
			} catch (error) {
				outcome.reject(error);
				return new Response(resultPage("Creating the App failed; see the terminal."), {
					status: 500,
					headers: html,
				});
			}
		},
	});
	const timer = setTimeout(
		() => outcome.reject(new Error("Timed out waiting for GitHub to redirect back; run setup again")),
		CALLBACK_TIMEOUT_MS,
	);
	try {
		redirectUrl = `http://127.0.0.1:${server.port}/callback`;
		const startUrl = `http://127.0.0.1:${server.port}/`;
		deps.out(`Creating GitHub App '${name}'${owner ? ` for organization ${owner}` : ""}.`);
		deps.out(`Opening ${startUrl} — if the browser does not open, visit it yourself.`);
		deps.openUrl(startUrl);
		return await outcome.promise;
	} finally {
		clearTimeout(timer);
		// Let the in-flight callback response finish before closing.
		await server.stop();
	}
}

/** Waits for the App to be installed anywhere and records the installations. */
async function awaitInstallation(credentials: GithubAppCredentials, deps: GithubSetupDeps): Promise<void> {
	const installUrl = `${credentials.config.htmlUrl}/installations/new`;
	deps.out(`Install the App on the account and repositories your VMs will use: ${installUrl}`);
	deps.openUrl(installUrl);
	const deadline = deps.now() + INSTALL_TIMEOUT_MS;
	for (;;) {
		const installations = await listInstallations(credentials, deps.fetch, deps.now());
		if (Object.keys(installations).length > 0) {
			credentials.config.installations = installations;
			await saveGithubApp(credentials.config, credentials.privateKey, deps.root);
			deps.out(`Installed on: ${Object.keys(installations).sort().join(", ")}`);
			return;
		}
		if (deps.now() >= deadline) {
			throw new Error(
				`The App ${credentials.config.slug} is saved but not installed yet. Install it at ${installUrl}, then run \`omp vm github status\`.`,
			);
		}
		await deps.sleep(INSTALL_POLL_MS);
	}
}

/** Adopts an existing App from its numeric id and private key file. */
async function adoptApp(appId: number, keyFile: string, deps: GithubSetupDeps): Promise<GithubAppCredentials> {
	const pem = await fs.readFile(keyFile, "utf8");
	const jwt = createAppJwt(String(appId), pem, deps.now());
	const app = await githubApi<{ id: number; slug: string; client_id: string; html_url: string }>(`${GITHUB_API}/app`, {
		fetch: deps.fetch,
		bearer: jwt,
	});
	if (app.id !== appId) throw new Error(`GitHub reports App id ${app.id}, not ${appId}`);
	return registerApp({ id: app.id, clientId: app.client_id, slug: app.slug, htmlUrl: app.html_url, pem }, deps);
}

export async function setupGithubApp(flags: GithubSetupFlags, deps: GithubSetupDeps): Promise<void> {
	if ((flags.appId === undefined) !== (flags.key === undefined)) {
		throw new Error("Adopting an existing App needs both --app-id and --key");
	}
	let credentials: GithubAppCredentials;
	if (flags.appId !== undefined && flags.key !== undefined) {
		credentials = await adoptApp(flags.appId, flags.key, deps);
		deps.out(`Adopted GitHub App ${credentials.config.slug}.`);
		const installations = await listInstallations(credentials, deps.fetch, deps.now());
		if (Object.keys(installations).length === 0) {
			await awaitInstallation(credentials, deps);
			return;
		}
		credentials.config.installations = installations;
		await saveGithubApp(credentials.config, credentials.privateKey, deps.root);
		deps.out(`Installed on: ${Object.keys(installations).sort().join(", ")}`);
		return;
	}
	credentials = await runManifestFlow(flags.owner, deps);
	deps.out(`Created GitHub App ${credentials.config.slug}.`);
	await awaitInstallation(credentials, deps);
}
