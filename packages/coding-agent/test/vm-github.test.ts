import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildProtectRulesets, type GhResult, type GhRunner } from "@oh-my-pi/pi-coding-agent/vm/github-protect";
import {
	type GithubAppConfig,
	InstallationTokens,
	loadGithubApp,
	runVmGithubCommand,
	saveGithubApp,
} from "@oh-my-pi/pi-coding-agent/vm/github";
import { githubAppConfigPath, githubAppKeyPath } from "@oh-my-pi/pi-coding-agent/vm/paths";

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: { type: "spki", format: "pem" },
	privateKeyEncoding: { type: "pkcs1", format: "pem" },
});

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const MINUTE = 60_000;

function config(installations: Record<string, number> = { acme: 7 }): GithubAppConfig {
	return {
		appId: 42,
		clientId: "Iv1.client",
		slug: "omp-vm-test",
		htmlUrl: "https://github.com/apps/omp-vm-test",
		bot: { name: "omp-vm-test[bot]", email: "99+omp-vm-test[bot]@users.noreply.github.com" },
		installations,
	};
}

interface Call {
	method: string;
	url: string;
	auth?: string;
	body?: unknown;
}

type Handler = (call: Call) => Response | undefined | Promise<Response | undefined>;

/** A fake `fetch`: records calls; each handler may answer or pass. */
function fakeFetch(...handlers: Handler[]): { fetch: typeof fetch; calls: Call[] } {
	const calls: Call[] = [];
	const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const headers = new Headers(init?.headers);
		const call: Call = {
			method: init?.method ?? "GET",
			url: String(input),
			auth: headers.get("authorization") ?? undefined,
			body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
		};
		calls.push(call);
		for (const handler of handlers) {
			const response = await handler(call);
			if (response) return response;
		}
		return new Response(JSON.stringify({ message: `unexpected ${call.method} ${call.url}` }), { status: 599 });
	};
	return { fetch: impl as typeof fetch, calls };
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function decodeJwt(jwt: string): { header: Record<string, unknown>; claims: Record<string, unknown>; ok: boolean } {
	const [header, claims, signature] = jwt.split(".");
	const ok = crypto
		.createVerify("RSA-SHA256")
		.update(`${header}.${claims}`)
		.verify(publicKey, Buffer.from(signature, "base64url"));
	return {
		header: JSON.parse(Buffer.from(header, "base64url").toString()),
		claims: JSON.parse(Buffer.from(claims, "base64url").toString()),
		ok,
	};
}

function mintHandler(options: { id?: number; ttlMs?: number; now?: () => number } = {}): {
	handler: Handler;
	minted: string[];
} {
	const minted: string[] = [];
	const id = options.id ?? 7;
	const handler: Handler = call => {
		if (call.method !== "POST" || !call.url.endsWith(`/app/installations/${id}/access_tokens`)) return undefined;
		const token = `ghs_token${minted.length + 1}`;
		minted.push(token);
		const expires = (options.now?.() ?? NOW) + (options.ttlMs ?? 60 * MINUTE);
		return json({ token, expires_at: new Date(expires).toISOString() }, 201);
	};
	return { handler, minted };
}

