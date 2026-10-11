/**
 * The mock host's answers to `turn-diff`, `session-diff` and `receipts`: a small catalog of per-turn
 * file changes (added, modified and deleted files, so each turn shows different edits) handed out by
 * the turn's position, and receipts read from the live entries the way the real host reads them.
 */
import type {
	HostFrame,
	ReceiptApproval,
	ReceiptCommand,
	ReceiptFile,
	SessionEntry,
	SessionReceipts,
	TurnDiffFile,
} from "@oh-my-pi/pi-wire";
import { isPrompt } from "../src/lib/trim";

function file(path: string, status: TurnDiffFile["status"], hunks: string[]): TurnDiffFile {
	const diff = `${hunks.join("\n")}\n`;
	let added = 0;
	let removed = 0;
	for (const line of hunks) {
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { path, status, added, removed, diff };
}

const RELAY = "packages/coding-agent/src/collab/relay-client.ts";

/** What each turn changed, by turn position (repeating once the catalog runs out). */
const CATALOG: readonly (readonly TurnDiffFile[])[] = [
	[
		file(RELAY, "modified", [
			'@@ -18,7 +18,9 @@ const RELAY_PATH = "/relay";',
			" const BACKOFF_BASE_MS = 1_000;",
			"-const BACKOFF_MAX_MS = 10_000;",
			"+const BACKOFF_MAX_MS = 30_000;",
			"+const BACKOFF_JITTER = 0.2;",
			" const MAX_PENDING_SENDS = 256;",
			" ",
			" export class RelayClient {",
			"@@ -161,6 +163,10 @@ export class RelayClient {",
			"\t\t#onClose(code: number): void {",
			"+\t\t\t// A redeploy closes with 1001: transient, so retry instead of giving up.",
			"+\t\t\tif (code === 1001) return this.#scheduleReconnect();",
			" \t\t\tif (FATAL.has(code)) return this.#fail(code);",
			" \t\t\tthis.#scheduleReconnect();",
			" \t\t}",
		]),
		file("packages/coding-agent/test/collab/relay-reconnect.test.ts", "added", [
			"@@ -0,0 +1,9 @@",
			'+import { describe, expect, it } from "bun:test";',
			'+import { backoffDelay } from "../../src/collab/relay-client";',
			"+",
			'+describe("relay reconnect", () => {',
			'+\tit("caps the backoff at 30s", () => {',
			"+\t\texpect(backoffDelay(12)).toBeLessThanOrEqual(30_000 * 1.2);",
			"+\t});",
			"+});",
		]),
	],
	[
		file("docs/collab.md", "modified", [
			"@@ -39,6 +39,7 @@ The guest reconnects on its own.",
			" ",
			" Reconnects back off from 1s to 30s.",
			"+The guest buffers up to 256 sealed frames meanwhile.",
			" ",
			" ## Ending a session",
		]),
		file("scripts/old-relay-probe.ts", "deleted", [
			"@@ -1,5 +0,0 @@",
			"-// Probe the relay once and exit.",
			'-const socket = new WebSocket(process.env.RELAY_URL ?? "");',
			"-socket.onopen = () => process.exit(0);",
			"-socket.onerror = () => process.exit(1);",
			"-setTimeout(() => process.exit(2), 5_000);",
		]),
	],
	[
		file(RELAY, "modified", [
			"@@ -88,7 +88,8 @@ export class RelayClient {",
			" \t\t#scheduleReconnect(): void {",
			"-\t\t\tconst delay = Math.min(BACKOFF_BASE_MS * 2 ** this.#attempt, BACKOFF_MAX_MS);",
			"+\t\t\tconst base = Math.min(BACKOFF_BASE_MS * 2 ** this.#attempt, BACKOFF_MAX_MS);",
			"+\t\t\tconst delay = base * (1 + Math.random() * BACKOFF_JITTER);",
			" \t\t\tthis.#attempt++;",
			" \t\t\tthis.#timer = setTimeout(() => this.#connect(), delay);",
			" \t\t}",
		]),
		file("packages/coding-agent/src/collab/protocol.ts", "modified", [
			"@@ -12,3 +12,4 @@ export const COLLAB_PROTO = 1;",
			" export const FATAL_CLOSE_CODES = new Set([4001, 4004, 4009, 4029]);",
			"+export const TRANSIENT_CLOSE_CODES = new Set([1001, 1006]);",
			" ",
		]),
	],
	[
		file("packages/coding-agent/src/collab/ping.ts", "added", [
			"@@ -0,0 +1,6 @@",
			"+/** Ping interval that detects half-open sockets after a NAT rebind. */",
			"+export const PING_INTERVAL_MS = 15_000;",
			"+",
			"+export function pongOverdue(lastPongAt: number, now: number): boolean {",
			"+\treturn now - lastPongAt > PING_INTERVAL_MS * 2;",
			"+}",
		]),
		file(RELAY, "modified", [
			"@@ -1,5 +1,6 @@",
			' import { COLLAB_PROTO } from "./protocol";',
			'+import { pongOverdue } from "./ping";',
			' import { CollabSocket } from "./socket";',
		]),
	],
];

function promptIds(entries: readonly SessionEntry[]): string[] {
	return entries.filter(isPrompt).map(entry => entry.id);
}

function turnFiles(index: number): readonly TurnDiffFile[] {
	return CATALOG[index % CATALOG.length]!;
}

/** The `turn-diff` frame for one prompt of `entries`. */
export function mockTurnDiff(entries: readonly SessionEntry[], entryId: string | undefined): HostFrame {
	const index = entryId === undefined ? -1 : promptIds(entries).indexOf(entryId);
	if (entryId === undefined || index < 0) {
		return {
			t: "turn-diff",
			scope: "turn",
			entryId: entryId ?? null,
			files: null,
			reason: "not a prompt on the active conversation",
		};
	}
	return { t: "turn-diff", scope: "turn", entryId, files: turnFiles(index).map(f => ({ ...f })), spansTurns: 1 };
}

/** The `turn-diff` frame for the whole session: every turn's files, each path once, as its last turn left it. */
export function mockSessionDiff(entries: readonly SessionEntry[]): HostFrame {
	const files = new Map<string, TurnDiffFile>();
	for (let i = 0; i < promptIds(entries).length; i++) for (const f of turnFiles(i)) files.set(f.path, { ...f });
	return {
		t: "turn-diff",
		scope: "session",
		entryId: null,
		files: [...files.values()],
		spansTurns: promptIds(entries).length,
	};
}

/** Approvals a mock session records: one granted by the host, one a guest denied. */
const MOCK_APPROVALS: readonly Omit<ReceiptApproval, "turn" | "promptId">[] = [
	{ tool: "bash", approved: true, by: "tui" },
	{ tool: "edit", approved: false, by: "guest", reason: "outside the project" },
];

/** Receipts read from `entries`: shell commands and edited files per turn, plus a fixed approval and subagent. */
export function mockReceipts(entries: readonly SessionEntry[]): HostFrame {
	const files: ReceiptFile[] = [];
	const commands: ReceiptCommand[] = [];
	const approvals: ReceiptApproval[] = [];
	let turn = 0;
	let promptId: string | null = null;
	const results = new Map<string, SessionEntry>();
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "toolResult") results.set(entry.message.toolCallId, entry);
	}
	for (const entry of entries) {
		if (isPrompt(entry)) {
			turn++;
			promptId = entry.id;
			if (turn <= MOCK_APPROVALS.length) approvals.push({ ...MOCK_APPROVALS[turn - 1]!, turn, promptId });
			continue;
		}
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const block of entry.message.content) {
			if (block.type !== "toolCall") continue;
			const args = block.arguments as Record<string, unknown>;
			if (block.name === "bash" && typeof args.command === "string") {
				const result = results.get(block.id);
				const reported =
					result?.type === "message" && result.message.role === "toolResult" ? result.message : undefined;
				const details = reported?.details as { exitCode?: unknown } | undefined;
				const exitCode =
					typeof details?.exitCode === "number"
						? details.exitCode
						: reported === undefined || reported.isError
							? null
							: 0;
				commands.push({ command: args.command, exitCode, source: "agent", turn, promptId });
			} else if (block.name === "edit" || block.name === "write") {
				const path =
					typeof args.path === "string" ? args.path : /^\[([^#\]]+)#/.exec(String(args.input ?? ""))?.[1];
				if (path !== undefined) files.push({ path, tool: block.name, turn, promptId });
			}
		}
	}
	const receipts: SessionReceipts = {
		turns: turn,
		files,
		commands,
		approvals,
		subagents:
			turn === 0
				? []
				: [
						{
							id: "mock-explore",
							agent: "explore",
							label: "Map the reconnect path",
							exitCode: 0,
							durationMs: 14_200,
							turn: 1,
							promptId: promptIds(entries)[0] ?? null,
						},
					],
	};
	return { t: "receipts", receipts };
}
