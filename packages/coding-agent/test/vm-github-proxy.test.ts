import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createGithubProxy,
	decideGraphql,
	decidePush,
	decideRest,
	parseReceivePackCommands,
} from "@oh-my-pi/pi-coding-agent/vm/github-proxy";
import type { VmRecord } from "@oh-my-pi/pi-coding-agent/vm/types";

const A = "a".repeat(40);
const B = "b".repeat(40);
const ZERO = "0".repeat(40);
const TOKEN = "ghs_host_only_token";

function pkt(text: string): string {
	return `${(text.length + 4).toString(16).padStart(4, "0")}${text}`;
}

function vm(overrides: Partial<VmRecord> = {}): VmRecord {
	return {
		version: 1,
		name: "api",
		repos: ["acme/api"],
		cpus: 2,
		memoryGiB: 4,
		diskGiB: 20,
		network: "open",
		driver: "lima",
		phase: "ready",
		createdAt: 0,
		...overrides,
	};
}

describe("push commands", () => {
	test("are read up to the first flush, with the client's capabilities", () => {
		const body = `${pkt(`${A} ${B} refs/heads/feature\0report-status side-band-64k\n`)}${pkt(`${ZERO} ${B} refs/heads/other\n`)}0000PACK...`;
		expect(parseReceivePackCommands(new TextEncoder().encode(body))).toEqual({
			updates: [
				{ oldOid: A, newOid: B, ref: "refs/heads/feature" },
				{ oldOid: ZERO, newOid: B, ref: "refs/heads/other" },
			],
			capabilities: ["report-status", "side-band-64k"],
		});
	});

	test("are not decided before the whole command section arrived", () => {
		const body = pkt(`${A} ${B} refs/heads/feature\0report-status\n`);
		expect(parseReceivePackCommands(new TextEncoder().encode(body))).toBeNull();
		expect(parseReceivePackCommands(new TextEncoder().encode(body.slice(0, 10)))).toBeNull();
	});

	test("signed pushes and malformed lines are refused", () => {
		expect(() =>
			parseReceivePackCommands(new TextEncoder().encode(`${pkt("push-cert\0report-status\n")}0000`)),
		).toThrow("signed pushes");
		expect(() => parseReceivePackCommands(new TextEncoder().encode(`${pkt("not a command\n")}0000`))).toThrow(
			"malformed",
		);
	});
});

describe("push policy", () => {
	const update = (ref: string, newOid = B) => ({ oldOid: A, newOid, ref });

	test("allows a feature branch", () => {
		expect(decidePush(update("refs/heads/feature"), "main", undefined)).toEqual({ allow: true });
	});

	test("refuses the default branch, deletions, tags and other refs", () => {
		expect(decidePush(update("refs/heads/main"), "main", undefined).allow).toBe(false);
		expect(decidePush(update("refs/heads/feature", ZERO), "main", undefined).allow).toBe(false);
		expect(decidePush(update("refs/tags/v1.0.0"), "main", undefined).allow).toBe(false);
		expect(decidePush(update("refs/notes/commits"), "main", undefined).allow).toBe(false);
	});

	test("a branch prefix limits pushes to branches under it", () => {
		expect(decidePush(update("refs/heads/omp/fix"), "main", "omp/")).toEqual({ allow: true });
		expect(decidePush(update("refs/heads/fix"), "main", "omp/").allow).toBe(false);
	});
});