describe("installation tokens", () => {
	let clock: number;
	const now = () => clock;

	beforeEach(() => {
		clock = NOW;
	});

	function tokens(fetchFn: typeof fetch, extra: Partial<ConstructorParameters<typeof InstallationTokens>[0]> = {}) {
		return new InstallationTokens({
			load: async () => ({ config: config(), privateKey }),
			fetch: fetchFn,
			now,
			...extra,
		});
	}

	it("mints with a verifiable App JWT, the repos and the fixed permissions", async () => {
		const { handler } = mintHandler();
		const { fetch: fetchFn, calls } = fakeFetch(handler);
		const result = await tokens(fetchFn).get("vm-a", ["Acme/api", "acme/web"]);

		expect(result).toEqual({ token: "ghs_token1", expiresAt: NOW + 60 * MINUTE });
		expect(calls).toHaveLength(1);
		const [mint] = calls;
		expect(mint.url).toBe("https://api.github.com/app/installations/7/access_tokens");
		expect(mint.body).toEqual({
			repositories: ["api", "web"],
			permissions: { contents: "write", pull_requests: "write", checks: "read", actions: "read", metadata: "read" },
		});
		const jwt = decodeJwt(mint.auth?.replace("Bearer ", "") ?? "");
		expect(jwt.ok).toBe(true);
		expect(jwt.header).toEqual({ alg: "RS256", typ: "JWT" });
		expect(jwt.claims).toEqual({ iat: NOW / 1000 - 60, exp: NOW / 1000 + 9 * 60, iss: "Iv1.client" });
	});

	it("reuses a token until 10 minutes before expiry, then mints again", async () => {
		const { handler, minted } = mintHandler();
		const { fetch: fetchFn } = fakeFetch(handler);
		const source = tokens(fetchFn);
		const first = await source.get("vm-a", ["acme/api"]);
		clock = NOW + 49 * MINUTE;
		expect((await source.get("vm-a", ["acme/api"])).token).toBe(first.token);
		clock = NOW + 51 * MINUTE;
		expect((await source.get("vm-a", ["acme/api"])).token).toBe("ghs_token2");
		expect(minted).toHaveLength(2);
	});

	it("keeps separate tokens per key", async () => {
		const { handler, minted } = mintHandler();
		const { fetch: fetchFn } = fakeFetch(handler);
		const source = tokens(fetchFn);
		const a = await source.get("vm-a", ["acme/api"]);
		const b = await source.get("vm-b", ["acme/api"]);
		expect(a.token).not.toBe(b.token);
		expect(minted).toHaveLength(2);
	});

	it("shares one mint between concurrent gets of a key", async () => {
		const { handler, minted } = mintHandler();
		const gate = Promise.withResolvers<void>();
		const { fetch: fetchFn } = fakeFetch(async call => {
			await gate.promise;
			return handler(call);
		});
		const source = tokens(fetchFn);
		const pending = [1, 2, 3].map(() => source.get("vm-a", ["acme/api"]));
		gate.resolve();
		const results = await Promise.all(pending);
		expect(minted).toHaveLength(1);
		expect(new Set(results.map(r => r.token)).size).toBe(1);
	});

	it("refreshes and saves the installation list when the owner is unknown", async () => {
		const { handler } = mintHandler({ id: 31 });
		const { fetch: fetchFn, calls } = fakeFetch(call => {
			if (call.method === "GET" && call.url.startsWith("https://api.github.com/app/installations?")) {
				expect(decodeJwt(call.auth?.replace("Bearer ", "") ?? "").ok).toBe(true);
				return json([
					{ id: 31, account: { login: "Newco" } },
					{ id: 7, account: { login: "acme" } },
				]);
			}
			return handler(call);
		});
		const saved: GithubAppConfig[] = [];
		const source = tokens(fetchFn, {
			load: async () => ({ config: config({ acme: 7 }), privateKey }),
			save: async c => {
				saved.push(structuredClone(c));
			},
		});

		const result = await source.get("vm-n", ["NewCo/site"]);
		expect(result.token).toBe("ghs_token1");
		expect(saved).toHaveLength(1);
		expect(saved[0].installations).toEqual({ newco: 31, acme: 7 });
		expect(calls.map(c => c.method)).toEqual(["GET", "POST"]);
	});

	it("says so when the App is not installed on the owner", async () => {
		const { fetch: fetchFn } = fakeFetch(call =>
			call.url.includes("/app/installations?") ? json([{ id: 7, account: { login: "acme" } }]) : undefined,
		);
		await expect(tokens(fetchFn).get("vm-x", ["ghost/repo"])).rejects.toThrow(
			"GitHub App omp-vm-test is not installed on ghost; install it at https://github.com/apps/omp-vm-test/installations/new",
		);
	});

	it("rediscovers a stale installation id once on 404", async () => {
		const { handler } = mintHandler({ id: 8 });
		const { fetch: fetchFn } = fakeFetch(call => {
			if (call.url.endsWith("/app/installations/7/access_tokens")) return json({ message: "Not Found" }, 404);
			if (call.url.includes("/app/installations?")) return json([{ id: 8, account: { login: "acme" } }]);
			return handler(call);
		});
		const saved: GithubAppConfig[] = [];
		const source = tokens(fetchFn, { save: async c => void saved.push(structuredClone(c)) });
		expect((await source.get("vm-a", ["acme/api"])).token).toBe("ghs_token1");
		expect(saved[0].installations).toEqual({ acme: 8 });
	});

	it("explains a repository the installation cannot access", async () => {
		const { fetch: fetchFn } = fakeFetch(call =>
			call.url.endsWith("/access_tokens")
				? json(
						{
							message:
								"There is at least one repository that does not exist or is not accessible to the parent installation.",
						},
						422,
					)
				: undefined,
		);
		const failure = tokens(fetchFn).get("vm-a", ["acme/secret"]);
		await expect(failure).rejects.toThrow(
			/cannot access acme\/secret: There is at least one repository that does not exist/,
		);
		await expect(failure).rejects.toThrow(/selected for the App's installation on acme/);
	});

	it("rejects repositories under different owners, and a malformed name", async () => {
		const { fetch: fetchFn, calls } = fakeFetch();
		const source = tokens(fetchFn);
		await expect(source.get("vm-a", ["acme/api", "other/web"])).rejects.toThrow(
			/share one GitHub owner.*acme, other/,
		);
		await expect(source.get("vm-a", ["not-a-repo"])).rejects.toThrow("expected owner/repo");
		expect(calls).toHaveLength(0);
	});

	it("fails clearly when no App is configured", async () => {
		const { fetch: fetchFn } = fakeFetch();
		await expect(tokens(fetchFn, { load: async () => null }).get("vm-a", ["acme/api"])).rejects.toThrow(
			"omp vm github setup",
		);
	});

	it("revokes with the token as bearer and forgets it", async () => {
		const { handler, minted } = mintHandler();
		const { fetch: fetchFn, calls } = fakeFetch(handler, call =>
			call.method === "DELETE" ? new Response(null, { status: 204 }) : undefined,
		);
		const source = tokens(fetchFn);
		const first = await source.get("vm-a", ["acme/api"]);
		await source.revoke("vm-a");
		const del = calls.find(c => c.method === "DELETE");
		expect(del?.url).toBe("https://api.github.com/installation/token");
		expect(del?.auth).toBe(`Bearer ${first.token}`);
		expect((await source.get("vm-a", ["acme/api"])).token).not.toBe(first.token);
		expect(minted).toHaveLength(2);

		await source.revoke("never-minted");
		expect(calls.filter(c => c.method === "DELETE")).toHaveLength(1);
	});

	it("logs a failed revoke instead of throwing, and still forgets the token", async () => {
		const { handler, minted } = mintHandler();
		const { fetch: fetchFn } = fakeFetch(handler, call =>
			call.method === "DELETE" ? json({ message: "Bad credentials" }, 401) : undefined,
		);
		const logs: string[] = [];
		const source = tokens(fetchFn, { log: m => logs.push(m) });
		await source.get("vm-a", ["acme/api"]);
		await source.revoke("vm-a");
		expect(logs.join("\n")).toContain("Bad credentials");
		await source.get("vm-a", ["acme/api"]);
		expect(minted).toHaveLength(2);
	});

	it("revokeAll revokes every cached token", async () => {
		const { handler } = mintHandler();
		const { fetch: fetchFn, calls } = fakeFetch(handler, call =>
			call.method === "DELETE" ? new Response(null, { status: 204 }) : undefined,
		);
		const source = tokens(fetchFn);
		const a = await source.get("vm-a", ["acme/api"]);
		const b = await source.get("vm-b", ["acme/web"]);
		await source.revokeAll();
		const revoked = calls.filter(c => c.method === "DELETE").map(c => c.auth);
		expect(revoked.sort()).toEqual([`Bearer ${a.token}`, `Bearer ${b.token}`].sort());
	});
});

describe("GitHub App files", () => {
	let root: string;

	beforeEach(() => {
		root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omp-vm-github-")), "vm");
	});

	afterEach(() => {
		fs.rmSync(path.dirname(root), { recursive: true, force: true });
	});

	it("round-trips the config and key as owner-only files in a private directory", async () => {
		expect(await loadGithubApp(root)).toBeNull();
		await saveGithubApp(config(), privateKey, root);
		expect(fs.statSync(root).mode & 0o777).toBe(0o700);
		expect(fs.statSync(githubAppConfigPath(root)).mode & 0o777).toBe(0o600);
		expect(fs.statSync(githubAppKeyPath(root)).mode & 0o777).toBe(0o600);
		expect(fs.readdirSync(root).sort()).toEqual(["github-app.json", "github-app.pem"]);
		expect(await loadGithubApp(root)).toEqual({ config: config(), privateKey });
	});

	it("rejects a config file of the wrong shape", async () => {
		fs.mkdirSync(root, { recursive: true });
		fs.writeFileSync(githubAppConfigPath(root), JSON.stringify({ appId: "x" }));
		fs.writeFileSync(githubAppKeyPath(root), privateKey);
		await expect(loadGithubApp(root)).rejects.toThrow("not a GitHub App config");
	});
});

describe("omp vm github setup", () => {
	let root: string;
	let lines: string[];

	beforeEach(() => {
		root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omp-vm-github-")), "vm");
		lines = [];
	});

	afterEach(() => {
		fs.rmSync(path.dirname(root), { recursive: true, force: true });
	});

	const gh: GhRunner = async args =>
		args[0] === "api" && args[1] === "user"
			? { exitCode: 0, stdout: "tester\n", stderr: "" }
			: { exitCode: 1, stdout: "", stderr: "unexpected" };

	function githubHandlers(): Handler {
		return call => {
			if (call.method === "POST" && call.url === "https://api.github.com/app-manifests/the-code/conversions") {
				return json(
					{
						id: 42,
						slug: "omp-vm-tester",
						client_id: "Iv1.client",
						html_url: "https://github.com/apps/omp-vm-tester",
						pem: privateKey,
					},
					201,
				);
			}
			if (call.url === "https://api.github.com/users/omp-vm-tester%5Bbot%5D") return json({ id: 99 });
			if (call.url.includes("/app/installations?")) return json([{ id: 5, account: { login: "Tester" } }]);
			return undefined;
		};
	}

	it("creates the App from the manifest callback, rejecting a wrong state first", async () => {
		const { fetch: githubFetch, calls } = fakeFetch(githubHandlers());
		const opened: string[] = [];
		let drive: Promise<void> | undefined;
		const observed: { page?: string; wrong?: number; right?: number } = {};

		const openUrl = (url: string) => {
			opened.push(url);
			if (opened.length > 1) return;
			drive = (async () => {
				const page = await (await fetch(url)).text();
				observed.page = page;
				const state = /state=([0-9a-f]+)"/.exec(page)?.[1] ?? "";
				const manifest = JSON.parse(
					/name="manifest" value="([^"]*)"/
						.exec(page)?.[1]
						.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c))) ?? "{}",
				);
				observed.wrong = (await fetch(`${manifest.redirect_url}?code=the-code&state=nope`)).status;
				expect(calls.filter(c => c.url.includes("/conversions"))).toHaveLength(0);
				observed.right = (await fetch(`${manifest.redirect_url}?code=the-code&state=${state}`)).status;
			})();
		};

		await runVmGithubCommand(
			"setup",
			[],
			{},
			{
				fetch: githubFetch,
				now: () => NOW,
				sleep: async () => {},
				openUrl,
				runGh: gh,
				out: l => lines.push(l),
				root,
			},
		);
		await drive;

		expect(observed.wrong).toBe(400);
		expect(observed.right).toBe(200);
		expect(observed.page).toContain('action="https://github.com/settings/apps/new?state=');
		const manifest = JSON.parse(
			/name="manifest" value="([^"]*)"/
				.exec(observed.page ?? "")?.[1]
				.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c))) ?? "{}",
		);
		expect(manifest).toMatchObject({
			name: "omp-vm-tester",
			url: "https://github.com/ctrlc03/oh-my-pi",
			hook_attributes: { url: "https://example.invalid/", active: false },
			public: false,
			default_events: [],
			default_permissions: {
				contents: "write",
				pull_requests: "write",
				checks: "read",
				actions: "read",
				metadata: "read",
			},
		});
		expect(manifest.redirect_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

		expect(opened[1]).toBe("https://github.com/apps/omp-vm-tester/installations/new");
		const saved = await loadGithubApp(root);
		expect(saved?.config).toEqual({
			appId: 42,
			clientId: "Iv1.client",
			slug: "omp-vm-tester",
			htmlUrl: "https://github.com/apps/omp-vm-tester",
			bot: { name: "omp-vm-tester[bot]", email: "99+omp-vm-tester[bot]@users.noreply.github.com" },
			installations: { tester: 5 },
		});
		expect(saved?.privateKey).toBe(privateKey);
		expect(fs.statSync(githubAppKeyPath(root)).mode & 0o777).toBe(0o600);
		expect(lines.join("\n")).toContain("https://github.com/apps/omp-vm-tester/installations/new");
	});

	it("targets the organization's page with --owner", async () => {
		const { fetch: githubFetch } = fakeFetch(githubHandlers());
		let page = "";
		let drive: Promise<void> | undefined;
		const opened: string[] = [];
		const openUrl = (url: string) => {
			opened.push(url);
			if (opened.length > 1) return;
			drive = (async () => {
				page = await (await fetch(url)).text();
				const state = /state=([0-9a-f]+)"/.exec(page)?.[1] ?? "";
				const redirect = /redirect_url&#34;:&#34;([^&]*)&#34;/.exec(page)?.[1] ?? "";
				await fetch(`${redirect}?code=the-code&state=${state}`);
			})();
		};
		await runVmGithubCommand(
			"setup",
			[],
			{ owner: "my-org" },
			{
				fetch: githubFetch,
				now: () => NOW,
				sleep: async () => {},
				openUrl,
				runGh: gh,
				out: () => {},
				root,
			},
		);
		await drive;
		expect(page).toContain('action="https://github.com/organizations/my-org/settings/apps/new?state=');
	});

	it("polls for the installation until one appears", async () => {
		let polls = 0;
		const { fetch: githubFetch } = fakeFetch(call => {
			if (call.url.includes("/app/installations?")) {
				polls++;
				return json(polls < 3 ? [] : [{ id: 5, account: { login: "Tester" } }]);
			}
			return githubHandlers()(call);
		});
		const sleeps: number[] = [];
		let drive: Promise<void> | undefined;
		let count = 0;
		await runVmGithubCommand(
			"setup",
			[],
			{},
			{
				fetch: githubFetch,
				now: () => NOW,
				sleep: async ms => void sleeps.push(ms),
				openUrl: url => {
					if (count++ > 0) return;
					drive = (async () => {
						const page = await (await fetch(url)).text();
						const state = /state=([0-9a-f]+)"/.exec(page)?.[1] ?? "";
						const redirect = /redirect_url&#34;:&#34;([^&]*)&#34;/.exec(page)?.[1] ?? "";
						await fetch(`${redirect}?code=the-code&state=${state}`);
					})();
				},
				runGh: gh,
				out: () => {},
				root,
			},
		);
		await drive;
		expect(polls).toBe(3);
		expect(sleeps).toEqual([3000, 3000]);
		expect((await loadGithubApp(root))?.config.installations).toEqual({ tester: 5 });
	});

	it("adopts an existing App from its id and key file without a browser", async () => {
		const keyFile = path.join(path.dirname(root), "existing.pem");
		fs.writeFileSync(keyFile, privateKey);
		const { fetch: githubFetch, calls } = fakeFetch(call => {
			if (call.method === "GET" && call.url === "https://api.github.com/app") {
				return json({
					id: 42,
					slug: "omp-vm-tester",
					client_id: "Iv1.client",
					html_url: "https://github.com/apps/omp-vm-tester",
				});
			}
			if (call.url === "https://api.github.com/users/omp-vm-tester%5Bbot%5D") return json({ id: 99 });
			if (call.url.includes("/app/installations?")) return json([{ id: 5, account: { login: "Tester" } }]);
			return undefined;
		});
		const opened: string[] = [];
		await runVmGithubCommand(
			"setup",
			[],
			{ appId: 42, key: keyFile },
			{
				fetch: githubFetch,
				now: () => NOW,
				sleep: async () => {},
				openUrl: url => void opened.push(url),
				runGh: gh,
				out: l => lines.push(l),
				root,
			},
		);
		expect(opened).toEqual([]);
		const appCall = calls.find(c => c.url === "https://api.github.com/app");
		const jwt = decodeJwt(appCall?.auth?.replace("Bearer ", "") ?? "");
		expect(jwt.ok).toBe(true);
		expect(jwt.claims.iss).toBe("42");
		const saved = await loadGithubApp(root);
		expect(saved?.config.slug).toBe("omp-vm-tester");
		expect(saved?.config.installations).toEqual({ tester: 5 });
	});

	it("requires --app-id and --key together", async () => {
		await expect(
			runVmGithubCommand("setup", [], { appId: 42 }, { fetch: fakeFetch().fetch, root, out: () => {}, runGh: gh }),
		).rejects.toThrow("both --app-id and --key");
	});
});

