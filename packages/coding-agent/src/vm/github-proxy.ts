/**
 * The host side of a VM's GitHub access. The VM holds no GitHub credential: `git` reaches github.com as
 * `http://github.com/…` (a `url.insteadOf` rewrite) through the guest shim as its HTTP proxy, and `gh` sends its API
 * calls as plain HTTP over the host-services socket (`http_unix_socket`). Both arrive here with their GitHub host in
 * `Host`. This proxy checks each write against the VM's policy, adds the VM's installation token, and forwards to
 * GitHub over HTTPS; reads pass through.
 *
 * Policy, whatever rulesets the repository has:
 * - pushes only to branches of the VM's repositories, never to the default branch, never deleting a ref, never to
 *   tags or other refs, and only under the VM's branch prefix when it has one;
 * - API writes only from an allowlist (pull requests, reviews, comments, reactions), on the VM's repositories;
 * - GraphQL mutations only from an allowlist (no merges, no ref or commit writes);
 * - downloads (release assets, archives, attestation bundles) as anonymous GETs to a fixed set of hosts.
 */
import type { VmRecord } from "./types";

const GITHUB_WEB = "https://github.com";
const GITHUB_API = "https://api.github.com";
/** Most bytes read from a push before its ref updates must have been seen. */
const MAX_COMMAND_BYTES = 1024 * 1024;
/** Most bytes of a GraphQL request body. */
const MAX_GRAPHQL_BYTES = 1024 * 1024;
const DEFAULT_BRANCH_TTL_MS = 10 * 60 * 1000;
const ZERO_OID = /^0+$/;

/** Hosts `gh` may download from through the socket (GET and HEAD only, no credential added). */
export const GITHUB_DOWNLOAD_HOSTS: readonly string[] = [
	"codeload.github.com",
	"objects.githubusercontent.com",
	"release-assets.githubusercontent.com",
	"raw.githubusercontent.com",
	"tmaproduction.blob.core.windows.net",
	"tuf-repo.github.com",
	"tuf-repo-cdn.sigstore.dev",
];

/** GraphQL mutations a VM may run: pull requests, reviews, comments and reactions. */
export const ALLOWED_GRAPHQL_MUTATIONS: ReadonlySet<string> = new Set([
	"createPullRequest",
	"updatePullRequest",
	"closePullRequest",
	"reopenPullRequest",
	"markPullRequestReadyForReview",
	"convertPullRequestToDraft",
	"requestReviews",
	"addComment",
	"updateIssueComment",
	"addPullRequestReview",
	"submitPullRequestReview",
	"updatePullRequestReview",
	"deletePullRequestReview",
	"addPullRequestReviewComment",
	"addPullRequestReviewThread",
	"addPullRequestReviewThreadReply",
	"resolveReviewThread",
	"unresolveReviewThread",
	"addReaction",
	"removeReaction",
]);

/** REST writes a VM may make, on its own repositories (`:repo` is `owner/name`). */
const ALLOWED_REST_WRITES: ReadonlyArray<{ method: string; pattern: RegExp }> = [
	{ method: "POST", pattern: /^\/repos\/([^/]+\/[^/]+)\/pulls$/ },
	{ method: "PATCH", pattern: /^\/repos\/([^/]+\/[^/]+)\/pulls\/\d+$/ },
	{ method: "POST", pattern: /^\/repos\/([^/]+\/[^/]+)\/pulls\/\d+\/(reviews|comments|requested_reviewers)$/ },
	{ method: "PUT", pattern: /^\/repos\/([^/]+\/[^/]+)\/pulls\/\d+\/reviews\/\d+$/ },
	{ method: "POST", pattern: /^\/repos\/([^/]+\/[^/]+)\/pulls\/\d+\/reviews\/\d+\/events$/ },
	{ method: "POST", pattern: /^\/repos\/([^/]+\/[^/]+)\/pulls\/\d+\/comments\/\d+\/replies$/ },
	{ method: "POST", pattern: /^\/repos\/([^/]+\/[^/]+)\/issues\/\d+\/comments$/ },
	{ method: "PATCH", pattern: /^\/repos\/([^/]+\/[^/]+)\/(issues|pulls)\/comments\/\d+$/ },
	{ method: "POST", pattern: /^\/repos\/([^/]+\/[^/]+)\/(issues|pulls)\/comments\/\d+\/reactions$/ },
	{ method: "POST", pattern: /^\/repos\/([^/]+\/[^/]+)\/issues\/\d+\/reactions$/ },
];

