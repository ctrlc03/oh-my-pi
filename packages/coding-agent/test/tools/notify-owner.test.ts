import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_NOTIFY_BODY_CHARS, PERSONAL_IPC_FILE, type PersonalIpcRequest } from "@oh-my-pi/pi-wire/personal-ipc";
import { Settings } from "../../src/config/settings";
import {
	PersonalCompanionRefusedError,
	type PersonalCompanion,
	PersonalCompanionUnavailableError,
	personalCompanion,
} from "../../src/personal/ipc-client";
import { NotifyBook } from "../../src/personal/notify-book";
import type { PersonalRuntime } from "../../src/personal/runtime";
import { BUILTIN_TOOL_NAMES } from "../../src/tools/builtin-names";
import { resolveBuiltinToolPlan, type ToolSession } from "../../src/tools";
import { NotifyOwnerTool, type NotifyOwnerParams } from "../../src/tools/notify-owner";

type NotifyRequest = Parameters<PersonalCompanion["notify"]>[0];

describe("notify_owner tool", () => {
	let sent: NotifyRequest[];
	let book: NotifyBook;
	let origin: "owner" | "external" | "agent";
	let reply: () => Promise<{ itemId: string; pushed: boolean }>;

	const companion: PersonalCompanion = {
		notify: async request => {
			sent.push(request);
			return reply();
		},
		hello: async () => {},
		receipt: async () => {},
	};

	const runtime = (): PersonalRuntime =>
		({ book, companion, currentOrigin: () => origin }) as unknown as PersonalRuntime;

	const session = (overrides: Record<string, unknown> = {}, withRuntime = true, taskDepth = 0): ToolSession =>
		({
			cwd: "/tmp",
			settings: Settings.isolated({ "personal.enabled": true, ...overrides }),
			taskDepth,
			getSessionId: () => "sess-1",
			getPersonal: withRuntime ? runtime : undefined,
		}) as unknown as ToolSession;

	const tool = (overrides: Record<string, unknown> = {}) => new NotifyOwnerTool(session(overrides), companion);
	const run = (params: Partial<NotifyOwnerParams> & Pick<NotifyOwnerParams, "kind">, t = tool()) =>
		t.execute("call-1", { title: "Title", body: "Body", ...params } as NotifyOwnerParams);
	const textOf = (result: { content: Array<{ type: string; text?: string }> }) => result.content[0]?.text ?? "";

	beforeEach(() => {
		sent = [];
		book = new NotifyBook();
		origin = "owner";
		reply = async () => ({ itemId: "item-1", pushed: true });
	});

	describe("availability", () => {
		it("exists only for a top-level session with personal.enabled and a runtime", () => {
			expect(NotifyOwnerTool.createIf(session())).toBeInstanceOf(NotifyOwnerTool);
			expect(NotifyOwnerTool.createIf(session({ "personal.enabled": false }))).toBeNull();
			expect(NotifyOwnerTool.createIf(session({}, false))).toBeNull();
			expect(NotifyOwnerTool.createIf(session({}, true, 1))).toBeNull();
		});

		it("is a built-in name offered only when personal.enabled, at depth 0", async () => {
			expect(BUILTIN_TOOL_NAMES).toContain("notify_owner");
			const planned = async (s: ToolSession) => {
				(s as { skipPythonPreflight?: boolean }).skipPythonPreflight = true;
				return (await resolveBuiltinToolPlan(s)).names;
			};
			const on = await planned(session());
			const off = await planned(session({ "personal.enabled": false }));
			expect(on).toContain("notify_owner");
			expect(off).not.toContain("notify_owner");
			expect(on.filter(name => name !== "notify_owner")).toEqual(off);
			expect(await planned(session({}, true, 1))).not.toContain("notify_owner");
		});
	});

	describe("sending", () => {
		it("sends an info item with the session id, the run kind and the origin of the turn", async () => {
			origin = "external";
			const result = await run({ kind: "info", title: "Backup failed", body: "rsync exited 23" });
			expect(sent).toEqual([
				{
					sessionId: "sess-1",
					runKind: "live",
					origin: "external",
					item: { title: "Backup failed", body: "rsync exited 23", kind: "info" },
				},
			]);
			expect(textOf(result)).toContain("item-1");
			expect(result.details).toEqual({ kind: "info", itemId: "item-1", pushed: true });
		});

		it("passes options for a question and tells the agent not to wait", async () => {
			const result = await run({ kind: "question", options: ["Yes", "No"], push: false });
			expect(sent[0].item).toMatchObject({ kind: "question", options: ["Yes", "No"], push: false });
			expect(textOf(result)).toContain("Do not wait");
		});

		it("sends a proposal", async () => {
			await run({
				kind: "proposal",
				proposal: { op: "add", section: "Style", text: "Prefer squash merges", rationale: "asked 4 times" },
			});
			expect(sent[0].item.proposal).toEqual({
				op: "add",
				section: "Style",
				text: "Prefer squash merges",
				rationale: "asked 4 times",
			});
		});
	});

	describe("validation", () => {
		it("refuses over-long text", async () => {
			await expect(run({ kind: "info", body: "x".repeat(MAX_NOTIFY_BODY_CHARS + 1) })).rejects.toThrow(
				/body is over/,
			);
			expect(sent).toEqual([]);
		});

		it("allows options only on questions", async () => {
			await expect(run({ kind: "info", options: ["a"] })).rejects.toThrow(/options only apply/);
		});

		it("needs the proposal object for a proposal, and forbids it elsewhere", async () => {
			await expect(run({ kind: "proposal" })).rejects.toThrow(/needs the proposal/);
			await expect(run({ kind: "info", proposal: { op: "remove", target: "x", rationale: "y" } })).rejects.toThrow(
				/only applies to kind: proposal/,
			);
		});

		it("checks each proposal op's fields and keeps lines to one line", async () => {
			const rationale = "because";
			await expect(run({ kind: "proposal", proposal: { op: "add", text: "a", rationale } })).rejects.toThrow(
				/section and text/,
			);
			await expect(run({ kind: "proposal", proposal: { op: "replace", text: "a", rationale } })).rejects.toThrow(
				/target and text/,
			);
			await expect(run({ kind: "proposal", proposal: { op: "remove", rationale } })).rejects.toThrow(/needs target/);
			await expect(
				run({ kind: "proposal", proposal: { op: "add", section: "S", text: "a\nb", rationale } }),
			).rejects.toThrow(/one line/);
			await expect(
				run({ kind: "proposal", proposal: { op: "add", section: "S", text: "a", rationale: " " } }),
			).rejects.toThrow(/rationale is required/);
			expect(sent).toEqual([]);
		});

		it("refuses a digest in a live session and accepts it in a review run", async () => {
			const digest = { day: "2026-05-01" };
			await expect(run({ kind: "digest", digest })).rejects.toThrow(/nightly review/);
			const review = tool({ "personal.runKind": "review" });
			await run({ kind: "digest", digest }, review);
			expect(sent[0]).toMatchObject({ runKind: "review", item: { kind: "digest", digest } });
			await expect(run({ kind: "digest", digest: { day: "yesterday" } }, review)).rejects.toThrow(/YYYY-MM-DD/);
		});
	});

	describe("limits", () => {
		it("refuses past the hourly limit and records only what was sent", async () => {
			const limited = tool({ "personal.notifyOwner.maxPerHour": 2 });
			await run({ kind: "info" }, limited);
			await run({ kind: "info" }, limited);
			await expect(run({ kind: "info" }, limited)).rejects.toThrow(/Too many notifications/);
			expect(sent).toHaveLength(2);
		});

		it("refuses a question past the open-question cap until one is answered", async () => {
			const limited = tool({ "personal.notifyOwner.maxOpenQuestions": 1 });
			await run({ kind: "question" }, limited);
			await expect(run({ kind: "question" }, limited)).rejects.toThrow(/open questions/);
			book.answered("item-1");
			await run({ kind: "question" }, limited);
			expect(sent).toHaveLength(2);
		});

		it("does not record a notification the companion refused", async () => {
			reply = async () => {
				throw new PersonalCompanionRefusedError("the owner already rejected this proposal");
			};
			await expect(run({ kind: "info" })).rejects.toThrow("the owner already rejected this proposal");
			expect(book.refusal("info", { maxPerHour: 1, maxOpenQuestions: 0 })).toBeUndefined();
		});

		it("says when the companion is not running", async () => {
			reply = async () => {
				throw new PersonalCompanionUnavailableError("it has exited");
			};
			await expect(run({ kind: "info" })).rejects.toThrow(/it has exited/);
		});
	});
});