describe("GraphQL policy", () => {
	test("allows queries, including the shorthand form", () => {
		expect(
			decideGraphql(
				'query PR($n: Int!) { repository(owner: "a", name: "b") { pullRequest(number: $n) { id } } }',
				undefined,
			),
		).toEqual({ allow: true, mutations: [] });
		expect(decideGraphql("{ viewer { login } }", undefined)).toEqual({ allow: true, mutations: [] });
	});

	test("allows pull request mutations and refuses merges, also under an alias", () => {
		expect(
			decideGraphql(
				'mutation { createPullRequest(input: {title: "mergePullRequest"}) { pullRequest { id } } }',
				undefined,
			),
		).toEqual({ allow: true, mutations: ["createPullRequest"] });
		expect(decideGraphql("mutation { mergePullRequest(input: {}) { clientMutationId } }", undefined).allow).toBe(
			false,
		);
		expect(decideGraphql("mutation { ok: mergePullRequest(input: {}) { clientMutationId } }", undefined).allow).toBe(
			false,
		);
		expect(
			decideGraphql(
				"mutation { addComment(input: {}) { clientMutationId } deleteRef(input: {}) { clientMutationId } }",
				undefined,
			).allow,
		).toBe(false);
	});

	test("refuses mutations it cannot read through: fragments and unknown operations", () => {
		expect(
			decideGraphql(
				"mutation { ...M } fragment M on Mutation { mergePullRequest(input: {}) { clientMutationId } }",
				undefined,
			).allow,
		).toBe(false);
		const document = "query Q { viewer { login } } mutation M { mergePullRequest(input: {}) { clientMutationId } }";
		expect(decideGraphql(document, "Q")).toEqual({ allow: true, mutations: [] });
		expect(decideGraphql(document, "M").allow).toBe(false);
		expect(decideGraphql(document, undefined).allow).toBe(false);
	});
});

describe("REST policy", () => {
	test("allows reads anywhere and pull request writes on the VM's repositories", () => {
		expect(decideRest("GET", "/repos/other/thing/contents/README.md", ["acme/api"])).toEqual({ allow: true });
		expect(decideRest("POST", "/repos/Acme/API/pulls", ["acme/api"])).toEqual({ allow: true });
		expect(decideRest("POST", "/repos/acme/api/issues/3/comments", ["acme/api"])).toEqual({ allow: true });
	});

	test("refuses merges, ref and content writes, and writes to other repositories", () => {
		expect(decideRest("PUT", "/repos/acme/api/pulls/3/merge", ["acme/api"]).allow).toBe(false);
		expect(decideRest("DELETE", "/repos/acme/api/git/refs/heads/main", ["acme/api"]).allow).toBe(false);
		expect(decideRest("PUT", "/repos/acme/api/contents/README.md", ["acme/api"]).allow).toBe(false);
		expect(decideRest("POST", "/repos/acme/api/actions/workflows/ci.yml/dispatches", ["acme/api"]).allow).toBe(false);
		expect(decideRest("POST", "/repos/other/thing/pulls", ["acme/api"]).allow).toBe(false);
	});
});

interface Upstream {
	url: string;
	method: string;
	headers: Headers;
	body: Uint8Array;
}

/** The proxy on a local port with GitHub faked: `answer` decides what GitHub replies to each forwarded request. */
function serveProxy(record: VmRecord, answer: (request: Upstream) => Response) {
	const upstream: Upstream[] = [];
	const logs: string[] = [];
	const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const request: Upstream = {
			url: String(input),
			method: init?.method ?? "GET",
			headers: new Headers(init?.headers),
			body: new Uint8Array(init?.body ? await new Response(init.body).arrayBuffer() : new ArrayBuffer(0)),
		};
		if (request.url === "https://api.github.com/repos/acme/api") return Response.json({ default_branch: "main" });
		upstream.push(request);
		return answer(request);
	}) as typeof fetch;
	const proxy = createGithubProxy({
		token: async () => TOKEN,
		log: (_vm, message) => logs.push(message),
		fetch: fakeFetch,
	});
	const server = Bun.serve({ port: 0, fetch: req => proxy.handle(req, record) });
	servers.push(server);
	return { url: `http://127.0.0.1:${server.port}`, upstream, logs };
}

