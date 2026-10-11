/**
 * Contract: queued follow-ups are addressable by a stable id, so a remote editor can edit one in place,
 * move it, or promote it to steer the running turn even when two chips carry the same text.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { queueEditRefusal, rewriteQueuedPrompt } from "@oh-my-pi/pi-coding-agent/collab/queue-edit";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("AgentSession queued follow-up editing", () => {
	let fixtureDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;
	let release: () => void;
	let run: Promise<unknown>;

	beforeAll(async () => {
		fixtureDir = path.join(os.tmpdir(), `pi-queue-edit-${Snowflake.next()}`);
		fs.mkdirSync(fixtureDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(fixtureDir, "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(fixtureDir, "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		removeSyncWithRetries(fixtureDir);
	});

	/** A session whose first model call stays open until `release`, so everything queued meanwhile stays queued. */
	beforeEach(async () => {
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		release = gate.resolve;
		const mock = createMockModel({
			handler: async () => {
				started.resolve();
				await gate.promise;
				return { content: ["done"] };
			},
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		run = session.prompt("start");
		await started.promise;
	});

	afterEach(async () => {
		release();
		await run.catch(() => {});
		await session.dispose();
	});

	function queueFollowUp(text: string): Promise<boolean> {
		return session.promptCustomMessage(
			{ customType: "collab-prompt", content: text, display: true, details: { from: "guest" }, attribution: "user" },
			{ streamingBehavior: "followUp", queueChipText: text },
		);
	}

	const texts = (): string[] => session.listQueuedFollowUps().map(queued => queued.text);

	it("lists follow-ups with ids that stay with them through edits and moves", async () => {
		await queueFollowUp("same");
		await queueFollowUp("same");
		await queueFollowUp("other");
		const [a, b, c] = session.listQueuedFollowUps();
		expect(new Set([a.id, b.id, c.id]).size).toBe(3);

		expect(session.editQueuedFollowUp(b.id, message => rewriteQueuedPrompt(message, "edited", undefined))).toBe(
			"edited",
		);
		expect(session.listQueuedFollowUps()).toEqual([a, { id: b.id, text: "edited" }, c]);
		expect(session.getQueuedMessages().followUp).toEqual(["same", "edited", "other"]);

		expect(session.moveQueuedFollowUp(c.id, 0)).toBe(true);
		expect(session.listQueuedFollowUps().map(queued => queued.id)).toEqual([c.id, a.id, b.id]);
		expect(session.moveQueuedFollowUp(c.id, 99)).toBe(true);
		expect(session.listQueuedFollowUps().map(queued => queued.id)).toEqual([a.id, b.id, c.id]);
		expect(session.moveQueuedFollowUp("q-nope", 0)).toBe(false);
	});

	it("reports a missing id and refuses a rewrite the caller declines, changing nothing", async () => {
		await queueFollowUp("one");
		const [one] = session.listQueuedFollowUps();
		expect(session.editQueuedFollowUp("q-nope", message => message)).toBe("missing");
		expect(session.editQueuedFollowUp(one.id, () => undefined)).toBe("refused");
		expect(texts()).toEqual(["one"]);
	});

	it("promotes one follow-up to the steering queue by id", async () => {
		await queueFollowUp("later");
		await queueFollowUp("now");
		const [, now] = session.listQueuedFollowUps();
		expect(session.promoteQueuedFollowUp(now.id)).toBe(true);
		expect(session.getQueuedMessages().followUp).toEqual(["later"]);
		expect(session.getQueuedMessages().steering).toEqual(["now"]);
		expect(session.promoteQueuedFollowUp(now.id)).toBe(false);
	});

	it("edits only guest prompts that are not slash commands", async () => {
		await queueFollowUp("plain");
		await queueFollowUp("/skill:review this");
		const [plain, slash] = session.listQueuedFollowUps();
		const refusal = (id: string, text: string): string | undefined => {
			let reason: string | undefined;
			session.editQueuedFollowUp(id, message => {
				reason = queueEditRefusal(message, text);
				return undefined;
			});
			return reason;
		};
		expect(refusal(plain.id, "fine")).toBeUndefined();
		expect(refusal(plain.id, "/new")).toBeDefined();
		expect(refusal(slash.id, "fine")).toBeDefined();
	});
});
