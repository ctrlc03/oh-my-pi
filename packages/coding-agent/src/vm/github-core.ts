/**
 * GitHub App credentials for VM sessions: the on-disk config, the App JWT and the per-repository
 * installation tokens the host supervisor hands to guests (docs/vm-sessions.md). The guest never
 * holds the App key; it asks the supervisor for a short-lived installation token scoped to its repos.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import { isRecord } from "@oh-my-pi/pi-utils";
import { getVmRoot, githubAppConfigPath, githubAppKeyPath } from "./paths";

export const GITHUB_API = "https://api.github.com";

/** Permissions of every installation token and of the App created by `omp vm github setup`. */
export const GITHUB_APP_PERMISSIONS = {
	contents: "write",
	pull_requests: "write",
	checks: "read",
	actions: "read",
	metadata: "read",
} as const;

/** A token is re-minted when fewer than this many ms remain. */
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

export interface GithubAppConfig {
	appId: number;
	clientId: string;
	slug: string;
	htmlUrl: string;
	/** `${slug}[bot]` and `${botUserId}+${slug}[bot]@users.noreply.github.com`. */
	bot: { name: string; email: string };
	/** Owner login (lower-case) to installation id. */
	installations: Record<string, number>;
}

export interface GithubAppCredentials {
	config: GithubAppConfig;
	privateKey: string;
}

function parseConfig(raw: unknown): GithubAppConfig | undefined {
	if (!isRecord(raw)) return undefined;
	const { appId, clientId, slug, htmlUrl, bot, installations } = raw;
	if (typeof appId !== "number" || typeof clientId !== "string" || typeof slug !== "string") return undefined;
	if (typeof htmlUrl !== "string" || !isRecord(bot) || !isRecord(installations)) return undefined;
	if (typeof bot.name !== "string" || typeof bot.email !== "string") return undefined;
	const owners: Record<string, number> = {};
	for (const [owner, id] of Object.entries(installations)) {
		if (typeof id === "number") owners[owner.toLowerCase()] = id;
	}
	return { appId, clientId, slug, htmlUrl, bot: { name: bot.name, email: bot.email }, installations: owners };
}

async function readIfExists(file: string): Promise<string | undefined> {
	try {
		return await fs.readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** The configured GitHub App, or null when `omp vm github setup` has not run. */
export async function loadGithubApp(root = getVmRoot()): Promise<GithubAppCredentials | null> {
	const [rawConfig, privateKey] = await Promise.all([
		readIfExists(githubAppConfigPath(root)),
		readIfExists(githubAppKeyPath(root)),
	]);
	if (rawConfig === undefined || privateKey === undefined) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawConfig);
	} catch {
		throw new Error(`${githubAppConfigPath(root)} is not valid JSON`);
	}
	const config = parseConfig(parsed);
	if (!config) throw new Error(`${githubAppConfigPath(root)} is not a GitHub App config`);
	return { config, privateKey };
}

async function writeAtomic(file: string, content: string): Promise<void> {
	const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
	try {
		await fs.writeFile(tmp, content, { mode: 0o600 });
		await fs.chmod(tmp, 0o600);
		await fs.rename(tmp, file);
	} catch (error) {
		await fs.rm(tmp, { force: true });
		throw error;
	}
}

/** Writes the config and the key, both 0600 in a 0700 directory, each via rename. */
export async function saveGithubApp(config: GithubAppConfig, privateKey: string, root = getVmRoot()): Promise<void> {
	await fs.mkdir(root, { recursive: true, mode: 0o700 });
	await fs.chmod(root, 0o700);
	await writeAtomic(githubAppKeyPath(root), privateKey);
	await writeAtomic(githubAppConfigPath(root), `${JSON.stringify(config, null, "\t")}\n`);
}

function base64url(input: Buffer | string): string {
	return Buffer.from(input).toString("base64url");
}

/**
 * RS256 App JWT. `iat` is backdated 60 s against clock skew; `exp` stays inside GitHub's 10 minute cap.
 * `issuer` is the App's client id (GitHub also accepts the numeric App id).
 */
export function createAppJwt(issuer: string, privateKey: string, nowMs: number): string {
	const seconds = Math.floor(nowMs / 1000);
	const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const payload = base64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 9 * 60, iss: issuer }));
	const signature = crypto.createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey);
	return `${header}.${payload}.${base64url(signature)}`;
}