export type Decision = { allow: true } | { allow: false; reason: string };

export interface RefUpdate {
	oldOid: string;
	newOid: string;
	ref: string;
}

/** The ref updates at the start of a `git-receive-pack` request, and the capabilities the client asked for. */
export interface ReceivePackCommands {
	updates: RefUpdate[];
	capabilities: string[];
}

/**
 * Reads the command section of a `git-receive-pack` request body: pkt-lines up to the first flush. Returns null
 * while `bytes` does not hold the whole section yet. Throws on anything that is not a plain push (push
 * certificates, malformed lines).
 */
export function parseReceivePackCommands(bytes: Uint8Array): ReceivePackCommands | null {
	const decoder = new TextDecoder();
	const updates: RefUpdate[] = [];
	let capabilities: string[] = [];
	let offset = 0;
	for (;;) {
		if (offset + 4 > bytes.length) return null;
		const length = Number.parseInt(decoder.decode(bytes.subarray(offset, offset + 4)), 16);
		if (!Number.isInteger(length) || (length !== 0 && length < 4)) throw new Error("malformed pkt-line");
		if (length === 0) return { updates, capabilities };
		if (offset + length > bytes.length) return null;
		let line = decoder.decode(bytes.subarray(offset + 4, offset + length));
		offset += length;
		if (line.endsWith("\n")) line = line.slice(0, -1);
		const nul = line.indexOf("\0");
		if (nul >= 0) {
			capabilities = line
				.slice(nul + 1)
				.split(" ")
				.filter(Boolean);
			line = line.slice(0, nul);
		}
		if (line.startsWith("shallow ")) continue;
		if (line.startsWith("push-cert")) throw new Error("signed pushes are not supported");
		const match = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) (\S+)$/.exec(line);
		if (!match) throw new Error("malformed ref update");
		updates.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
	}
}

/** Whether a VM may make this ref update. */
export function decidePush(update: RefUpdate, defaultBranch: string, branchPrefix: string | undefined): Decision {
	if (!update.ref.startsWith("refs/heads/")) {
		return { allow: false, reason: "only branches can be pushed from a VM (no tags or other refs)" };
	}
	const branch = update.ref.slice("refs/heads/".length);
	if (ZERO_OID.test(update.newOid)) return { allow: false, reason: "a VM cannot delete branches" };
	if (branch === defaultBranch) {
		return {
			allow: false,
			reason: `a VM cannot push to the default branch (${defaultBranch}); push a branch and open a pull request`,
		};
	}
	if (branchPrefix && !branch.startsWith(branchPrefix)) {
		return { allow: false, reason: `this VM pushes only branches starting with ${branchPrefix}` };
	}
	return { allow: true };
}

