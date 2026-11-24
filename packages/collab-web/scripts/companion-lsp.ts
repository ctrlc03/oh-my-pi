/**
 * Language-server answers for the companion's `lsp` and `lsp-diagnostics` requests: the editor's hover,
 * go-to-definition, find-references and diagnostics for a session's repository, served by omp's LSP client
 * (packages/coding-agent/src/lsp), the same one the agent's `lsp` tool drives.
 *
 * The client is a process-global module that spawns one server per (server, repository root). Servers are heavy
 * (a TypeScript or rust-analyzer server holds hundreds of MB), so this module bounds them: a repository's servers
 * stop {@link IDLE_MS} after its last request, and at most {@link MAX_ROOTS} repositories keep servers at once
 * (opening another stops the least recently used). The mapping from server answers to wire types is pure and lives
 * in companion-lsp-map.ts.
 */

import * as path from "node:path";
import type * as Client from "@oh-my-pi/pi-coding-agent/lsp/client";
import type { LspClient, ServerConfig } from "@oh-my-pi/pi-coding-agent/lsp/client";
import type * as Config from "@oh-my-pi/pi-coding-agent/lsp/config";
import type * as Diagnostics from "@oh-my-pi/pi-coding-agent/lsp/diagnostics";
import type * as Servers from "@oh-my-pi/pi-coding-agent/lsp/servers";
import type * as Utils from "@oh-my-pi/pi-coding-agent/lsp/utils";
import type { LspDiagnosticsResult, LspLocation, LspOp, LspQuery, LspResult } from "../src/lib/repo-intel";
import { FILE_BYTES, checkPathText, repoScope, resolveInScope } from "./companion-git";
import {
	MAX_LOCATIONS,
	type RawLocation,
	hoverMarkdown,
	previewOf,
	rawLocations,
	rawRange,
	toDiagnostics,
	toLocation,
	toServerPosition,
	toWireRange,
} from "./companion-lsp-map";

/** A repository's servers stop this long after its last request. */
export const IDLE_MS = 10 * 60_000;
/** Repositories that keep servers at once. */
export const MAX_ROOTS = 2;
/** Longest unsaved text accepted for a file. */
export const MAX_TEXT_BYTES = FILE_BYTES * 8;
const REQUEST_TIMEOUT_MS = 30_000;
const DIAGNOSTICS_WAIT_MS = 4000;
/** References answered with only the queried spot are asked again while the server finishes indexing. */
const REFERENCES_RETRIES = 2;
const REFERENCES_RETRY_MS = 250;
/** Files read for location previews, and the largest worth reading. */
const PREVIEW_FILES = 100;
const PREVIEW_FILE_BYTES = 2 * 1024 * 1024;
/** Documents remembered as already synced per repository. */
const MAX_SYNCED = 50;

const OPS: readonly LspOp[] = ["hover", "definition", "references"];
const SANDBOXED_REASON = "language servers don't run for sandboxed sessions";

interface LspModules {
	client: typeof Client;
	config: typeof Config;
	diagnostics: typeof Diagnostics;
	servers: typeof Servers;
	utils: typeof Utils;
}

let modules: LspModules | null = null;
let loading: Promise<boolean> | undefined;
let unavailable = "";

/**
 * Load the language-server client once; false when this checkout cannot (reason logged once, kept for the
 * answers requests get). Resolves immediately after the first call.
 */
export function loadLsp(): Promise<boolean> {
	// Dynamic on purpose: the client pulls in a large module graph and a checkout without it must leave the rest
	// of the companion working.
	loading ??= Promise.all([
		import("@oh-my-pi/pi-coding-agent/lsp/client"),
		import("@oh-my-pi/pi-coding-agent/lsp/config"),
		import("@oh-my-pi/pi-coding-agent/lsp/diagnostics"),
		import("@oh-my-pi/pi-coding-agent/lsp/servers"),
		import("@oh-my-pi/pi-coding-agent/lsp/utils"),
	]).then(
		([client, config, diagnostics, servers, utils]) => {
			modules = { client, config, diagnostics, servers, utils };
			return true;
		},
		(err: unknown) => {
			unavailable = err instanceof Error ? err.message : String(err);
			console.error(`companion: language servers unavailable: ${unavailable}`);
			return false;
		},
	);
	return loading;
}

