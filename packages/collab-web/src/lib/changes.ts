/**
 * "Files changed" for the session: every successful `edit` / `apply_patch` /
 * `write` call and every applied `ast_edit`, grouped by file, most recently
 * changed first. Built from the transcript alone, so it covers what the agent
 * changed through its own tools, not shell commands or edits made elsewhere.
 */

import type { SessionEntry, ToolResultMessage } from "@oh-my-pi/pi-wire";
import { diffStats } from "../tool-render/tools/edit";
import { executeXdevDispatch } from "../tool-render/ToolView";
import { inputPaths, isRecord, str } from "../tool-render/util";

/** One tool call as the transcript holds it; `ToolView` renders it as-is. */
export interface ChangeCall {
	id: string;
	name: string;
	args: unknown;
	intent?: string;
	result: ToolResultMessage;
}

export interface FileChange {
	path: string;
	added: number;
	removed: number;
	/** Oldest first: the order the edits were applied. */
	calls: ChangeCall[];
}

/** `[added, removed]` lines per path; zeros where the result does not say. */
type Touched = Map<string, [number, number]>;

const EDIT_TOOLS: Record<string, true> = { edit: true, apply_patch: true };
/** `xd://…`, `local://…`, `memory://…`: tool devices and harness storage, not project files. */
const URI_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function isFilePath(path: string | null): path is string {
	return path !== null && path.length > 0 && !URI_RE.test(path);
}

function editTouched(args: Record<string, unknown>, details: Record<string, unknown>): Touched {
	const files: Touched = new Map();
	const input = str(args.input) ?? str(args._input);
	const named = input ? inputPaths(input) : [];
	const argPath = str(args.file_path) ?? str(args.path);
	if (argPath) named.push(argPath);
	if (Array.isArray(args.edits)) {
		for (const e of args.edits) {
			const path = isRecord(e) ? str(e.path) : null;
			if (path) named.push(path);
		}
	}
	// Multi-file patches report per file; single-file edits at the top level.
	const reported = Array.isArray(details.perFileResults) ? details.perFileResults.filter(isRecord) : [details];
	reported.forEach((file, i) => {
		if (file.isError === true) return;
		const path = str(file.path) ?? named[i] ?? null;
		if (!isFilePath(path)) return;
		const diff = str(file.diff);
		const stats = diff ? diffStats(diff) : { added: 0, removed: 0 };
		files.set(path, [stats.added, stats.removed]);
	});
	if (files.size === 0) for (const path of named) if (isFilePath(path)) files.set(path, [0, 0]);
	return files;
}

function astEditTouched(details: Record<string, unknown>): Touched {
	const files: Touched = new Map();
	if (!Array.isArray(details.fileReplacements)) return files;
	for (const r of details.fileReplacements) {
		const path = isRecord(r) ? str(r.path) : null;
		if (isFilePath(path)) files.set(path, [0, 0]);
	}
	return files;
}

export function collectChanges(entries: readonly SessionEntry[]): FileChange[] {
	const results = new Map<string, ToolResultMessage>();
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "toolResult") {
			results.set(entry.message.toolCallId, entry.message);
		}
	}

	const byPath = new Map<string, FileChange & { last: number }>();
	let order = 0;
	const record = (call: ChangeCall, files: Touched): void => {
		order++;
		for (const [path, [added, removed]] of files) {
			const file = byPath.get(path) ?? { path, added: 0, removed: 0, calls: [], last: 0 };
			file.added += added;
			file.removed += removed;
			file.last = order;
			file.calls.push(call);
			byPath.set(path, file);
		}
	};
	/** `ast_edit` only stages a preview; it lands when a later `resolve` applies it. */
	let staged: { call: ChangeCall; files: Touched } | null = null;

	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const block of entry.message.content) {
			if (block.type !== "toolCall") continue;
			const result = results.get(block.id);
			if (!result || result.isError) continue;
			const call: ChangeCall = {
				id: block.id,
				name: block.name,
				args: block.arguments,
				intent: block.intent,
				result,
			};
			// Device tools arrive as `write xd://<tool>`; judge them by the tool they ran.
			const xdev = executeXdevDispatch(block.name, result);
			const name = xdev?.tool ?? block.name;
			const args = xdev?.args ?? (isRecord(block.arguments) ? block.arguments : {});
			const rawDetails = xdev ? xdev.inner : result.details;
			const details = isRecord(rawDetails) ? rawDetails : {};

			if (EDIT_TOOLS[name]) {
				record(call, editTouched(args, details));
			} else if (name === "write") {
				const path = str(args.file_path) ?? str(args.path);
				const content = str(args.content);
				if (isFilePath(path)) record(call, new Map([[path, [content ? content.split("\n").length : 0, 0]]]));
			} else if (name === "ast_edit") {
				staged = { call, files: astEditTouched(details) };
			} else if (name === "resolve" || name === "reject") {
				const action = str(details.action) ?? str(args.action) ?? (name === "reject" ? "discard" : "apply");
				if (staged && action === "apply") record(staged.call, staged.files);
				staged = null;
			}
		}
	}
	return [...byPath.values()].sort((a, b) => b.last - a.last).map(({ last: _, ...file }) => file);
}