/** Writes `text` as one pkt-line. */
function pktLine(data: Uint8Array): Uint8Array {
	const out = new Uint8Array(data.length + 4);
	out.set(new TextEncoder().encode((data.length + 4).toString(16).padStart(4, "0")));
	out.set(data, 4);
	return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

const FLUSH = new TextEncoder().encode("0000");

/**
 * A `git-receive-pack` answer that rejects every update (a push is all or nothing here: its pack carries the objects
 * of every ref). git prints each `ng` reason as `! [remote rejected] … (reason)` and the message as `remote: …`.
 * Null when the client did not ask for `report-status`.
 */
export function receivePackRejection(
	commands: ReceivePackCommands,
	reasons: ReadonlyMap<string, string>,
	message: string,
): Uint8Array | null {
	const caps = new Set(commands.capabilities);
	if (!caps.has("report-status") && !caps.has("report-status-v2")) return null;
	const encoder = new TextEncoder();
	const status = concat([
		pktLine(encoder.encode("unpack ok\n")),
		...commands.updates.map(update =>
			pktLine(
				encoder.encode(
					`ng ${update.ref} ${reasons.get(update.ref) ?? "rejected with the other refs of this push"}\n`,
				),
			),
		),
		FLUSH,
	]);
	const sideBand = caps.has("side-band-64k") ? 65515 : caps.has("side-band") ? 995 : 0;
	if (sideBand === 0) return status;
	const parts: Uint8Array[] = [pktLine(concat([Uint8Array.of(2), encoder.encode(`${message}\n`)]))];
	for (let offset = 0; offset < status.length; offset += sideBand) {
		parts.push(pktLine(concat([Uint8Array.of(1), status.subarray(offset, offset + sideBand)])));
	}
	parts.push(FLUSH);
	return concat(parts);
}

type GraphqlToken = { kind: "name" | "punct"; value: string };

function tokenizeGraphql(source: string): GraphqlToken[] {
	const tokens: GraphqlToken[] = [];
	let i = 0;
	while (i < source.length) {
		const char = source[i];
		if (/[\s,\uFEFF]/.test(char)) {
			i++;
		} else if (char === "#") {
			while (i < source.length && source[i] !== "\n" && source[i] !== "\r") i++;
		} else if (source.startsWith('"""', i)) {
			const end = source.indexOf('"""', i + 3);
			if (end < 0) throw new Error("unterminated block string");
			i = end + 3;
		} else if (char === '"') {
			i++;
			while (i < source.length && source[i] !== '"') i += source[i] === "\\" ? 2 : 1;
			if (i >= source.length) throw new Error("unterminated string");
			i++;
		} else if (source.startsWith("...", i)) {
			tokens.push({ kind: "punct", value: "..." });
			i += 3;
		} else if (/[_A-Za-z]/.test(char)) {
			const start = i;
			while (i < source.length && /[_0-9A-Za-z]/.test(source[i])) i++;
			tokens.push({ kind: "name", value: source.slice(start, i) });
		} else if (/[-0-9]/.test(char)) {
			while (i < source.length && /[-+.0-9eE]/.test(source[i])) i++;
		} else {
			tokens.push({ kind: "punct", value: char });
			i++;
		}
	}
	return tokens;
}

interface GraphqlOperation {
	type: "query" | "mutation" | "subscription";
	name?: string;
	/** Top-level fields; `null` when the selection uses a fragment, which this reader does not resolve. */
	fields: string[] | null;
}

/** The operations of a GraphQL document with their top-level fields. Throws on a document it cannot read. */
export function graphqlOperations(source: string): GraphqlOperation[] {
	const tokens = tokenizeGraphql(source);
	const operations: GraphqlOperation[] = [];
	let i = 0;
	const skipBalanced = (open: string, close: string): void => {
		let depth = 0;
		do {
			const token = tokens[i++];
			if (!token) throw new Error("unbalanced GraphQL document");
			if (token.kind === "punct" && token.value === open) depth++;
			else if (token.kind === "punct" && token.value === close) depth--;
		} while (depth > 0);
	};
	const readSelection = (): string[] | null => {
		// tokens[i] is "{"
		i++;
		const fields: string[] = [];
		let fragment = false;
		for (;;) {
			const token = tokens[i];
			if (!token) throw new Error("unbalanced GraphQL document");
			if (token.kind === "punct" && token.value === "}") {
				i++;
				return fragment ? null : fields;
			}
			if (token.kind === "punct" && token.value === "...") {
				fragment = true;
				i++;
				// `... on Type` or `...Name`, then directives and an optional selection.
				while (tokens[i] && !(tokens[i].kind === "punct" && (tokens[i].value === "}" || tokens[i].value === "{"))) {
					if (tokens[i].kind === "punct" && tokens[i].value === "(") skipBalanced("(", ")");
					else i++;
				}
				if (tokens[i]?.value === "{") skipBalanced("{", "}");
				continue;
			}
			if (token.kind !== "name") throw new Error(`unexpected '${token.value}' in a selection`);
			i++;
			let field = token.value;
			if (tokens[i]?.kind === "punct" && tokens[i].value === ":") {
				i++;
				const real = tokens[i++];
				if (real?.kind !== "name") throw new Error("alias without a field");
				field = real.value;
			}
			fields.push(field);
			if (tokens[i]?.value === "(") skipBalanced("(", ")");
			while (tokens[i]?.value === "@") {
				i += 2;
				if (tokens[i]?.value === "(") skipBalanced("(", ")");
			}
			if (tokens[i]?.value === "{") skipBalanced("{", "}");
		}
	};
	while (i < tokens.length) {
		const token = tokens[i];
		if (token.kind === "punct" && token.value === "{") {
			operations.push({ type: "query", fields: readSelection() });
			continue;
		}
		if (token.kind === "name" && token.value === "fragment") {
			while (tokens[i] && tokens[i].value !== "{") i++;
			skipBalanced("{", "}");
			continue;
		}
		if (
			token.kind === "name" &&
			(token.value === "query" || token.value === "mutation" || token.value === "subscription")
		) {
			i++;
			let name: string | undefined;
			if (tokens[i]?.kind === "name") name = tokens[i++].value;
			if (tokens[i]?.value === "(") skipBalanced("(", ")");
			while (tokens[i]?.value === "@") {
				i += 2;
				if (tokens[i]?.value === "(") skipBalanced("(", ")");
			}
			if (tokens[i]?.value !== "{") throw new Error("operation without a selection");
			operations.push({ type: token.value, ...(name ? { name } : {}), fields: readSelection() });
			continue;
		}
		throw new Error(`unexpected '${token.value}' in a GraphQL document`);
	}
	return operations;
}

/** Whether a VM may run this GraphQL request; when allowed, the mutations it runs (none for a query). */
export function decideGraphql(
	query: string,
	operationName: string | undefined,
): { allow: true; mutations: string[] } | { allow: false; reason: string } {
	let operations: GraphqlOperation[];
	try {
		operations = graphqlOperations(query);
	} catch (err) {
		return {
			allow: false,
			reason: `unreadable GraphQL request: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	const operation = operationName
		? operations.find(candidate => candidate.name === operationName)
		: operations.length === 1
			? operations[0]
			: undefined;
	if (!operation) return { allow: false, reason: "GraphQL request names no single operation" };
	if (operation.type === "query") return { allow: true, mutations: [] };
	if (operation.type === "subscription") return { allow: false, reason: "GraphQL subscriptions are refused" };
	if (operation.fields === null) return { allow: false, reason: "GraphQL mutations with fragments are refused" };
	const refused = operation.fields.filter(field => !ALLOWED_GRAPHQL_MUTATIONS.has(field));
	if (refused.length > 0)
		return { allow: false, reason: `GraphQL mutation ${refused.join(", ")} is not allowed from a VM` };
	return { allow: true, mutations: operation.fields };
}

function sameRepo(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase();
}

/** Whether a VM may make this REST call. Reads always; writes from the allowlist, on its own repositories. */
export function decideRest(method: string, pathname: string, repos: readonly string[]): Decision {
	if (method === "GET" || method === "HEAD") return { allow: true };
	for (const rule of ALLOWED_REST_WRITES) {
		if (rule.method !== method) continue;
		const match = rule.pattern.exec(pathname);
		if (!match) continue;
		if (!repos.some(repo => sameRepo(repo, match[1]))) {
			return { allow: false, reason: `${match[1]} is not one of this VM's repositories` };
		}
		return { allow: true };
	}
	return { allow: false, reason: `${method} ${pathname} is not allowed from a VM` };
}

/** Where a git smart-HTTP request goes: `owner/repo`, the service and whether it is a ref advertisement. */
export function parseGitPath(
	pathname: string,
	search: string,
): {
	repo: string;
	service: "git-upload-pack" | "git-receive-pack";
	advertisement: boolean;
	upstreamPath: string;
} | null {
	const match =
		/^\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(
			pathname,
		);
	if (!match) return null;
	const [, owner, name, dotGit = "", endpoint] = match;
	if (endpoint === "info/refs") {
		const service = new URLSearchParams(search).get("service");
		if (service !== "git-upload-pack" && service !== "git-receive-pack") return null;
		return {
			repo: `${owner}/${name}`,
			service,
			advertisement: true,
			upstreamPath: `/${owner}/${name}${dotGit}/info/refs`,
		};
	}
	return {
		repo: `${owner}/${name}`,
		service: endpoint === "git-upload-pack" ? "git-upload-pack" : "git-receive-pack",
		advertisement: false,
		upstreamPath: `/${owner}/${name}${dotGit}/${endpoint}`,
	};
}

/** Whether a request on a VM's host socket is for GitHub rather than the model gateway. */
export function isGithubProxyRequest(req: Request): boolean {
	const host = requestHost(req);
	return host === "api.github.com" || host === "github.com" || GITHUB_DOWNLOAD_HOSTS.includes(host);
}

function requestHost(req: Request): string {
	const host = req.headers.get("host") ?? new URL(req.url).host;
	return host.replace(/:\d+$/, "").toLowerCase();
}

const DROPPED_REQUEST_HEADERS = new Set([
	"host",
	"authorization",
	"connection",
	"keep-alive",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"content-length",
	"cookie",
]);
const DROPPED_RESPONSE_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "set-cookie"]);