const servers: Array<ReturnType<typeof Bun.serve>> = [];
const dirs: string[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A receive-pack ref advertisement with one unrelated branch, so the pushed refs are new to the remote. */
function advertisement(oid: string): Response {
	const body = `${pkt("# service=git-receive-pack\n")}0000${pkt(`${oid} refs/heads/elsewhere\0report-status side-band-64k delete-refs ofs-delta\n`)}0000`;
	return new Response(body, { headers: { "content-type": "application/x-git-receive-pack-advertisement" } });
}

/** A side-band receive-pack result accepting `refs`. */
function accepted(refs: string[]): Response {
	const status = `${pkt("unpack ok\n")}${refs.map(ref => pkt(`ok ${ref}\n`)).join("")}0000`;
	const band = `\x01${status}`;
	return new Response(`${pkt(band)}0000`, { headers: { "content-type": "application/x-git-receive-pack-result" } });
}

/** Runs git without blocking the event loop: the proxy it talks to serves from this process. */
async function git(cwd: string, ...args: string[]) {
	const child = Bun.spawn(["git", ...args], {
		cwd,
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code, stdout, stderr };
}

async function repoWithCommit(): Promise<string> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vm-git-"));
	dirs.push(dir);
	await git(dir, "init", "-q", "-b", "main");
	await git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one");
	return dir;
}

describe("the proxy with real git", () => {
	test("a push to the default branch is refused before GitHub sees it, and git reports why", async () => {
		const dir = await repoWithCommit();
		const { url, upstream } = serveProxy(vm(), request =>
			request.url.includes("info/refs") ? advertisement(A) : new Response("unexpected", { status: 500 }),
		);
		const result = await git(dir, "-c", `http.proxy=${url}`, "push", "http://github.com/acme/api.git", "main");
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("[remote rejected] main -> main (a VM cannot push to the default branch (main)");
		expect(result.stderr).toContain("remote: omp vm: push refused by the host");
		expect(upstream.map(request => request.url)).toEqual([
			"https://github.com/acme/api.git/info/refs?service=git-receive-pack",
		]);
	});

	test("a push to a branch reaches GitHub whole, with the host's token in place of the VM's", async () => {
		const dir = await repoWithCommit();
		const { url, upstream, logs } = serveProxy(vm(), request =>
			request.url.includes("info/refs") ? advertisement(A) : accepted(["refs/heads/feature"]),
		);
		const result = await git(
			dir,
			"-c",
			`http.proxy=${url}`,
			"-c",
			"http.extraHeader=Authorization: Basic dm06c3RvbGVu",
			"push",
			"http://github.com/acme/api.git",
			"main:feature",
		);
		expect(result.stderr).toContain("main -> feature");
		expect(result.code).toBe(0);
		const pushed = upstream.find(request => request.url.endsWith("/git-receive-pack"));
		expect(pushed?.headers.get("authorization")).toBe(`Basic ${btoa(`x-access-token:${TOKEN}`)}`);
		const body = new TextDecoder("latin1").decode(pushed?.body);
		expect(body).toContain(" refs/heads/feature\0");
		expect(body).toContain("PACK");
		expect(logs).toContain("github: push to acme/api allowed: refs/heads/feature");
	});

	test("pushes to repositories outside the VM never reach GitHub", async () => {
		const dir = await repoWithCommit();
		const { url, upstream } = serveProxy(vm(), () => advertisement(A));
		const result = await git(
			dir,
			"-c",
			`http.proxy=${url}`,
			"push",
			"http://github.com/acme/other.git",
			"main:feature",
		);
		expect(result.code).not.toBe(0);
		expect(upstream).toEqual([]);
	});
});

describe("the proxy for gh", () => {
	test("adds the token to allowed API calls and refuses a merge without forwarding it", async () => {
		const { url, upstream } = serveProxy(vm(), () => Response.json({ number: 1 }, { status: 201 }));
		const create = await fetch(`${url}/repos/acme/api/pulls`, {
			method: "POST",
			headers: { host: "api.github.com", authorization: "token omp-vm-host-adds-the-token" },
			body: JSON.stringify({ title: "t", head: "feature", base: "main" }),
		});
		expect(create.status).toBe(201);
		expect(upstream[0].url).toBe("https://api.github.com/repos/acme/api/pulls");
		expect(upstream[0].headers.get("authorization")).toBe(`Bearer ${TOKEN}`);

		const merge = await fetch(`${url}/repos/acme/api/pulls/1/merge`, {
			method: "PUT",
			headers: { host: "api.github.com" },
		});
		expect(merge.status).toBe(403);
		expect(await merge.json()).toEqual({ message: expect.stringContaining("not allowed from a VM") });
		expect(upstream).toHaveLength(1);
	});

	test("refuses a GraphQL merge with a GraphQL error", async () => {
		const { url, upstream } = serveProxy(vm(), () => Response.json({ data: {} }));
		const response = await fetch(`${url}/graphql`, {
			method: "POST",
			headers: { host: "api.github.com" },
			body: JSON.stringify({
				query: 'mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }',
			}),
		});
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			errors: [{ type: "FORBIDDEN", message: expect.stringContaining("mergePullRequest") }],
		});
		expect(upstream).toEqual([]);
	});
});