export class GithubApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "GithubApiError";
	}
}

export interface GithubApiRequest {
	fetch: typeof fetch;
	method?: string;
	/** Bearer credential: an App JWT or an installation token. */
	bearer?: string;
	body?: unknown;
}

/** One GitHub REST call; non-2xx throws a `GithubApiError` carrying GitHub's `message`. Returns undefined for 204. */
export async function githubApi<T>(url: string, request: GithubApiRequest): Promise<T> {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "omp-vm",
	};
	if (request.bearer) headers.Authorization = `Bearer ${request.bearer}`;
	if (request.body !== undefined) headers["Content-Type"] = "application/json";
	const response = await request.fetch(url, {
		method: request.method ?? "GET",
		headers,
		body: request.body === undefined ? undefined : JSON.stringify(request.body),
	});
	const text = await response.text();
	let json: unknown;
	if (text) {
		try {
			json = JSON.parse(text);
		} catch {
			json = undefined;
		}
	}
	if (!response.ok) {
		const message = isRecord(json) && typeof json.message === "string" ? json.message : text.slice(0, 200);
		throw new GithubApiError(response.status, message || response.statusText);
	}
	return json as T;
}

/** Lower-case owner login to installation id for every installation of the App. */
export async function listInstallations(
	credentials: GithubAppCredentials,
	fetchFn: typeof fetch,
	nowMs: number,
): Promise<Record<string, number>> {
	const jwt = createAppJwt(credentials.config.clientId, credentials.privateKey, nowMs);
	const installations: Record<string, number> = {};
	for (let page = 1; ; page++) {
		const batch = await githubApi<Array<{ id: number; account?: { login?: string } | null }>>(
			`${GITHUB_API}/app/installations?per_page=100&page=${page}`,
			{ fetch: fetchFn, bearer: jwt },
		);
		for (const entry of batch) {
			const login = entry.account?.login;
			if (login) installations[login.toLowerCase()] = entry.id;
		}
		if (batch.length < 100) return installations;
	}
}

function sameInstallations(a: Record<string, number>, b: Record<string, number>): boolean {
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key]);
}

interface CachedToken {
	token: string;
	expiresAt: number;
	signature: string;
}

export interface InstallationTokensOptions {
	load: () => Promise<GithubAppCredentials | null>;
	/** Persists a config whose `installations` were refreshed. */
	save?: (config: GithubAppConfig) => Promise<void>;
	fetch?: typeof fetch;
	now?: () => number;
	log?: (message: string) => void;
}

function splitRepos(repos: string[]): { owner: string; names: string[] } {
	if (repos.length === 0) throw new Error("A GitHub token needs at least one repository");
	const owners = new Set<string>();
	const names: string[] = [];
	for (const repo of repos) {
		const match = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)$/.exec(repo);
		if (!match) throw new Error(`Invalid repository '${repo}': expected owner/repo`);
		owners.add(match[1].toLowerCase());
		names.push(match[2]);
	}
	if (owners.size > 1) {
		throw new Error(`Repositories must share one GitHub owner, got: ${[...owners].sort().join(", ")}`);
	}
	return { owner: [...owners][0], names };
}

/** Installation tokens for one supervisor: cached per key, single-flight, re-minted 10 minutes before expiry. */
export class InstallationTokens {
	readonly #opts: InstallationTokensOptions;
	readonly #cache = new Map<string, CachedToken>();
	readonly #pending = new Map<string, Promise<{ token: string; expiresAt: number }>>();

	constructor(opts: InstallationTokensOptions) {
		this.#opts = opts;
	}