describe("omp vm github status", () => {
	let root: string;

	beforeEach(() => {
		root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omp-vm-github-")), "vm");
	});

	afterEach(() => {
		fs.rmSync(path.dirname(root), { recursive: true, force: true });
	});

	it("reports not configured", async () => {
		const out: string[] = [];
		await runVmGithubCommand("status", [], { json: true }, { root, out: l => out.push(l) });
		expect(JSON.parse(out.join(""))).toEqual({ configured: false });
	});

	it("refreshes installations, saves them and prints the owners as JSON", async () => {
		await saveGithubApp(config({ stale: 1 }), privateKey, root);
		const { fetch: githubFetch } = fakeFetch(call =>
			call.url.includes("/app/installations?")
				? json([
						{ id: 7, account: { login: "Acme" } },
						{ id: 9, account: { login: "Beta" } },
					])
				: undefined,
		);
		const out: string[] = [];
		await runVmGithubCommand(
			"status",
			[],
			{ json: true },
			{ root, fetch: githubFetch, now: () => NOW, out: l => out.push(l) },
		);
		expect(JSON.parse(out.join(""))).toEqual({ configured: true, slug: "omp-vm-test", owners: ["acme", "beta"] });
		expect((await loadGithubApp(root))?.config.installations).toEqual({ acme: 7, beta: 9 });
	});

	it("falls back to the saved installations when GitHub is unreachable", async () => {
		await saveGithubApp(config({ acme: 7 }), privateKey, root);
		const { fetch: githubFetch } = fakeFetch(() => json({ message: "down" }, 503));
		const out: string[] = [];
		await runVmGithubCommand("status", [], {}, { root, fetch: githubFetch, now: () => NOW, out: l => out.push(l) });
		const text = out.join("\n");
		expect(text).toContain("omp-vm-test");
		expect(text).toContain("Installed on: acme");
		expect(text).toContain("Could not reach GitHub");
	});
});

