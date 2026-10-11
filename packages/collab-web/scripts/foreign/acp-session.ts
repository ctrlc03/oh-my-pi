/**
 * One vendor agent process and the Agent Client Protocol session on it, seen from the client side.
 *
 * The agent runs as its own process group (a detached child on pipes), so stopping it takes its helpers
 * with it. This is a thin client: it declares no file-system or terminal capability (the agent reads and
 * writes through its own tools, and tells us about it in `tool_call` updates), forwards `session/update`
 * notifications synchronously and in order, and hands permission and elicitation requests to the host.
 * What an update means is `./translate.ts`'s business.
 */

import type {
	AuthMethod,
	CreateElicitationRequest,
	CreateElicitationResponse,
	InitializeResponse,
	LoadSessionResponse,
	NewSessionResponse,
	PromptResponse,
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionConfigOption,
	SessionModeState,
	SessionUpdate,
} from "@oh-my-pi/pi-utils/acp/protocol";
import { ndJsonStream } from "@oh-my-pi/pi-utils/acp/stream";
import { RequestError, RpcConnection } from "@oh-my-pi/pi-utils/acp/transport";
import { isRecord } from "../../src/tool-render/util";
import type { LaunchSpec } from "./agents";
import type { ModelState } from "./translate";

const PROTOCOL_VERSION = 1;
const INITIALIZE_TIMEOUT_MS = 30_000;
const SETUP_TIMEOUT_MS = 90_000;
const KILL_GRACE_MS = 2_000;
const STDERR_TAIL_LINES = 20;
const AUTH_REQUIRED_CODE = -32000;

/** The agent is installed but not signed in; `methods` are what it offered (informational: sign-in is the vendor's own). */
export class AgentAuthRequiredError extends Error {
	readonly methods: AuthMethod[];
	constructor(methods: AuthMethod[]) {
		super("authentication required");
		this.name = "AgentAuthRequiredError";
		this.methods = methods;
	}
}

/** What a created or loaded session reports about itself. */
export interface SessionSetup {
	sessionId: string;
	configOptions: SessionConfigOption[] | null;
	modes: SessionModeState | null;
	/** The unstable model state some agents send beside config options. */
	models: ModelState | null;
}

export interface AcpHandlers {
	/** One `session/update`, called synchronously in arrival order. */
	onUpdate(update: SessionUpdate): void;
	onPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse["outcome"]>;
	onElicitation(request: CreateElicitationRequest): Promise<CreateElicitationResponse>;
	/** A request or notification outside the protocol proper (a vendor extension); resolve `undefined` when it is not supported. */
	onExtension(method: string, params: unknown, notification: boolean): Promise<unknown>;
	/** The agent process or its connection ended without {@link AcpSession.close} being called. */
	onExit(reason: string): void;
}

function isUpdateNotification(value: unknown): value is { sessionId: string; update: SessionUpdate } {
	return (
		isRecord(value) &&
		typeof value.sessionId === "string" &&
		isRecord(value.update) &&
		typeof value.update.sessionUpdate === "string"
	);
}

function isPermissionRequest(value: unknown): value is RequestPermissionRequest {
	return (
		isRecord(value) &&
		Array.isArray(value.options) &&
		isRecord(value.toolCall) &&
		typeof value.toolCall.toolCallId === "string"
	);
}