describe("personalCompanion", () => {
	let agentDir: string;
	let server: ReturnType<typeof Bun.serve> | undefined;
	let received: { auth: string | null; url: string; body: PersonalIpcRequest }[];
	let answer: Record<string, unknown>;
	let status: number;

	const publish = (token: string, pid = process.pid) =>
		Bun.write(path.join(agentDir, PERSONAL_IPC_FILE), JSON.stringify({ port: server?.port, token, pid }));

	beforeEach(async () => {
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "personal-ipc-"));
		received = [];
		answer = { ok: true, itemId: "item-9", pushed: false };
		status = 200;
		server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: async req => {
				received.push({
					auth: req.headers.get("authorization"),
					url: new URL(req.url).pathname,
					body: (await req.json()) as PersonalIpcRequest,
				});
				return Response.json(answer, { status });
			},
		});
	});

	afterEach(async () => {
		await server?.stop(true);
		await fs.rm(agentDir, { recursive: true, force: true });
	});

	it("posts a notify with the bearer token and reads the reply", async () => {
		await publish("tok");
		const result = await personalCompanion(agentDir).notify({
			sessionId: "s1",
			runKind: "live",
			origin: "owner",
			item: { title: "t", body: "b", kind: "info" },
		});
		expect(result).toEqual({ itemId: "item-9", pushed: false });
		expect(received[0].auth).toBe("Bearer tok");
		expect(received[0].url).toBe("/personal");
		expect(received[0].body).toMatchObject({ op: "notify", sessionId: "s1", origin: "owner" });
	});

	it("sends hello as a live run and receipts as given", async () => {
		await publish("tok");
		answer = { ok: true };
		const companion = personalCompanion(agentDir);
		await companion.hello({ sessionId: "s1", pid: 42 });
		await companion.receipt({ sessionId: "s1", eventId: "e1", outcome: "rate-limited", detail: "too many" });
		expect(received.map(r => r.body)).toEqual([
			{ op: "hello", runKind: "live", sessionId: "s1", pid: 42 },
			{ op: "receipt", sessionId: "s1", eventId: "e1", outcome: "rate-limited", detail: "too many" },
		]);
	});

	it("turns the companion's refusal into an error carrying its message", async () => {
		await publish("tok");
		answer = { ok: false, error: "rejected before" };
		await expect(
			personalCompanion(agentDir).notify({
				sessionId: "s1",
				runKind: "live",
				origin: "owner",
				item: { title: "t", body: "b", kind: "info" },
			}),
		).rejects.toThrow("rejected before");
	});

	it("is unavailable without a channel file, with a dead pid, and after a token change", async () => {
		const companion = personalCompanion(agentDir);
		const request = { sessionId: "s1", eventId: "e1", outcome: "delivered" } as const;
		await expect(companion.receipt(request)).rejects.toBeInstanceOf(PersonalCompanionUnavailableError);
		const child = Bun.spawn(["true"]);
		await child.exited;
		await publish("tok", child.pid);
		await expect(companion.receipt(request)).rejects.toBeInstanceOf(PersonalCompanionUnavailableError);
		await publish("tok");
		status = 401;
		answer = { ok: false, error: "unauthorized" };
		await expect(companion.receipt(request)).rejects.toThrow(/token changed/);
	});
});
