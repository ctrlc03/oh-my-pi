/**
 * The editor and explorer requests for scripts/mock-companion.ts, so the Explorer, the editor and its language-server
 * features can be tried in a browser: `tree`, `file`, `file-write`, `file-versions`, `git`, `git-diff`, `file-search`,
 * `lsp` and `lsp-diagnostics`. Every session shares one canned TypeScript project held in memory (edits made in the
 * app are kept until the mock stops, saves are version-checked like the real companion's).
 *
 * The language server is faked over that project: hover shows a declaration's signature in a code fence, definition
 * jumps to the declaration, references list every use (plus one in a dependency outside the repository, which the
 * editor lists but cannot open), and diagnostics flag `const x: number = "…"` as an error and `const unused…` as a
 * warning, wherever they occur in the (unsaved) text.
 */

import { createPatch, diffLines } from "diff";
import type { CompanionReply, CompanionRequest, FileContent, GitFileChange, GitSnapshot } from "../src/lib/companion";
import type { FileSearchMatch, LspDiagnostic, LspLocation, LspResult } from "../src/lib/repo-intel";

const DEFAULT_ROOT = "/work/mock";
/** A dependency's declaration file, to give references a location outside the repository. */
const DEPENDENCY_FILE = "/work/.cache/node_modules/@types/node/crypto.d.ts";