function forwardHeaders(req: Request, authorization: string | undefined): Headers {
	const headers = new Headers();
	req.headers.forEach((value, key) => {
		if (!DROPPED_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
	});
	if (authorization) headers.set("authorization", authorization);
	return headers;
}

function relay(upstream: Response): Response {
	const headers = new Headers();
	upstream.headers.forEach((value, key) => {
		if (!DROPPED_RESPONSE_HEADERS.has(key.toLowerCase())) headers.set(key, value);
	});
	return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}

function refuse(status: number, message: string): Response {
	return Response.json({ message: `omp vm: ${message}` }, { status });
}

/** What `readPrefix` hands back: the rest of a request body, after the bytes it already read. */
interface ChunkReader {
	read(): Promise<{ done: true; value?: Uint8Array } | { done: false; value: Uint8Array }>;
	cancel(reason?: unknown): Promise<void>;
}

/** Reads `stream` until `ready(bytes)` returns a value or `limit` bytes were read; returns it, the bytes and the rest. */
async function readPrefix<T>(
	stream: ReadableStream<Uint8Array>,
	ready: (bytes: Uint8Array) => T | null,
	limit: number,
): Promise<{ value: T | null; head: Uint8Array; rest: ChunkReader }> {
	const reader: ChunkReader = stream.getReader();
	let head: Uint8Array = new Uint8Array(0);
	for (;;) {
		const value = ready(head);
		if (value !== null || head.length >= limit) return { value, head, rest: reader };
		const chunk = await reader.read();
		if (chunk.done) return { value: ready(head), head, rest: reader };
		head = concat([head, chunk.value]);
	}
}

/** A stream of `head`, then whatever `rest` still yields. */
function prepend(head: Uint8Array, rest: ChunkReader): ReadableStream<Uint8Array> {
	let sentHead = false;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (!sentHead) {
				sentHead = true;
				if (head.length > 0) {
					controller.enqueue(head);
					return;
				}
			}
			const chunk = await rest.read();
			if (chunk.done) controller.close();
			else controller.enqueue(chunk.value);
		},
		cancel(reason) {
			return rest.cancel(reason);
		},
	});
}