/** One repository's running servers. */
interface RootEntry {
	root: string;
	clients: Set<LspClient>;
	/** Requests in flight; the idle timer waits for them. */
	busy: number;
	lastUsed: number;
	idle: ReturnType<typeof setTimeout> | undefined;
	/** Text last synced per file, so a repeat request for the same buffer does not resend it. */
	synced: Map<string, string>;
}

const roots = new Map<string, RootEntry>();

/** Stop a repository's servers and forget it. */
async function shutdownRoot(entry: RootEntry): Promise<void> {
	if (roots.get(entry.root) === entry) roots.delete(entry.root);
	clearTimeout(entry.idle);
	const mod = modules;
	const stopping = [...entry.clients];
	entry.clients.clear();
	entry.synced.clear();
	// A later request re-reads the configuration: a server installed meanwhile is picked up.
	mod?.config.configCache.delete(entry.root);
	if (mod === null) return;
	await Promise.allSettled(stopping.map(client => mod.client.shutdownClientInstance(client)));
}

/** Stop every repository's servers (the companion is exiting). */
export async function shutdownLsp(): Promise<void> {
	await Promise.allSettled([...roots.values()].map(entry => shutdownRoot(entry)));
}

function armIdle(entry: RootEntry): void {
	clearTimeout(entry.idle);
	entry.idle = setTimeout(() => {
		if (entry.busy > 0) armIdle(entry);
		else void shutdownRoot(entry);
	}, IDLE_MS);
	entry.idle.unref();
}

/** The entry for `root`, stopping the least recently used repositories when it would be one too many. */
async function acquire(root: string): Promise<RootEntry> {
	let entry = roots.get(root);
	if (!entry) {
		entry = { root, clients: new Set(), busy: 0, lastUsed: Date.now(), idle: undefined, synced: new Map() };
		roots.set(root, entry);
	}
	const mine = entry;
	mine.busy++;
	mine.lastUsed = Date.now();
	clearTimeout(mine.idle);
	if (roots.size > MAX_ROOTS) {
		const others = [...roots.values()].filter(other => other !== mine);
		// Quiet repositories first, oldest first.
		others.sort((a, b) => Number(a.busy > 0) - Number(b.busy > 0) || a.lastUsed - b.lastUsed);
		await Promise.all(others.slice(0, roots.size - MAX_ROOTS).map(other => shutdownRoot(other)));
	}
	return mine;
}

function release(entry: RootEntry): void {
	entry.busy--;
	entry.lastUsed = Date.now();
	if (roots.get(entry.root) === entry) armIdle(entry);
}

/** A file ready to be asked about. */
interface Target {
	client: LspClient;
	entry: RootEntry;
	serverName: string;
	serverConfig: ServerConfig;
	/** Repository root (symlink-resolved). */
	base: string;
	/** Symlink-resolved absolute path of the file. */
	abs: string;
	uri: string;
}

type Unavailable = { kind: "unavailable"; reason: string };

/** Hash-sized stand-in for a text, to tell whether a buffer changed. */
function stamp(text: string): string {
	return `${text.length}:${Bun.hash(text).toString(36)}`;
}

/** Bring the server's copy of `target` in line with the editor's text, or with the disk. Returns true when it changed. */
async function syncTarget(target: Target, text: string | undefined): Promise<boolean> {
	const { client, entry, abs, uri } = target;
	const mod = modules!;
	if (text === undefined) {
		// The server may hold an overlay of an older buffer: disk wins, and what we remember is stale.
		entry.synced.delete(abs);
		return await mod.client.reconcileFileFromDisk(client, abs);
	}
	const mark = stamp(text);
	if (entry.synced.get(abs) === mark && client.openFiles.has(uri)) return false;
	await mod.client.syncContent(client, abs, text);
	if (entry.synced.size >= MAX_SYNCED) entry.synced.clear();
	entry.synced.set(abs, mark);
	return true;
}

/**
 * Run `work` against the language server of `file`, or say why there is none.
 * @throws Error for an unusable path or file; `unavailable` covers everything about the servers themselves.
 */