/** The canned project at HEAD. */
const HEAD: Record<string, string> = {
	"package.json": `{
  "name": "mock-service",
  "version": "1.4.0",
  "scripts": { "test": "bun test", "dev": "bun src/server.ts" }
}
`,
	"README.md": `# mock-service

A small HTTP service with cookie sessions.

## Run

\`\`\`sh
bun run dev
\`\`\`

Sessions last thirty minutes; see \`src/auth/session.ts\`.
`,
	"src/server.ts": `import { createSession, readSession } from "./auth/session";
import { formatDuration } from "./lib/format";

const PORT = 8080;

export async function handle(request: Request): Promise<Response> {
	const url = new URL(request.url);
	if (url.pathname === "/login") {
		const session = createSession("ada");
		return new Response("welcome", { headers: { "set-cookie": session.cookie } });
	}
	const session = readSession(request.headers.get("cookie"));
	if (session === null) return new Response("sign in first", { status: 401 });
	return new Response(\`hello \${session.user}, expires in \${formatDuration(session.expiresAt - Date.now())}\`);
}

Bun.serve({ port: PORT, fetch: handle });
`,
	"src/index.ts": `export { createSession, readSession } from "./auth/session";
export { signToken, verifyToken } from "./auth/token";
export { formatDuration } from "./lib/format";
`,
	"src/auth/session.ts": `import { signToken, verifyToken } from "./token";

export const DEFAULT_TTL: number = 30 * 60_000;

export interface Session {
	user: string;
	expiresAt: number;
	cookie: string;
}

/** Start a session for \`user\` that lasts \`ttl\` milliseconds. */
export function createSession(user: string, ttl: number = DEFAULT_TTL): Session {
	const expiresAt = Date.now() + ttl;
	const token = signToken({ user, expiresAt });
	return { user, expiresAt, cookie: \`sid=\${token}; HttpOnly; Max-Age=\${Math.floor(ttl / 1000)}\` };
}

/** The live session a \`cookie\` header carries, or null when it has none or it expired. */
export function readSession(cookie: string | null): Session | null {
	const token = cookie?.match(/sid=([^;]+)/)?.[1];
	if (token === undefined) return null;
	const claims = verifyToken(token);
	if (claims === null || claims.expiresAt < Date.now()) return null;
	return { user: claims.user, expiresAt: claims.expiresAt, cookie: \`sid=\${token}\` };
}
`,
	"src/auth/token.ts": `import { createHmac } from "node:crypto";

const SECRET = process.env.SESSION_SECRET ?? "dev-secret";

export interface Claims {
	user: string;
	expiresAt: number;
}

/** Encode \`claims\` and sign them. */
export function signToken(claims: Claims): string {
	const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
	const mac = createHmac("sha256", SECRET).update(body).digest("base64url");
	return \`\${body}.\${mac}\`;
}

/** The claims of a token we signed, or null when it was tampered with. */
export function verifyToken(token: string): Claims | null {
	const [body, mac] = token.split(".");
	if (body === undefined || mac === undefined) return null;
	const expected = createHmac("sha256", SECRET).update(body).digest("base64url");
	if (expected !== mac) return null;
	return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Claims;
}
`,
	"src/lib/format.ts": `/** A duration in milliseconds as \`4m 12s\`. */
export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	const minutes = Math.floor(seconds / 60);
	return minutes > 0 ? \`\${minutes}m \${seconds % 60}s\` : \`\${seconds}s\`;
}
`,
	"test/session.test.ts": `import { expect, test } from "bun:test";
import { createSession, readSession } from "../src/auth/session";

test("a fresh session reads back", () => {
	const session = createSession("ada");
	expect(readSession(session.cookie)?.user).toBe("ada");
});

test("an expired session is refused", () => {
	const session = createSession("ada", -1);
	expect(readSession(session.cookie)).toBeNull();
});
`,
	"docs/notes.md": `# Notes

- Tokens are HMAC-signed; rotate \`SESSION_SECRET\` to sign everyone out.
- TODO: refresh sessions that are about to expire.
`,
	"contracts/Vault.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Holds deposits until their owner takes them back.
contract Vault {
	error NothingToWithdraw(address owner);

	event Deposited(address indexed owner, uint256 amount);

	mapping(address => uint256) public balances;
	uint48 public immutable OPENED_AT;

	constructor() {
		OPENED_AT = uint48(block.timestamp);
	}

	function deposit() external payable {
		balances[msg.sender] += msg.value;
		emit Deposited(msg.sender, msg.value);
	}

	function withdraw() external {
		uint256 amount = balances[msg.sender];
		if (amount == 0) revert NothingToWithdraw(msg.sender);
		balances[msg.sender] = 0;
		(bool ok, ) = msg.sender.call{ value: amount }("");
		require(ok, "transfer failed");
	}
}
`,
};

/** Working-tree changes at the start: an edit to the session code and a file git has not seen. */
const WORKING_START: Record<string, string> = {
	"src/auth/session.ts": HEAD["src/auth/session.ts"]!.replace(
		"export const DEFAULT_TTL: number = 30 * 60_000;",
		'export const DEFAULT_TTL: number = "30m";\nconst unusedCount = 0;',
	),
	"src/lib/retry.ts": `/** Run \`work\`, retrying up to \`attempts\` times. */
export async function retry<T>(work: () => Promise<T>, attempts: number): Promise<T> {
	let last: unknown;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			return await work();
		} catch (err) {
			last = err;
		}
	}
	throw last;
}
`,
};

interface MockFile {
	text: string;
	version: number;
}

/** Fields the mock companion's `hosts` frame needs for the app to offer the editor, explorer search and language servers. */
export interface MockRepoIntelCapabilities {
	canEdit: true;
	canRepoSearch: true;
	canLsp: true;
}

export interface MockRepoIntel {
	capabilities: MockRepoIntelCapabilities;
	handles(request: CompanionRequest): boolean;
	/** @throws Error for a request the real companion would refuse. */
	answer(request: CompanionRequest): CompanionReply;
}

const HANDLED = new Set([
	"tree",
	"file",
	"file-write",
	"file-versions",
	"git",
	"git-diff",
	"file-search",
	"lsp",
	"lsp-diagnostics",
]);

/** A declaration the fake language server knows. */
interface Declaration {
	name: string;
	path: string;
	/** 1-based line and 0-based character of the name. */
	line: number;
	character: number;
	/** The declaration's first line, for hover. */
	signature: string;
	doc: string | null;
}

const DECLARATION = /^(export\s+)?(?:async\s+)?(function|class|interface|const|type)\s+([A-Za-z_$][\w$]*)/;

function wordAt(line: string, character: number): { word: string; start: number } | null {
	for (const found of line.matchAll(/[A-Za-z_$][\w$]*/g)) {
		const start = found.index;
		if (character >= start && character <= start + found[0].length) return { word: found[0], start };
	}
	return null;
}

function stamp(text: string): string {
	return `${Bun.hash(text).toString(36)}-${text.length}`;
}

/** `*`/`**`/`?` globs over repository-relative paths; one without a `/` matches a file name at any depth. */
function globMatcher(glob: string): (path: string) => boolean {
	const anywhere = !glob.includes("/");
	let source = "";
	for (let i = 0; i < glob.length; i++) {
		const char = glob[i]!;
		if (char === "*" && glob[i + 1] === "*") {
			source += ".*";
			i++;
			if (glob[i + 1] === "/") i++;
		} else if (char === "*") source += "[^/]*";
		else if (char === "?") source += "[^/]";
		else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	const pattern = new RegExp(anywhere ? `(^|/)${source}$` : `^${source}$`);
	return path => pattern.test(path);
}

/**
 * @param roots Working directory of a session by instance id; a session it does not know gets `/work/mock`.
 */
export function createMockRepoIntel(roots: (instanceId: string) => string | undefined): MockRepoIntel {
	const files = new Map<string, MockFile>();
	for (const [name, text] of Object.entries(HEAD)) files.set(name, { text: WORKING_START[name] ?? text, version: 1 });
	for (const [name, text] of Object.entries(WORKING_START))
		if (!files.has(name)) files.set(name, { text, version: 1 });

	const rootOf = (instanceId: string): string => roots(instanceId) ?? DEFAULT_ROOT;
	const versionOf = (file: MockFile): string => `${stamp(file.text)}-v${file.version}`;
	const names = (): string[] => [...files.keys()].sort();

	/** The file for a path as the editor sends it: repository-relative, or absolute under the session's root. */
	const lookup = (instanceId: string, input: string): { name: string; file: MockFile } => {
		const root = `${rootOf(instanceId)}/`;
		const name = input.startsWith(root) ? input.slice(root.length) : input.replace(/^\.\//, "");
		const file = files.get(name);
		if (!file) throw new Error("file not found");
		return { name, file };
	};

	const declarations = (): Declaration[] => {
		const found: Declaration[] = [];
		for (const [name, file] of files) {
			if (!/\.tsx?$/.test(name)) continue;
			const lines = file.text.split("\n");
			for (const [index, line] of lines.entries()) {
				const match = DECLARATION.exec(line);
				if (!match?.[3]) continue;
				const previous = lines[index - 1]?.trim() ?? "";
				const doc = previous.startsWith("/**") ? previous.replace(/^\/\*\*\s*|\s*\*\/$/g, "") : null;
				found.push({
					name: match[3],
					path: name,
					line: index + 1,
					character: line.indexOf(match[3], match[0].length - match[3].length),
					signature: line.replace(/\s*\{\s*$/, "").trim(),
					doc,
				});
			}
		}
		return found;
	};

	const textOf = (instanceId: string, input: string, text: string | undefined): { name: string; text: string } => {
		const { name, file } = lookup(instanceId, input);
		return { name, text: text ?? file.text };
	};

	const gitChanges = (): GitFileChange[] => {
		const changes: GitFileChange[] = [];
		for (const name of names()) {
			const now = files.get(name)!.text;
			const head = HEAD[name];
			if (head === undefined) {
				changes.push({ path: name, status: "??", added: now.split("\n").length - 1, removed: 0 });
				continue;
			}
			if (head === now) continue;
			let added = 0;
			let removed = 0;
			for (const part of diffLines(head, now)) {
				if (part.added) added += part.count ?? 0;
				else if (part.removed) removed += part.count ?? 0;
			}
			changes.push({ path: name, status: " M", added, removed });
		}
		return changes;
	};

	const search = (request: Extract<CompanionRequest, { t: "file-search" }>): CompanionReply => {
		const { query, regex, caseSensitive, wholeWord, glob } = request.search;
		if (typeof query !== "string" || query === "") throw new Error("Enter something to search for.");
		let pattern = regex === true ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		if (wholeWord === true) pattern = `\\b(?:${pattern})\\b`;
		let matcher: RegExp;
		try {
			matcher = new RegExp(pattern, caseSensitive === true ? "" : "i");
		} catch (err) {
			throw new Error(
				`Invalid regex: ${err instanceof Error ? err.message.replace(/^Invalid regular expression:\s*/i, "") : err}`,
			);
		}
		const inGlob = glob ? globMatcher(glob) : () => true;
		const matches: FileSearchMatch[] = [];
		const matched = new Set<string>();
		for (const name of names()) {
			if (!inGlob(name)) continue;
			for (const [index, line] of files.get(name)!.text.split("\n").entries()) {
				const found = matcher.exec(line);
				if (found === null) continue;
				matched.add(name);
				matches.push({ path: name, line: index + 1, character: found.index, text: line.slice(0, 300) });
			}
		}
		return { t: "file-search", reqId: request.reqId, result: { matches, files: matched.size, limited: false } };
	};

	const lsp = (request: Extract<CompanionRequest, { t: "lsp" }>): LspResult => {
		const { op, path: input, position, text } = request.query;
		const { name, text: source } = textOf(request.instanceId, input, text);
		if (!/\.tsx?$/.test(name)) {
			return {
				kind: "unavailable",
				reason: `no language server is configured or installed for ${name.split(".").pop() ? `.${name.split(".").pop()}` : name} files`,
			};
		}
		const line = source.split("\n")[position.line - 1] ?? "";
		const hit = wordAt(line, position.character);
		const all = declarations();
		const declared = hit ? all.find(item => item.name === hit.word) : undefined;
		if (op === "hover") {
			if (!hit || !declared) return { kind: "hover", server: "mock-ts", markdown: null };
			const markdown = `\`\`\`ts\n${declared.signature}\n\`\`\`${declared.doc ? `\n\n---\n\n${declared.doc}` : ""}`;
			return {
				kind: "hover",
				server: "mock-ts",
				markdown,
				range: {
					start: { line: position.line, character: hit.start },
					end: { line: position.line, character: hit.start + hit.word.length },
				},
			};
		}
		if (!hit || !declared) return { kind: "locations", server: "mock-ts", locations: [] };
		const length = declared.name.length;
		if (op === "definition") {
			return {
				kind: "locations",
				server: "mock-ts",
				locations: [
					{
						path: declared.path,
						inRepo: true,
						range: {
							start: { line: declared.line, character: declared.character },
							end: { line: declared.line, character: declared.character + length },
						},
						preview: declared.signature,
					},
				],
			};
		}
		const word = new RegExp(`\\b${declared.name.replace(/\$/g, "\\$")}\\b`, "g");
		const locations: LspLocation[] = [];
		for (const file of names()) {
			if (!/\.tsx?$/.test(file)) continue;
			for (const [index, source] of files.get(file)!.text.split("\n").entries()) {
				for (const found of source.matchAll(word)) {
					locations.push({
						path: file,
						inRepo: true,
						range: {
							start: { line: index + 1, character: found.index },
							end: { line: index + 1, character: found.index + length },
						},
						preview: source.trim().slice(0, 200),
					});
				}
			}
		}
		if (locations.length > 0) {
			locations.push({
				path: DEPENDENCY_FILE,
				inRepo: false,
				range: { start: { line: 14, character: 17 }, end: { line: 14, character: 17 + length } },
			});
		}
		return { kind: "locations", server: "mock-ts", locations };
	};

	const diagnostics = (request: Extract<CompanionRequest, { t: "lsp-diagnostics" }>): CompanionReply => {
		const { name, text } = textOf(request.instanceId, request.path, request.text);
		if (!/\.tsx?$/.test(name)) {
			return {
				t: "lsp-diagnostics",
				reqId: request.reqId,
				result: { kind: "unavailable", reason: "no language server is configured or installed for this file type" },
			};
		}
		const found: LspDiagnostic[] = [];
		for (const [index, line] of text.split("\n").entries()) {
			const wrong = /const\s+(\w+)\s*:\s*number\s*=\s*"[^"]*"/.exec(line);
			if (wrong) {
				const start = line.indexOf(wrong[1]!);
				found.push({
					range: {
						start: { line: index + 1, character: start },
						end: { line: index + 1, character: start + wrong[1]!.length },
					},
					severity: "error",
					message: "Type 'string' is not assignable to type 'number'.",
					source: "ts",
					code: "2322",
				});
			}
			const unused = /const\s+(unused\w*)\b/.exec(line);
			if (unused) {
				const start = line.indexOf(unused[1]!);
				found.push({
					range: {
						start: { line: index + 1, character: start },
						end: { line: index + 1, character: start + unused[1]!.length },
					},
					severity: "warning",
					message: `'${unused[1]}' is declared but its value is never read.`,
					source: "ts",
					code: "6133",
				});
			}
		}
		return {
			t: "lsp-diagnostics",
			reqId: request.reqId,
			result: { kind: "diagnostics", server: "mock-ts", diagnostics: found },
		};
	};

	return {
		capabilities: { canEdit: true, canRepoSearch: true, canLsp: true },
		handles: request => HANDLED.has(request.t),
		answer(request) {
			switch (request.t) {
				case "tree":
					return {
						t: "tree",
						reqId: request.reqId,
						tree: { root: rootOf(request.instanceId), files: names(), truncated: false },
					};
				case "file": {
					const { name, file } = lookup(request.instanceId, request.path);
					const content: FileContent = {
						path: name,
						size: file.text.length,
						text: file.text,
						truncated: false,
						version: versionOf(file),
						writable: true,
					};
					return { t: "file", reqId: request.reqId, file: content };
				}
				case "file-write": {
					const { file } = lookup(request.instanceId, request.path);
					// The real companion refuses a save over a file that changed since it was read.
					if (request.base !== versionOf(file))
						throw Object.assign(new Error("The file changed on disk."), { changed: versionOf(file) });
					file.text = request.text;
					file.version++;
					return { t: "file-saved", reqId: request.reqId, version: versionOf(file) };
				}
				case "file-versions":
					return {
						t: "file-versions",
						reqId: request.reqId,
						versions: request.paths.map(input => {
							try {
								return versionOf(lookup(request.instanceId, input).file);
							} catch {
								return null;
							}
						}),
					};
				case "git": {
					const git: GitSnapshot = {
						root: rootOf(request.instanceId),
						branch: "feat/sessions",
						upstream: "origin/main",
						ahead: 1,
						behind: 0,
						files: gitChanges(),
						commits: [
							{
								hash: "9f3c2d7a1b84e50c6d2f913a7b05e48c1d6a2f90",
								subject: "Sign session cookies",
								author: "Ada",
								time: Date.now() - 3_600_000,
							},
						],
					};
					return { t: "git", reqId: request.reqId, git };
				}
				case "git-diff": {
					const { name, file } = lookup(request.instanceId, request.path);
					return {
						t: "diff",
						reqId: request.reqId,
						diff: createPatch(name, HEAD[name] ?? "", file.text, "HEAD", "working tree"),
						truncated: false,
					};
				}
				case "file-search":
					return search(request);
				case "lsp":
					return { t: "lsp", reqId: request.reqId, result: lsp(request) };
				case "lsp-diagnostics":
					return diagnostics(request);
				default:
					throw new Error(`the mock companion does not answer ${request.t}`);
			}
		},
	};
}
