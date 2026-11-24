/**
 * Types for the language-server client the companion drives for the editor's hover, definition, references and
 * diagnostics (tsconfig `paths` maps `@oh-my-pi/pi-coding-agent/lsp/client`, `…/lsp/config`, `…/lsp/utils`,
 * `…/lsp/servers` and `…/lsp/diagnostics` here, for the reason given in `omp-codemap.d.ts`). Keep in sync with
 * packages/coding-agent/src/lsp.
 */

/** One configured language server (the slice the companion reads). */
export interface ServerConfig {
	command: string;
	args?: string[];
	fileTypes: string[];
	rootMarkers: string[];
	/** Absolute path to the binary, set once config loading found it. */
	resolvedCommand?: string;
	isLinter?: boolean;
}

export interface LspConfig {
	servers: Record<string, ServerConfig>;
	idleTimeoutMs?: number;
}

/** A running (or starting) server process; opaque to the companion. */
export interface LspClient {
	name: string;
	cwd: string;
	status: "connecting" | "ready" | "error";
	/** Documents the server holds open, keyed by `file://` URI. */
	openFiles: Map<string, unknown>;
}

export interface LspDiagnosticRaw {
	range: { start: { line: number; character: number }; end: { line: number; character: number } };
	severity?: 1 | 2 | 3 | 4;
	code?: string | number;
	source?: string;
	message: string;
}

// client
export function getOrCreateClient(
	config: ServerConfig,
	cwd: string,
	initTimeoutMs?: number,
	signal?: AbortSignal,
): Promise<LspClient>;
export function sendRequest(
	client: LspClient,
	method: string,
	params: unknown,
	signal?: AbortSignal,
	timeoutMs?: number,
): Promise<unknown>;
export function syncContent(client: LspClient, filePath: string, content: string, signal?: AbortSignal): Promise<void>;
export function reconcileFileFromDisk(client: LspClient, filePath: string, signal?: AbortSignal): Promise<boolean>;
export function reconcileOpenFilesFromDisk(
	client: LspClient,
	signal?: AbortSignal,
	excludeUri?: string,
	unreadable?: "throw" | "close",
): Promise<number>;
export function waitForProjectLoaded(client: LspClient, signal?: AbortSignal): Promise<void>;
export function shutdownClientInstance(client: LspClient): Promise<boolean>;

// config
export const configCache: Map<string, LspConfig>;

// servers
export function getLspServerForFileByPath(cwd: string, filePath: string): Promise<[string, ServerConfig] | null>;
export function isProjectAwareLspServer(config: ServerConfig): boolean;

// utils
export function fileToUri(filePath: string): string;
export function uriToFile(uri: string): string;

// diagnostics
export function waitForDiagnostics(
	client: LspClient,
	uri: string,
	options?: { timeoutMs?: number; signal?: AbortSignal; expectedDocumentVersion?: number },
): Promise<LspDiagnosticRaw[] | undefined>;