export interface GithubProxyOptions {
	/** The VM's installation token, minted on the host; throws when there is no App or it is not installed. */
	token(vm: VmRecord): Promise<string>;
	/** One line per write decision and per refusal. */
	log(vm: string, message: string): void;
	fetch?: typeof fetch;
	now?: () => number;
}

export interface GithubProxy {
	handle(req: Request, vm: VmRecord): Promise<Response>;
}

export function createGithubProxy(opts: GithubProxyOptions): GithubProxy {
	const fetchFn = opts.fetch ?? fetch;
	const now = opts.now ?? Date.now;
	const defaultBranches = new Map<string, { branch: string; until: number }>();

	async function defaultBranch(repo: string, token: string): Promise<string> {
		const key = repo.toLowerCase();
		const cached = defaultBranches.get(key);
		if (cached && cached.until > now()) return cached.branch;
		const response = await fetchFn(`${GITHUB_API}/repos/${repo}`, {
			headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "omp-vm" },
		});
		if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${repo}`);
		const body: unknown = await response.json();
		const branch =
			typeof body === "object" &&
			body !== null &&
			"default_branch" in body &&
			typeof body.default_branch === "string"
				? body.default_branch
				: undefined;
		if (!branch) throw new Error(`GitHub did not name the default branch of ${repo}`);
		defaultBranches.set(key, { branch, until: now() + DEFAULT_BRANCH_TTL_MS });
		return branch;
	}

	async function tokenFor(vm: VmRecord): Promise<string | Response> {
		try {
			return await opts.token(vm);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			opts.log(vm.name, `github: no token: ${message}`);
			return refuse(502, `the host could not get a GitHub token for this VM: ${message}`);
		}
	}

	async function upstream(
		url: string,
		req: Request,
		authorization: string | undefined,
		body?: RequestInit["body"],
	): Promise<Response> {
		const hasBody = req.method !== "GET" && req.method !== "HEAD";
		return relay(
			await fetchFn(url, {
				method: req.method,
				headers: forwardHeaders(req, authorization),
				body: hasBody ? (body === undefined ? req.body : body) : undefined,
				redirect: "manual",
				decompress: false,
			}),
		);
	}

	async function git(req: Request, vm: VmRecord, pathname: string, search: string): Promise<Response> {
		const target = parseGitPath(pathname, search);
		if (!target) return refuse(404, `only git over HTTPS goes through the host (not ${pathname})`);
		const own = vm.repos.some(repo => sameRepo(repo, target.repo));
		const url = `${GITHUB_WEB}${target.upstreamPath}${search}`;
		if (target.service === "git-upload-pack") {
			// Fetches of other repositories go out without a credential: public ones work, private ones do not.
			if (!own) return upstream(url, req, undefined);
			const token = await tokenFor(vm);
			if (token instanceof Response) return token;
			return upstream(url, req, `Basic ${btoa(`x-access-token:${token}`)}`);
		}
		if (!own) {
			opts.log(vm.name, `github: push to ${target.repo} refused (not this VM's repository)`);
			return new Response(`omp vm: this VM pushes only to ${vm.repos.join(", ")}\n`, { status: 403 });
		}
		const token = await tokenFor(vm);
		if (token instanceof Response) return token;
		const authorization = `Basic ${btoa(`x-access-token:${token}`)}`;
		if (target.advertisement) return upstream(url, req, authorization);
		return push(req, vm, target.repo, url, token, authorization);
	}

	async function push(
		req: Request,
		vm: VmRecord,
		repo: string,
		url: string,
		token: string,
		authorization: string,
	): Promise<Response> {
		if (!req.body) return new Response("omp vm: empty push\n", { status: 400 });
		const gzip = (req.headers.get("content-encoding") ?? "").toLowerCase() === "gzip";
		const parse = (bytes: Uint8Array): ReceivePackCommands | null =>
			parseReceivePackCommands(gzip ? Bun.gunzipSync(Uint8Array.from(bytes)) : bytes);
		let read: Awaited<ReturnType<typeof readPrefix<ReceivePackCommands>>>;
		try {
			// A gzipped body is parsed whole (git gzips only small requests); a plain one up to its first flush.
			read = gzip
				? await readPrefix(req.body, () => null, Number.POSITIVE_INFINITY).then(result => ({
						...result,
						value: parse(result.head),
					}))
				: await readPrefix(req.body, parse, MAX_COMMAND_BYTES);
		} catch (err) {
			opts.log(vm.name, `github: push to ${repo} refused (${err instanceof Error ? err.message : String(err)})`);
			return new Response(`omp vm: ${err instanceof Error ? err.message : String(err)}\n`, { status: 400 });
		}
		const commands = read.value;
		if (!commands) {
			await read.rest.cancel();
			return new Response("omp vm: the push did not name its ref updates\n", { status: 400 });
		}
		let branch: string;
		try {
			branch = await defaultBranch(repo, token);
		} catch (err) {
			await read.rest.cancel();
			const message = err instanceof Error ? err.message : String(err);
			opts.log(vm.name, `github: push to ${repo} refused (default branch unknown: ${message})`);
			return new Response(`omp vm: cannot check the push: ${message}\n`, { status: 502 });
		}
		const reasons = new Map<string, string>();
		for (const update of commands.updates) {
			const decision = decidePush(update, branch, vm.branchPrefix);
			if (!decision.allow) reasons.set(update.ref, decision.reason);
		}
		const refs = commands.updates.map(update => update.ref).join(" ");
		if (reasons.size > 0) {
			await read.rest.cancel();
			const summary = [...reasons].map(([ref, reason]) => `${ref}: ${reason}`).join("; ");
			opts.log(vm.name, `github: push to ${repo} refused: ${summary}`);
			const answer = receivePackRejection(commands, reasons, `omp vm: push refused by the host: ${summary}`);
			if (!answer) return new Response(`omp vm: push refused: ${summary}\n`, { status: 403 });
			return new Response(answer, {
				status: 200,
				headers: { "content-type": "application/x-git-receive-pack-result", "cache-control": "no-cache" },
			});
		}
		opts.log(vm.name, `github: push to ${repo} allowed: ${refs}`);
		return upstream(url, req, authorization, prepend(read.head, read.rest));
	}

	async function api(req: Request, vm: VmRecord, url: URL): Promise<Response> {
		const pathname = url.pathname.replace(/^\/api\/v3(?=\/)/, "");
		const target = `${GITHUB_API}${pathname}${url.search}`;
		if (req.method === "POST" && pathname === "/graphql") {
			const text = await req.text();
			if (text.length > MAX_GRAPHQL_BYTES) return refuse(413, "GraphQL request too large");
			let body: unknown;
			try {
				body = JSON.parse(text);
			} catch {
				return refuse(400, "GraphQL request is not JSON");
			}
			const query = typeof body === "object" && body !== null && "query" in body ? body.query : undefined;
			const operationName =
				typeof body === "object" &&
				body !== null &&
				"operationName" in body &&
				typeof body.operationName === "string"
					? body.operationName
					: undefined;
			if (typeof query !== "string") return refuse(400, "GraphQL request without a query");
			const decision = decideGraphql(query, operationName);
			if (!decision.allow) {
				opts.log(vm.name, `github: graphql refused: ${decision.reason}`);
				return Response.json(
					{ errors: [{ type: "FORBIDDEN", message: `omp vm: ${decision.reason}` }] },
					{ status: 403 },
				);
			}
			if (decision.mutations.length > 0) {
				opts.log(vm.name, `github: graphql ${decision.mutations.join(", ")} allowed`);
			}
			const token = await tokenFor(vm);
			if (token instanceof Response) return token;
			return upstream(target, req, `Bearer ${token}`, text);
		}
		const decision = decideRest(req.method, pathname, vm.repos);
		if (!decision.allow) {
			opts.log(vm.name, `github: ${req.method} ${pathname} refused: ${decision.reason}`);
			return refuse(403, decision.reason);
		}
		if (req.method !== "GET" && req.method !== "HEAD") opts.log(vm.name, `github: ${req.method} ${pathname} allowed`);
		const token = await tokenFor(vm);
		if (token instanceof Response) return token;
		return upstream(target, req, `Bearer ${token}`);
	}

	return {
		async handle(req, vm) {
			const url = new URL(req.url);
			const host = requestHost(req);
			if (host === "github.com") return git(req, vm, url.pathname, url.search);
			if (host === "api.github.com") return api(req, vm, url);
			if (GITHUB_DOWNLOAD_HOSTS.includes(host)) {
				if (req.method !== "GET" && req.method !== "HEAD") return refuse(403, `${host} is download-only from a VM`);
				return upstream(`https://${host}${url.pathname}${url.search}`, req, undefined);
			}
			opts.log(vm.name, `github: ${host} refused (not a GitHub host)`);
			return refuse(404, `${host} is not reachable through the host`);
		},
	};
}