describe("omp vm github protect", () => {
	interface GhCall {
		args: string[];
		input?: string;
	}

	function runner(existing: string[]): { runGh: GhRunner; calls: GhCall[] } {
		const calls: GhCall[] = [];
		const runGh: GhRunner = async (args, input): Promise<GhResult> => {
			calls.push({ args, input });
			if (args.includes("POST")) return { exitCode: 0, stdout: "{}", stderr: "" };
			return { exitCode: 0, stdout: JSON.stringify(existing.map(name => ({ name }))), stderr: "" };
		};
		return { runGh, calls };
	}

	const posted = (calls: GhCall[]) => calls.filter(c => c.args.includes("POST"));

	it("creates the branch and tag rulesets with an admin bypass", async () => {
		const { runGh, calls } = runner([]);
		const out: string[] = [];
		await runVmGithubCommand("protect", ["acme/api", "--yes"], {}, { runGh, out: l => out.push(l) });

		expect(calls[0].args).toEqual(["api", "repos/acme/api/rulesets?per_page=100"]);
		const creates = posted(calls);
		expect(creates.map(c => c.args)).toEqual([
			["api", "--method", "POST", "repos/acme/api/rulesets", "--input", "-"],
			["api", "--method", "POST", "repos/acme/api/rulesets", "--input", "-"],
		]);
		const [branch, tag] = creates.map(c => JSON.parse(c.input ?? "{}"));
		const bypass = [{ actor_type: "RepositoryRole", actor_id: 5, bypass_mode: "always" }];
		expect(branch).toMatchObject({
			target: "branch",
			enforcement: "active",
			conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
			rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "update" }],
			bypass_actors: bypass,
		});
		expect(tag).toMatchObject({
			target: "tag",
			enforcement: "active",
			conditions: { ref_name: { include: ["refs/tags/v*", "refs/tags/collab-v*"], exclude: [] } },
			rules: [{ type: "creation" }, { type: "update" }, { type: "deletion" }],
			bypass_actors: bypass,
		});
		const text = out.join("\n");
		expect(text).toContain("Will create on acme/api");
		expect(text).toContain("~DEFAULT_BRANCH");
		expect(text).toContain("refs/tags/collab-v*");
	});

	it("skips a ruleset whose name already exists", async () => {
		const [branchRuleset] = buildProtectRulesets();
		const { runGh, calls } = runner([branchRuleset.name]);
		const out: string[] = [];
		await runVmGithubCommand("protect", ["acme/api", "--yes"], {}, { runGh, out: l => out.push(l) });
		const creates = posted(calls);
		expect(creates).toHaveLength(1);
		expect(JSON.parse(creates[0].input ?? "{}").target).toBe("tag");
		expect(out.join("\n")).toContain(`Ruleset '${branchRuleset.name}' already exists on acme/api; skipping.`);
	});

	it("creates nothing when both already exist", async () => {
		const { runGh, calls } = runner(buildProtectRulesets().map(r => r.name));
		await runVmGithubCommand("protect", ["acme/api"], {}, { runGh, out: () => {}, isTTY: false });
		expect(posted(calls)).toHaveLength(0);
	});

	it("refuses to change anything without --yes when there is no terminal", async () => {
		const { runGh, calls } = runner([]);
		await expect(
			runVmGithubCommand("protect", ["acme/api"], {}, { runGh, out: () => {}, isTTY: false }),
		).rejects.toThrow("pass --yes");
		expect(posted(calls)).toHaveLength(0);
	});

	it("asks on a terminal and honours a refusal", async () => {
		const { runGh, calls } = runner([]);
		const questions: string[] = [];
		const out: string[] = [];
		await runVmGithubCommand(
			"protect",
			["acme/api"],
			{},
			{
				runGh,
				out: l => out.push(l),
				isTTY: true,
				confirm: async q => {
					questions.push(q);
					return false;
				},
			},
		);
		expect(questions).toHaveLength(1);
		expect(posted(calls)).toHaveLength(0);
		expect(out.join("\n")).toContain("Aborted");
	});

	it("reports gh failures and rejects a malformed repository", async () => {
		const failing: GhRunner = async () => ({ exitCode: 1, stdout: "", stderr: "HTTP 404: Not Found" });
		await expect(
			runVmGithubCommand("protect", ["acme/api", "--yes"], {}, { runGh: failing, out: () => {} }),
		).rejects.toThrow("HTTP 404: Not Found");
		await expect(
			runVmGithubCommand("protect", ["acme", "--yes"], {}, { runGh: failing, out: () => {} }),
		).rejects.toThrow("owner/repo");
		await expect(runVmGithubCommand("protect", [], {}, { runGh: failing, out: () => {} })).rejects.toThrow("Usage");
	});
});