async function withTarget<T>(
	cwd: string,
	sandboxed: boolean,
	file: string,
	work: (target: Target) => Promise<T>,
): Promise<T | Unavailable> {
	if (sandboxed) return { kind: "unavailable", reason: SANDBOXED_REASON };
	if (!(await loadLsp()) || modules === null) {
		return { kind: "unavailable", reason: `language servers are unavailable on this computer: ${unavailable}` };
	}
	const mod = modules;
	checkPathText(file);
	const scope = await repoScope(cwd);
	const abs = await resolveInScope(cwd, scope, file);
	if (abs === null) throw new Error("file not found");
	const found = await mod.servers.getLspServerForFileByPath(scope.base, abs);
	if (found === null) {
		const ext = path.extname(abs) || path.basename(abs);
		return { kind: "unavailable", reason: `no language server is configured or installed for ${ext} files` };
	}
	const [serverName, serverConfig] = found;
	const entry = await acquire(scope.base);
	try {
		let client: LspClient;
		try {
			client = await mod.client.getOrCreateClient(serverConfig, scope.base);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			console.error(`companion: ${serverName} failed to start: ${reason}`);
			return { kind: "unavailable", reason: `${serverName} failed to start: ${reason}` };
		}
		entry.clients.add(client);
		return await work({
			client,
			entry,
			serverName,
			serverConfig,
			base: scope.base,
			abs,
			uri: mod.utils.fileToUri(abs),
		});
	} finally {
		release(entry);
	}
}

/** Validate an `lsp` request body. @throws Error naming what is wrong. */
export function checkLspQuery(value: unknown): LspQuery {
	if (typeof value !== "object" || value === null) throw new Error("invalid language-server query");
	const query = value as Partial<LspQuery>;
	if (!isLspOp(query.op)) throw new Error("invalid language-server operation");
	const position = query.position;
	if (
		typeof query.path !== "string" ||
		typeof position !== "object" ||
		position === null ||
		!Number.isInteger(position.line) ||
		!Number.isInteger(position.character) ||
		position.line < 1 ||
		position.character < 0
	) {
		throw new Error("invalid language-server query");
	}
	checkPathText(query.path);
	checkText(query.text);
	return { op: query.op, path: query.path, position, text: query.text };
}

function isLspOp(op: unknown): op is LspOp {
	return OPS.some(known => known === op);
}

/** @throws Error when `text` is not a string within {@link MAX_TEXT_BYTES}. */
export function checkText(text: unknown): asserts text is string | undefined {
	if (text === undefined) return;
	// `length` is at most the byte count and at least a third of it: only measure the ones that could be over.
	if (typeof text !== "string" || (text.length * 3 > MAX_TEXT_BYTES && Buffer.byteLength(text) > MAX_TEXT_BYTES)) {
		throw new Error("the unsaved text is too large for language servers");
	}
}

/** The lines of a repository file for previews (null when unreadable or large). */
async function readLines(abs: string): Promise<string[] | null> {
	try {
		const file = Bun.file(abs);
		if (file.size > PREVIEW_FILE_BYTES) return null;
		return (await file.text()).split(/\r?\n/);
	} catch {
		return null;
	}
}

/**
 * Wire locations for a server's definition or references answer, with the first line of each in-repository
 * target. `overlay` is the editor's text of the queried file, which previews read instead of the disk.
 */
async function buildLocations(
	raws: RawLocation[],
	target: Target,
	overlay: string | undefined,
): Promise<LspLocation[]> {
	const toPath = modules!.utils.uriToFile;
	const mapped = raws.slice(0, MAX_LOCATIONS).map(raw => ({ raw, ...toLocation(raw, target.base, toPath) }));
	const cache = new Map<string, string[] | null>();
	if (overlay !== undefined) cache.set(target.abs, overlay.split(/\r?\n/));
	const wanted = [...new Set(mapped.filter(item => item.location.inRepo).map(item => item.abs))].filter(
		abs => !cache.has(abs),
	);
	await Promise.all(
		wanted.slice(0, PREVIEW_FILES).map(async abs => {
			cache.set(abs, await readLines(abs));
		}),
	);
	return mapped.map(({ raw, location, abs }) => {
		if (!location.inRepo) return location;
		const preview = previewOf(cache.get(abs)?.[raw.range.start.line]);
		return preview === undefined ? location : { ...location, preview };
	});
}

