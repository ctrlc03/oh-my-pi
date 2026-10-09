import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { collectChanges } from "../src/lib/changes";

interface Call {
	id: string;
	name: string;
	args: Record<string, unknown>;
	details?: unknown;
	isError?: boolean;
}

let seq = 0;

/** One assistant turn calling `calls`, followed by each call's result. */
function turn(...calls: Call[]): SessionEntry[] {
	const at = "2026-07-09T00:00:00Z";
	const assistant: SessionEntry = {
		type: "message",
		id: `a${++seq}`,
		parentId: null,
		timestamp: at,
		message: {
			role: "assistant",
			content: calls.map(c => ({ type: "toolCall" as const, id: c.id, name: c.name, arguments: c.args })),
			model: "test/model",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
			stopReason: "toolUse",
			timestamp: 1,
		},
	};
	const results: SessionEntry[] = calls.map(c => ({
		type: "message",
		id: `r${++seq}`,
		parentId: null,
		timestamp: at,
		message: {
			role: "toolResult",
			toolCallId: c.id,
			toolName: c.name,
			content: [{ type: "text", text: "ok" }],
			details: c.details,
			isError: c.isError ?? false,
			timestamp: 1,
		},
	}));
	return [assistant, ...results];
}

const summary = (entries: SessionEntry[]) =>
	collectChanges(entries).map(f => ({
		path: f.path,
		added: f.added,
		removed: f.removed,
		calls: f.calls.map(c => c.id),
	}));

describe("collectChanges", () => {
	it("groups edits by file, sums diff stats, and lists the most recently changed file first", () => {
		const entries = [
			...turn({
				id: "e1",
				name: "edit",
				args: { input: "[src/a.ts#1A2B]\nPUT 1.=1:\n+x" },
				details: { diff: "-old\n+new\n+more" },
			}),
			...turn({ id: "w1", name: "write", args: { path: "src/b.ts", content: "one\ntwo" } }),
			...turn({
				id: "e2",
				name: "edit",
				args: { input: "[src/a.ts#3C4D]\nCUT 2.=2" },
				details: { diff: "-gone" },
			}),
		];
		expect(summary(entries)).toEqual([
			{ path: "src/a.ts", added: 2, removed: 2, calls: ["e1", "e2"] },
			{ path: "src/b.ts", added: 2, removed: 0, calls: ["w1"] },
		]);
	});

	it("attributes multi-file patches per file and skips failed calls and failed files", () => {
		const entries = [
			...turn({
				id: "p1",
				name: "apply_patch",
				args: { input: "*** Update File: x.ts\n*** Update File: y.ts\n*** Update File: z.ts" },
				details: {
					perFileResults: [
						{ path: "x.ts", diff: "+1" },
						{ path: "y.ts", isError: true, diff: "+2" },
						{ diff: "-3" },
					],
				},
			}),
			...turn({ id: "bad", name: "edit", args: { path: "w.ts" }, isError: true }),
		];
		expect(summary(entries)).toEqual([
			{ path: "x.ts", added: 1, removed: 0, calls: ["p1"] },
			{ path: "z.ts", added: 0, removed: 1, calls: ["p1"] },
		]);
	});

	it("counts a staged ast_edit only once a resolve applies it, and never device or harness paths", () => {
		const astEdit = (id: string, path: string): Call => ({
			id,
			name: "write",
			args: { path: "xd://ast_edit", content: "{}" },
			details: { xdev: { mode: "execute", tool: "ast_edit", args: {}, inner: { fileReplacements: [{ path }] } } },
		});
		const resolve = (id: string, action: string): Call => ({
			id,
			name: "write",
			args: { path: `xd://${action === "apply" ? "resolve" : "reject"}`, content: "why" },
			details: { xdev: { mode: "execute", tool: "resolve", args: {}, inner: { action } } },
		});
		const entries = [
			...turn(astEdit("s1", "kept.ts")),
			...turn(resolve("ok", "apply")),
			...turn(astEdit("s2", "dropped.ts")),
			...turn(resolve("no", "discard")),
			...turn({ id: "m", name: "write", args: { path: "local://notes.md", content: "x" } }),
		];
		expect(summary(entries)).toEqual([{ path: "kept.ts", added: 0, removed: 0, calls: ["s1"] }]);
	});
});