function isElicitationRequest(value: unknown): value is CreateElicitationRequest {
	return isRecord(value) && typeof value.mode === "string" && typeof value.message === "string";
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(() => timeout.reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
	return Promise.race([work, timeout.promise]).finally(() => clearTimeout(timer));
}

function parseModels(value: unknown): ModelState | null {
	if (!isRecord(value) || typeof value.currentModelId !== "string" || !Array.isArray(value.availableModels))
		return null;
	const availableModels: ModelState["availableModels"] = [];
	for (const item of value.availableModels) {
		if (isRecord(item) && typeof item.modelId === "string") {
			availableModels.push({
				modelId: item.modelId,
				name: typeof item.name === "string" ? item.name : item.modelId,
			});
		}
	}
	return { currentModelId: value.currentModelId, availableModels };
}

function setupOf(sessionId: string, response: NewSessionResponse | LoadSessionResponse): SessionSetup {
	return {
		sessionId,
		configOptions: response.configOptions ?? null,
		modes: response.modes ?? null,
		models: isRecord(response) ? parseModels(response.models) : null,
	};
}

export class AcpSession {
	readonly info: InitializeResponse;
	/** The agent restores a session by id (`session/load`). */
	readonly canLoad: boolean;
	/** The agent takes images in a prompt. */
	readonly canImage: boolean;
	readonly #proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
	readonly #connection: RpcConnection;
	readonly #stderrTail: string[];
	#sessionId: string | null = null;
	#closing = false;

	private constructor(
		proc: Bun.Subprocess<"pipe", "pipe", "pipe">,
		connection: RpcConnection,
		info: InitializeResponse,
		stderrTail: string[],
	) {
		this.#proc = proc;
		this.#connection = connection;
		this.info = info;
		this.#stderrTail = stderrTail;
		const capabilities = isRecord(info.agentCapabilities) ? info.agentCapabilities : {};
		this.canLoad = capabilities.loadSession === true;
		const prompt = isRecord(capabilities.promptCapabilities) ? capabilities.promptCapabilities : {};
		this.canImage = prompt.image === true;
	}

	/** Spawn the agent and run `initialize`. Rejects with the agent's own last words when it dies first. */
	static async start(spec: LaunchSpec, handlers: AcpHandlers): Promise<AcpSession> {
		const proc = Bun.spawn(spec.command, {
			cwd: spec.cwd,
			env: spec.env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			detached: true,
		});
		const stderrTail: string[] = [];
		void AcpSession.#collectStderr(proc.stderr, stderrTail);
		const input = new WritableStream<Uint8Array>({
			async write(chunk) {
				proc.stdin.write(chunk);
				await proc.stdin.flush();
			},
			async close() {
				await proc.stdin.end();
			},
		});
		const holder: { session: AcpSession | null } = { session: null };
		const connection = new RpcConnection(ndJsonStream(input, proc.stdout), (method, params, notification) => {
			if (method === "session/update") {
				if (isUpdateNotification(params)) {
					const target = holder.session?.sessionId ?? null;
					if (target === null || params.sessionId === target) handlers.onUpdate(params.update);
				}
				return undefined;
			}
			if (method === "session/request_permission") {
				if (!isPermissionRequest(params))
					throw RequestError.invalidParams(undefined, "malformed permission request");
				return handlers.onPermission(params).then(outcome => ({ outcome }));
			}
			if (method === "elicitation/create") {
				if (!isElicitationRequest(params))
					throw RequestError.invalidParams(undefined, "malformed elicitation request");
				return handlers.onElicitation(params);
			}
			// Vendor extensions (`cursor/…`): the host answers the ones it knows; for any other request it resolves
			// `undefined`, which is answered "method not found" so the agent is never left waiting.
			return handlers.onExtension(method, params, notification).then(result => {
				if (result === undefined && !notification) throw RequestError.methodNotFound(method);
				return result;
			});
		});
		const died = proc.exited.then(code => {
			throw new Error(`the agent exited (code ${code})${AcpSession.#tail(stderrTail)}`);
		});
		void died.catch(() => undefined);
		let info: InitializeResponse;
		try {
			info = await withTimeout(
				Promise.race([
					connection.request<InitializeResponse>("initialize", {
						protocolVersion: PROTOCOL_VERSION,
						clientCapabilities: { elicitation: { form: {} } },
						clientInfo: { name: "omp-collab", title: "oh-my-pi collab", version: "1" },
					}),
					died,
				]),
				INITIALIZE_TIMEOUT_MS,
				"the agent's handshake",
			);
		} catch (err) {
			connection.close();
			AcpSession.#kill(proc);
			throw err instanceof Error && !err.message.includes("exited")
				? new Error(`${err.message}${AcpSession.#tail(stderrTail)}`)
				: err;
		}
		const session = new AcpSession(proc, connection, info, stderrTail);
		holder.session = session;
		void Promise.race([connection.closed, proc.exited]).then(() => {
			if (session.#closing) return;
			handlers.onExit(`the agent ended${AcpSession.#tail(stderrTail)}`);
		});
		return session;
	}

	static async #collectStderr(stream: ReadableStream<Uint8Array>, tail: string[]): Promise<void> {
		const decoder = new TextDecoder();
		let pending = "";
		try {
			for await (const chunk of stream) {
				pending += decoder.decode(chunk, { stream: true });
				let newline = pending.indexOf("\n");
				while (newline >= 0) {
					const line = pending.slice(0, newline).trimEnd();
					pending = pending.slice(newline + 1);
					if (line !== "") {
						tail.push(line.slice(0, 500));
						if (tail.length > STDERR_TAIL_LINES) tail.shift();
					}
					newline = pending.indexOf("\n");
				}
			}
		} catch {
			// the pipe closed with the process
		}
	}

	/** The agent's last stderr lines, as a suffix for an error message. */
	static #tail(lines: readonly string[]): string {
		return lines.length === 0 ? "" : `: ${lines.slice(-5).join(" | ")}`;
	}

	/** Signal the process group (the child leads one); falls back to the child alone. */
	static #kill(proc: Bun.Subprocess, signal: NodeJS.Signals = "SIGTERM"): void {
		try {
			process.kill(-proc.pid, signal);
		} catch {
			try {
				proc.kill(signal);
			} catch {
				// already gone
			}
		}
	}

	/** Id of the session on this connection; null before one is created or loaded. */
	get sessionId(): string | null {
		return this.#sessionId;
	}

	get stderrTail(): readonly string[] {
		return this.#stderrTail;
	}

	async #setup<T extends NewSessionResponse | LoadSessionResponse>(
		method: string,
		params: Record<string, unknown>,
	): Promise<T> {
		try {
			return await withTimeout(this.#connection.request<T>(method, params), SETUP_TIMEOUT_MS, method);
		} catch (err) {
			if (err instanceof RequestError && err.code === AUTH_REQUIRED_CODE) {
				throw new AgentAuthRequiredError(this.info.authMethods ?? []);
			}
			throw err;
		}
	}

	async newSession(cwd: string): Promise<SessionSetup> {
		const response = await this.#setup<NewSessionResponse>("session/new", { cwd, mcpServers: [] });
		this.#sessionId = response.sessionId;
		return setupOf(response.sessionId, response);
	}

	/** Restore a session; the agent replays its history as `session/update`s before the response. */
	async loadSession(sessionId: string, cwd: string): Promise<SessionSetup> {
		this.#sessionId = sessionId;
		const response = await this.#setup<LoadSessionResponse>("session/load", { sessionId, cwd, mcpServers: [] });
		return setupOf(sessionId, response);
	}

	#require(): string {
		if (this.#sessionId === null) throw new Error("no agent session yet");
		return this.#sessionId;
	}

	prompt(prompt: unknown[]): Promise<PromptResponse> {
		return this.#connection.request<PromptResponse>("session/prompt", { sessionId: this.#require(), prompt });
	}

	/** Ask the agent to stop the running turn; its `prompt` then ends with `cancelled`. */
	async cancel(): Promise<void> {
		await this.#connection.notify("session/cancel", { sessionId: this.#require() });
	}

	async setConfigOption(configId: string, value: string | boolean): Promise<SessionConfigOption[]> {
		const response = await this.#connection.request<{ configOptions?: SessionConfigOption[] }>(
			"session/set_config_option",
			{
				sessionId: this.#require(),
				configId,
				value,
			},
		);
		return response.configOptions ?? [];
	}

	/** The agent's own model switch, for agents that list models but expose no model config option. */
	async setModel(modelId: string): Promise<void> {
		await this.#connection.request("session/set_model", { sessionId: this.#require(), modelId });
	}

	async setMode(modeId: string): Promise<void> {
		await this.#connection.request("session/set_mode", { sessionId: this.#require(), modeId });
	}

	/** End the agent: terminate its process group, and kill it outright if it lingers. */
	async close(): Promise<void> {
		if (this.#closing) return;
		this.#closing = true;
		this.#connection.close();
		AcpSession.#kill(this.#proc);
		const exited = await Promise.race([
			this.#proc.exited.then(() => true),
			Bun.sleep(KILL_GRACE_MS).then(() => false),
		]);
		if (!exited) {
			AcpSession.#kill(this.#proc, "SIGKILL");
			await this.#proc.exited;
		}
	}
}
