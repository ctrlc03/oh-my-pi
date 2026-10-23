import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import {
	type AuthGatewayClient,
	type AuthGatewayServerHandle,
	type AuthGatewayUsageLedger,
	createMemoryUsageLedger,
	hashAuthGatewayToken,
	parseAuthGatewayClients,
	startAuthGateway,
	utcDay,
	validateAuthGatewayClient,
} from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, type MockModel, type MockResponse, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Api, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";

const GATEWAY_TOKEN = "gateway-token";
const CI_TOKEN = "ci-token";
const OPS_TOKEN = "ops-token";
const DAY_ONE = Date.UTC(2026, 9, 22, 12, 0, 0);
const DAY_TWO = Date.UTC(2026, 9, 23, 0, 0, 1);

interface ErrorBody {
	type?: string;
	error: { type: string; message: string; code?: number };
}

async function errorBody(response: Response): Promise<ErrorBody> {
	return JSON.parse(await response.text());
}

function client(name: string, token: string, budget?: AuthGatewayClient["budget"]): AuthGatewayClient {
	return { name, tokenSha256: hashAuthGatewayToken(token), budget };
}

describe("auth-gateway client budgets", () => {
	let dir = "";
	let storage: AuthStorage;
	let gateway: AuthGatewayServerHandle | undefined;
	let clock = DAY_ONE;
	let ledger: AuthGatewayUsageLedger;

	beforeEach(async () => {
		registerMockApi();
		clock = DAY_ONE;
		ledger = createMemoryUsageLedger();
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-budget-"));
		storage = new AuthStorage(await SqliteAuthCredentialStore.open(path.join(dir, "auth.db")));
		await storage.credentials.set("mock", [{ type: "api_key", key: "stored-key" }]);
	});

	afterEach(async () => {
		await gateway?.close();
		gateway = undefined;
		vi.restoreAllMocks();
		clearCustomApis();
		storage.close();
		await fs.rm(dir, { recursive: true, force: true });
	});

	/** Hooks `boot` can add: `before` runs first in every turn and may hold it; `video` and `fetch` serve `/v1/videos`. */
	interface BootExtras {
		before?: () => Promise<void> | undefined;
		video?: Model<Api>;
		fetch?: FetchImpl;
	}

	/** A mock model whose every turn reports `tokens` total (input + output) and `cost` dollars. */
	function boot(clients: readonly AuthGatewayClient[], tokens = 100, cost = 0.25, extras: BootExtras = {}): MockModel {
		const mock = createMockModel({
			provider: "mock",
			id: "m",
			handler: async (): Promise<MockResponse> => {
				await extras.before?.();
				return { content: ["ok"], usage: { input: tokens - 10, output: 10, cost: { total: cost } } };
			},
		});
		const byId = new Map<string, Model<Api>>([
			["mock/m", mock],
			["m", mock],
		]);
		if (extras.video) byId.set(`${extras.video.provider}/${extras.video.id}`, extras.video);
		gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: [GATEWAY_TOKEN],
			storage,
			resolveModel: id => byId.get(id),
			listModels: () => byId.values(),
			clients,
			version: "test",
			usageLedger: ledger,
			now: () => clock,
			fetch: extras.fetch,
		});
		return mock;
	}

	function post(token: string, route: string, body: unknown, signal?: AbortSignal): Promise<Response> {
		if (!gateway) throw new Error("gateway not started");
		return fetch(`${gateway.url}${route}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify(body),
			signal,
		});
	}

	function chat(token: string, stream = false): Promise<Response> {
		return post(token, "/v1/chat/completions", {
			model: "mock/m",
			messages: [{ role: "user", content: "hi" }],
			stream,
		});
	}

	const RESET = "2026-10-23T00:00:00.000Z";

	it("serves a client under its budget and refuses it once usage reaches the token limit", async () => {
		const mock = boot([client("ci", CI_TOKEN, { dailyTokens: 150 })]);

		expect((await chat(CI_TOKEN)).status).toBe(200); // 100 of 150
		expect((await chat(CI_TOKEN)).status).toBe(200); // 200 of 150: the request that crosses overshoots
		mock.reset();

		const refused = await chat(CI_TOKEN);
		expect(refused.status).toBe(429);
		const body = await errorBody(refused);
		expect(body.error.type).toBe("daily_budget_exhausted");
		expect(body.error.message).toContain(RESET);
		expect(mock.calls).toHaveLength(0);
		expect(ledger.read("ci", utcDay(DAY_ONE))).toEqual({ tokens: 200, costUsd: 0.5 });
	});

	it("refuses on the cost limit alone", async () => {
		boot([client("ci", CI_TOKEN, { dailyCostUsd: 0.4 })], 10, 0.25);

		expect((await chat(CI_TOKEN)).status).toBe(200);
		expect((await chat(CI_TOKEN)).status).toBe(200);
		expect((await chat(CI_TOKEN)).status).toBe(429);
	});

	it("refuses in each route's own wire format", async () => {
		boot([client("ci", CI_TOKEN, { dailyTokens: 1 })]);
		expect((await chat(CI_TOKEN)).status).toBe(200);

		const anthropic = await post(CI_TOKEN, "/v1/messages", {
			model: "mock/m",
			max_tokens: 16,
			messages: [{ role: "user", content: "hi" }],
		});
		expect(anthropic.status).toBe(429);
		const anthropicBody = await errorBody(anthropic);
		expect(anthropicBody.type).toBe("error");
		expect(anthropicBody.error.type).toBe("daily_budget_exhausted");
		expect(anthropicBody.error.message).toContain(RESET);

		for (const [route, request] of [
			["/v1/chat/completions", { model: "mock/m", messages: [{ role: "user", content: "hi" }] }],
			["/v1/responses", { model: "mock/m", input: "hi" }],
		] as const) {
			const refused = await post(CI_TOKEN, route, request);
			expect(refused.status).toBe(429);
			const body = await errorBody(refused);
			expect(body.error.type).toBe("daily_budget_exhausted");
			expect(body.error.message).toContain(RESET);
		}

		const piNative = await post(CI_TOKEN, "/v1/pi/stream", {
			modelId: "mock/m",
			context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			stream: false,
		});
		expect(piNative.status).toBe(429);
		expect((await errorBody(piNative)).error.type).toBe("daily_budget_exhausted");

		const embeddings = await post(CI_TOKEN, "/v1/embeddings", { model: "mock/m", input: "hi" });
		expect(embeddings.status).toBe(429);
		expect((await errorBody(embeddings)).error).toMatchObject({
			code: 429,
			type: "daily_budget_exhausted",
		});
	});

	it("counts a streamed turn once it completes", async () => {
		const base = ledger;
		const recorded = Promise.withResolvers<void>();
		ledger = {
			read: (name, day) => base.read(name, day),
			add: (name, day, delta) => {
				base.add(name, day, delta);
				recorded.resolve();
			},
		};
		boot([client("ci", CI_TOKEN, { dailyTokens: 100 })]);

		const streamed = await chat(CI_TOKEN, true);
		expect(streamed.status).toBe(200);
		await streamed.text();
		// The turn's usage is recorded as its stream settles, which may trail the last byte.
		await recorded.promise;
		expect(ledger.read("ci", utcDay(DAY_ONE)).tokens).toBe(100);

		expect((await chat(CI_TOKEN)).status).toBe(429);
	});

	it("serves the client again on the next UTC day", async () => {
		boot([client("ci", CI_TOKEN, { dailyTokens: 100 })]);

		expect((await chat(CI_TOKEN)).status).toBe(200);
		expect((await chat(CI_TOKEN)).status).toBe(429);

		clock = DAY_TWO;
		expect((await chat(CI_TOKEN)).status).toBe(200);
		expect((await chat(CI_TOKEN)).status).toBe(429);
		expect(ledger.read("ci", utcDay(DAY_ONE)).tokens).toBe(100);
		expect(ledger.read("ci", utcDay(DAY_TWO)).tokens).toBe(100);
	});

	describe("in-flight cap", () => {
		const delays = (count: number) => Array.from({ length: count }, () => Promise.withResolvers<void>());

		/** Resolves whoever waits in `until` each time a held turn starts. */
		let turnStarted = Promise.withResolvers<void>();

		/** Boots with every request's turn held until the matching delay in `held` resolves; later requests run at once. */
		function bootHeld(clients: readonly AuthGatewayClient[], held: ReadonlyArray<PromiseWithResolvers<void>>) {
			const waiting = held.map(delay => delay.promise);
			const state = { started: 0 };
			boot(clients, 100, 0.25, {
				before: () => {
					state.started++;
					const signal = turnStarted;
					turnStarted = Promise.withResolvers<void>();
					signal.resolve();
					return waiting.shift();
				},
			});
			return state;
		}

		async function until(condition: () => boolean): Promise<void> {
			while (!condition()) await turnStarted.promise;
		}

		it("refuses a request over the cap and accepts again once one finishes", async () => {
			const held = delays(2);
			const state = bootHeld([client("ci", CI_TOKEN, { dailyTokens: 1_000_000, maxConcurrent: 2 })], held);

			const first = chat(CI_TOKEN);
			const second = chat(CI_TOKEN);
			await until(() => state.started === 2);

			const refused = await chat(CI_TOKEN);
			expect(refused.status).toBe(429);
			expect(refused.headers.get("retry-after")).toBe("1");
			const body = await errorBody(refused);
			expect(body.error.type).toBe("too_many_concurrent_requests");
			expect(body.error.message).toContain("ci");
			expect(body.error.message).toContain("2 requests");
			expect(state.started).toBe(2);

			held[0].resolve();
			await (await first).text();
			expect((await chat(CI_TOKEN)).status).toBe(200);

			held[1].resolve();
			expect((await second).status).toBe(200);
		});

		it("refuses in the route's own wire format", async () => {
			const held = delays(1);
			const state = bootHeld([client("ci", CI_TOKEN, { dailyTokens: 1_000_000, maxConcurrent: 1 })], held);

			const first = chat(CI_TOKEN);
			await until(() => state.started === 1);
			const refused = await post(CI_TOKEN, "/v1/messages", {
				model: "mock/m",
				max_tokens: 16,
				messages: [{ role: "user", content: "hi" }],
			});
			expect(refused.status).toBe(429);
			expect(refused.headers.get("retry-after")).toBe("1");
			const body = await errorBody(refused);
			expect(body.type).toBe("error");
			expect(body.error.type).toBe("too_many_concurrent_requests");

			held[0].resolve();
			await (await first).text();
		});

		it("frees the slot of a request the client aborts", async () => {
			const held = delays(1);
			const state = bootHeld([client("ci", CI_TOKEN, { dailyTokens: 1_000_000, maxConcurrent: 1 })], held);

			const abort = new AbortController();
			const aborted = post(
				CI_TOKEN,
				"/v1/chat/completions",
				{ model: "mock/m", messages: [{ role: "user", content: "hi" }] },
				abort.signal,
			);
			await until(() => state.started === 1);
			expect((await chat(CI_TOKEN)).status).toBe(429);

			abort.abort();
			await expect(aborted).rejects.toThrow();
			// The gateway notices the closed socket on its own schedule and exposes nothing to await, so retry until it frees the slot.
			let status = 429;
			for (let attempt = 0; attempt < 500 && status !== 200; attempt++) status = (await chat(CI_TOKEN)).status;
			expect(status).toBe(200);
			held[0].resolve();
		});

		it("frees the slot once a streamed response has been read", async () => {
			boot([client("ci", CI_TOKEN, { dailyTokens: 1_000_000, maxConcurrent: 1 })]);

			for (let turn = 0; turn < 3; turn++) {
				const streamed = await chat(CI_TOKEN, true);
				expect(streamed.status).toBe(200);
				await streamed.text();
			}
		});

		it("defaults the cap to 16", async () => {
			const held = delays(16);
			const state = bootHeld([client("ci", CI_TOKEN, { dailyTokens: 1_000_000_000 })], held);

			const open = held.map(() => chat(CI_TOKEN));
			await until(() => state.started === 16);
			const refused = await chat(CI_TOKEN);
			expect(refused.status).toBe(429);
			expect((await errorBody(refused)).error.message).toContain("16 requests");

			for (const delay of held) delay.resolve();
			for (const response of await Promise.all(open)) expect(response.status).toBe(200);
		});

		it("does not cap a client without a budget or the gateway token", async () => {
			const held = delays(20);
			const state = bootHeld([client("ops", OPS_TOKEN)], held);

			const open = held.map((_delay, index) => chat(index % 2 === 0 ? OPS_TOKEN : GATEWAY_TOKEN));
			await until(() => state.started === 20);

			for (const delay of held) delay.resolve();
			for (const response of await Promise.all(open)) expect(response.status).toBe(200);
		});
	});

	describe("video", () => {
		/** Boots a budgeted client against an upstream whose first job completes at `cost`; returns the upstream's request log. */
		function bootVideo(budget: AuthGatewayClient["budget"], cost: number): string[] {
			const video = buildModel({
				id: "google/veo-3.1",
				name: "veo",
				api: "openrouter-video",
				provider: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: null,
				maxTokens: null,
				kind: "video",
			} satisfies ModelSpec<Api>);
			const upstream: string[] = [];
			const upstreamFetch: FetchImpl = async (input, init) => {
				const method = init?.method ?? "GET";
				upstream.push(`${method} ${String(input)}`);
				if (method === "POST") return Response.json({ id: "job-1", status: "pending" }, { status: 202 });
				return Response.json({ id: "job-1", status: "completed", usage: { cost } });
			};
			storage.keys.setRuntime("openrouter", "openrouter-secret");
			boot([client("ci", CI_TOKEN, budget)], 100, 0.25, { video, fetch: upstreamFetch });
			return upstream;
		}

		const submit = () => post(CI_TOKEN, "/v1/videos", { model: "openrouter/google/veo-3.1", prompt: "a lighthouse" });

		const poll = (jobId: string) =>
			fetch(`${gateway?.url}/v1/videos/${jobId}`, { headers: { Authorization: `Bearer ${CI_TOKEN}` } });

		async function submitJob(): Promise<string> {
			const submitted = await submit();
			expect(submitted.status).toBe(202);
			const body: { id: string } = JSON.parse(await submitted.text());
			return body.id;
		}

		it("refuses video submits once the budget is used up, counting a completed video's cost", async () => {
			const upstream = bootVideo({ dailyCostUsd: 0.3 }, 0.4);

			const jobId = await submitJob();
			expect(ledger.read("ci", utcDay(DAY_ONE)).costUsd).toBe(0);
			expect((await poll(jobId)).status).toBe(200);
			expect(ledger.read("ci", utcDay(DAY_ONE))).toEqual({ tokens: 0, costUsd: 0.4 });

			const upstreamCalls = upstream.length;
			const refused = await submit();
			expect(refused.status).toBe(429);
			expect((await errorBody(refused)).error.type).toBe("daily_budget_exhausted");
			expect(upstream).toHaveLength(upstreamCalls);
		});

		it("counts a completed video's cost once however often its job is polled", async () => {
			bootVideo({ dailyCostUsd: 10 }, 0.4);
			const observe = vi.spyOn(storage.usage, "observe");

			const jobId = await submitJob();
			for (let attempt = 0; attempt < 3; attempt++) expect((await poll(jobId)).status).toBe(200);

			expect(ledger.read("ci", utcDay(DAY_ONE))).toEqual({ tokens: 0, costUsd: 0.4 });
			expect(observe).toHaveBeenCalledTimes(1);
		});
	});

	it("limits neither another client nor the gateway token, and records only scoped traffic", async () => {
		boot([client("ci", CI_TOKEN, { dailyTokens: 100 }), client("ops", OPS_TOKEN)]);

		expect((await chat(CI_TOKEN)).status).toBe(200);
		expect((await chat(CI_TOKEN)).status).toBe(429);

		for (let turn = 0; turn < 3; turn++) {
			expect((await chat(OPS_TOKEN)).status).toBe(200);
			expect((await chat(GATEWAY_TOKEN)).status).toBe(200);
		}
		expect(ledger.read("ops", utcDay(DAY_ONE)).tokens).toBe(300);
		expect(ledger.read("ci", utcDay(DAY_ONE)).tokens).toBe(100);
	});

	it("applies a reloaded budget to the day's usage so far", async () => {
		boot([client("ci", CI_TOKEN, { dailyTokens: 100 })]);
		expect((await chat(CI_TOKEN)).status).toBe(200);
		expect((await chat(CI_TOKEN)).status).toBe(429);

		gateway?.setClients([client("ci", CI_TOKEN, { dailyTokens: 250 })]);
		expect((await chat(CI_TOKEN)).status).toBe(200); // 200 of 250
		expect((await chat(CI_TOKEN)).status).toBe(200); // 300 of 250
		expect((await chat(CI_TOKEN)).status).toBe(429);

		gateway?.setClients([client("ci", CI_TOKEN)]);
		expect((await chat(CI_TOKEN)).status).toBe(200);
	});

	it("keeps a default in-memory ledger when none is given", async () => {
		const mock = createMockModel({
			provider: "mock",
			id: "m",
			handler: () => ({ content: ["ok"], usage: { input: 5, output: 5 } }),
		});
		gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: [GATEWAY_TOKEN],
			storage,
			resolveModel: () => mock,
			clients: [client("ci", CI_TOKEN, { dailyTokens: 10 })],
		});

		expect((await chat(CI_TOKEN)).status).toBe(200);
		expect((await chat(CI_TOKEN)).status).toBe(429);
	});
});

describe("utcDay and the memory ledger", () => {
	it("names the UTC calendar day", () => {
		expect(utcDay(Date.UTC(2026, 9, 22, 23, 59, 59, 999))).toBe("2026-10-22");
		expect(utcDay(Date.UTC(2026, 9, 23))).toBe("2026-10-23");
	});

	it("totals per client and day", () => {
		const ledger = createMemoryUsageLedger();
		expect(ledger.read("a", "2026-10-22")).toEqual({ tokens: 0, costUsd: 0 });
		ledger.add("a", "2026-10-22", { tokens: 5, costUsd: 0.5 });
		ledger.add("a", "2026-10-22", { tokens: 7, costUsd: 0.25 });
		ledger.add("b", "2026-10-22", { tokens: 1, costUsd: 0 });
		expect(ledger.read("a", "2026-10-22")).toEqual({ tokens: 12, costUsd: 0.75 });
		expect(ledger.read("a", "2026-10-23")).toEqual({ tokens: 0, costUsd: 0 });
		expect(ledger.read("b", "2026-10-22")).toEqual({ tokens: 1, costUsd: 0 });
	});
});

describe("parseAuthGatewayClients budget", () => {
	const tokenSha256 = hashAuthGatewayToken(CI_TOKEN);

	it("accepts either limit or both", () => {
		const parsed = parseAuthGatewayClients(
			JSON.stringify({
				a: { tokenSha256, budget: { dailyTokens: 1000 } },
				b: { tokenSha256: hashAuthGatewayToken("b"), budget: { dailyCostUsd: 2.5 } },
				c: { tokenSha256: hashAuthGatewayToken("c"), budget: { dailyTokens: 5, dailyCostUsd: 1 } },
			}),
		);
		expect(parsed.map(entry => entry.budget)).toEqual([
			{ dailyTokens: 1000 },
			{ dailyCostUsd: 2.5 },
			{ dailyTokens: 5, dailyCostUsd: 1 },
		]);
	});

	it.each([
		["a zero limit", { dailyTokens: 0 }, "dailyTokens"],
		["a negative limit", { dailyCostUsd: -1 }, "dailyCostUsd"],
		["a non-number limit", { dailyTokens: "1000" }, "dailyTokens"],
		["a null limit", { dailyTokens: null }, "dailyTokens"],
		["an empty budget", {}, "dailyTokens and/or dailyCostUsd"],
		["an unknown key", { dailyTokens: 1, weeklyTokens: 5 }, 'unknown field "weeklyTokens"'],
		["a budget that is not an object", 5, "expected an object"],
	])("rejects %s", (_label, budget, message) => {
		expect(() =>
			parseAuthGatewayClients(`{"ci":{"tokenSha256":"${tokenSha256}","budget":${JSON.stringify(budget)}}}`),
		).toThrow(message);
	});
});

describe("parseAuthGatewayClients maxConcurrent", () => {
	const tokenSha256 = hashAuthGatewayToken(CI_TOKEN);
	const parse = (budget: unknown) =>
		parseAuthGatewayClients(`{"ci":{"tokenSha256":"${tokenSha256}","budget":${JSON.stringify(budget)}}}`);

	it("accepts a positive integer next to a daily limit", () => {
		expect(parse({ dailyTokens: 10, maxConcurrent: 4 })[0].budget).toEqual({ dailyTokens: 10, maxConcurrent: 4 });
	});

	it.each([
		["zero", 0],
		["a negative", -2],
		["a fraction", 1.5],
		["a string", "4"],
		["null", null],
	])("rejects %s", (_label, maxConcurrent) => {
		expect(() => parse({ dailyTokens: 10, maxConcurrent })).toThrow("maxConcurrent");
	});

	it("still requires a daily limit", () => {
		expect(() => parse({ maxConcurrent: 4 })).toThrow("dailyTokens and/or dailyCostUsd");
	});
});

describe("validateAuthGatewayClient", () => {
	const valid = client("ci", CI_TOKEN, { dailyTokens: 10, maxConcurrent: 2 });

	it("accepts a valid client", () => {
		expect(() => validateAuthGatewayClient(valid)).not.toThrow();
	});

	it("rejects a model grant that is not provider/id", () => {
		expect(() => validateAuthGatewayClient({ ...valid, models: ["sonnet"] })).toThrow("ci.models");
	});

	it("rejects a non-positive budget limit or cap", () => {
		expect(() => validateAuthGatewayClient({ ...valid, budget: { dailyTokens: 0 } })).toThrow(
			"ci.budget.dailyTokens",
		);
		expect(() => validateAuthGatewayClient({ ...valid, budget: { dailyTokens: 10, maxConcurrent: 0 } })).toThrow(
			"ci.budget.maxConcurrent",
		);
	});

	it("rejects a malformed digest and an empty name", () => {
		expect(() => validateAuthGatewayClient({ ...valid, tokenSha256: "abc" })).toThrow("ci.tokenSha256");
		expect(() => validateAuthGatewayClient({ ...valid, name: "" })).toThrow("client name");
	});
});