	#fetch(): typeof fetch {
		return this.#opts.fetch ?? globalThis.fetch;
	}

	#now(): number {
		return (this.#opts.now ?? Date.now)();
	}

	/** Token for these repos (all under one owner), cached per key, re-minted 10 min before expiry. */
	async get(key: string, repos: string[]): Promise<{ token: string; expiresAt: number }> {
		const { owner, names } = splitRepos(repos);
		const signature = `${owner}/${[...names].sort().join(",")}`;
		const cached = this.#cache.get(key);
		if (cached && cached.signature === signature && cached.expiresAt - REFRESH_MARGIN_MS > this.#now()) {
			return { token: cached.token, expiresAt: cached.expiresAt };
		}
		const inflight = this.#pending.get(key);
		if (inflight) return inflight;
		const minting = this.#mint(key, owner, names, signature).finally(() => this.#pending.delete(key));
		this.#pending.set(key, minting);
		return minting;
	}

	async #mint(
		key: string,
		owner: string,
		names: string[],
		signature: string,
	): Promise<{ token: string; expiresAt: number }> {
		const credentials = await this.#opts.load();
		if (!credentials) throw new Error("No GitHub App is configured; run `omp vm github setup`");
		const stale = this.#cache.get(key);
		if (stale) {
			this.#cache.delete(key);
			await this.#revokeToken(stale.token);
		}
		let refreshed = false;
		let installationId = credentials.config.installations[owner];
		for (;;) {
			if (installationId === undefined) {
				if (refreshed) throw this.#notInstalled(credentials.config, owner);
				await this.#refreshInstallations(credentials);
				refreshed = true;
				installationId = credentials.config.installations[owner];
				continue;
			}
			try {
				const jwt = createAppJwt(credentials.config.clientId, credentials.privateKey, this.#now());
				const minted = await githubApi<{ token: string; expires_at: string }>(
					`${GITHUB_API}/app/installations/${installationId}/access_tokens`,
					{
						fetch: this.#fetch(),
						method: "POST",
						bearer: jwt,
						body: { repositories: names, permissions: GITHUB_APP_PERMISSIONS },
					},
				);
				const expiresAt = Date.parse(minted.expires_at);
				if (!minted.token || Number.isNaN(expiresAt))
					throw new Error("GitHub returned an unusable installation token");
				this.#cache.set(key, { token: minted.token, expiresAt, signature });
				return { token: minted.token, expiresAt };
			} catch (error) {
				if (!(error instanceof GithubApiError)) throw error;
				if (error.status === 404) {
					// The installation id may be stale (App uninstalled and reinstalled): refresh once.
					if (refreshed) throw this.#notInstalled(credentials.config, owner);
					delete credentials.config.installations[owner];
					await this.#refreshInstallations(credentials);
					refreshed = true;
					installationId = credentials.config.installations[owner];
					continue;
				}
				if (error.status === 422) {
					throw new Error(
						`GitHub App ${credentials.config.slug} cannot access ${owner}/${names.join(", ")}: ${error.message}. ` +
							`Each repository must exist and be selected for the App's installation on ${owner} (${credentials.config.htmlUrl}/installations/new).`,
					);
				}
				if (error.status === 401) {
					throw new Error(`GitHub rejected the App credentials: ${error.message} (wrong key, or a skewed clock)`);
				}
				throw new Error(`GitHub token request failed (${error.status}): ${error.message}`);
			}
		}
	}

	#notInstalled(config: GithubAppConfig, owner: string): Error {
		return new Error(
			`GitHub App ${config.slug} is not installed on ${owner}; install it at ${config.htmlUrl}/installations/new`,
		);
	}

	async #refreshInstallations(credentials: GithubAppCredentials): Promise<void> {
		const fresh = await listInstallations(credentials, this.#fetch(), this.#now());
		if (sameInstallations(fresh, credentials.config.installations)) return;
		credentials.config.installations = fresh;
		await this.#opts.save?.(credentials.config);
	}

	async #revokeToken(token: string): Promise<void> {
		try {
			await githubApi<void>(`${GITHUB_API}/installation/token`, {
				fetch: this.#fetch(),
				method: "DELETE",
				bearer: token,
			});
		} catch (error) {
			this.#opts.log?.(`GitHub token revoke failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** Revokes and forgets the cached token for `key` (DELETE /installation/token). */
	async revoke(key: string): Promise<void> {
		const inflight = this.#pending.get(key);
		if (inflight) await inflight.catch(() => undefined);
		const cached = this.#cache.get(key);
		if (!cached) return;
		this.#cache.delete(key);
		await this.#revokeToken(cached.token);
	}

	async revokeAll(): Promise<void> {
		const keys = new Set([...this.#cache.keys(), ...this.#pending.keys()]);
		await Promise.all([...keys].map(key => this.revoke(key)));
	}
}