/** True when `locations` is just the spot that was asked about (a server still indexing says no more). */
function onlyQueried(locations: RawLocation[], uri: string, line: number, character: number): boolean {
	if (locations.length === 0) return true;
	if (locations.length !== 1 || locations[0]!.uri !== uri) return false;
	const { start, end } = locations[0]!.range;
	const afterStart = line > start.line || (line === start.line && character >= start.character);
	const beforeEnd = line < end.line || (line === end.line && character <= end.character);
	return afterStart && beforeEnd;
}

/**
 * Answer a hover, definition or references query for a session's file.
 * @param cwd The session's working directory.
 * @param sandboxed A sandboxed session gets no language servers.
 */
export async function lspQuery(cwd: string, sandboxed: boolean, query: LspQuery): Promise<LspResult> {
	return await withTarget(cwd, sandboxed, query.path, async (target): Promise<LspResult> => {
		const { client, serverName, serverConfig, uri } = target;
		const mod = modules!;
		await syncTarget(target, query.text);
		const position = toServerPosition(query.position);
		const params = { textDocument: { uri }, position };
		const request = (method: string, extra?: object) =>
			mod.client.sendRequest(client, method, { ...params, ...extra }, undefined, REQUEST_TIMEOUT_MS);

		if (query.op === "hover") {
			const answer: unknown = await request("textDocument/hover");
			const hover = typeof answer === "object" && answer !== null ? answer : {};
			const markdown = "contents" in hover && hover.contents !== undefined ? hoverMarkdown(hover.contents) : null;
			const range = rawRange("range" in hover ? hover.range : undefined);
			return { kind: "hover", server: serverName, markdown, ...(range ? { range: toWireRange(range) } : {}) };
		}

		// Answers that span files come from every open document: bring the others in line with disk, but keep the
		// queried buffer's text.
		if (mod.servers.isProjectAwareLspServer(serverConfig)) {
			await mod.client.waitForProjectLoaded(client, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
		}
		await mod.client.reconcileOpenFilesFromDisk(client, undefined, uri, "close");
		for (const key of target.entry.synced.keys()) if (key !== target.abs) target.entry.synced.delete(key);

		let raws: RawLocation[] = [];
		const retries =
			query.op === "references" && mod.servers.isProjectAwareLspServer(serverConfig) ? REFERENCES_RETRIES : 0;
		for (let attempt = 0; attempt <= retries; attempt++) {
			raws = rawLocations(
				query.op === "definition"
					? await request("textDocument/definition")
					: await request("textDocument/references", { context: { includeDeclaration: true } }),
			);
			if (!onlyQueried(raws, uri, position.line, position.character) || attempt === retries) break;
			await mod.client.waitForProjectLoaded(client, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
			await Bun.sleep(REFERENCES_RETRY_MS);
		}
		return { kind: "locations", server: serverName, locations: await buildLocations(raws, target, query.text) };
	});
}

/**
 * Diagnostics for a session's file after syncing the editor's text (or the disk's when `text` is absent).
 * `diagnostics: null` means the server sent no fresh report in time.
 */
export async function lspDiagnostics(
	cwd: string,
	sandboxed: boolean,
	file: unknown,
	text: unknown,
): Promise<LspDiagnosticsResult> {
	if (typeof file !== "string") throw new Error("invalid path");
	checkText(text);
	return await withTarget(cwd, sandboxed, file, async (target): Promise<LspDiagnosticsResult> => {
		await syncTarget(target, text);
		const raw = await modules!.diagnostics.waitForDiagnostics(target.client, target.uri, {
			timeoutMs: DIAGNOSTICS_WAIT_MS,
		});
		return {
			kind: "diagnostics",
			server: target.serverName,
			diagnostics: raw === undefined ? null : toDiagnostics(raw),
		};
	});
}

/** Roots with live servers, for tests and diagnostics. */
export function liveRoots(): string[] {
	return [...roots.keys()];
}
