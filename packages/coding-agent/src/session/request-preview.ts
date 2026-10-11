/**
 * Request preview: the provider request the next turn would send, without sending it.
 *
 * Providers hand the request body to `onPayload` right before the network call.
 * The preview runs the real provider path with an `onPayload` that records the
 * body, aborts the request and throws, so nothing is transmitted. Only
 * transports verified to call `onPayload` before any inference traffic are
 * run ({@link PREVIEWABLE_APIS}); for the others the preview is the
 * provider-neutral context the loop would hand the transport, so a preview can
 * never start a billable request by accident.
 */
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import type { RequestPreview } from "@oh-my-pi/pi-wire";

/** `model.api` values whose stream functions call `onPayload` before sending anything. */
export const PREVIEWABLE_APIS: Record<string, true> = {
	"openai-completions": true,
	"openai-responses": true,
	"azure-openai-responses": true,
	"openai-codex-responses": true,
	"anthropic-messages": true,
	"bedrock-converse-stream": true,
	"google-generative-ai": true,
	"google-vertex": true,
	"ollama-chat": true,
};

/** Default size cap of a preview's JSON text. */
export const PREVIEW_MAX_CHARS = 200_000;

/** Strings longer than this that look like base64 (inline images, file data) are replaced by a size marker. */
const BLOB_MIN_CHARS = 2_000;
const BASE64_BODY = /^[A-Za-z0-9+/_=-]+$/;

/** Thrown from `onPayload` once the body is captured, so the provider stops before sending. */
class PreviewCaptured extends Error {}

export interface PreviewRequestInput {
	model: Model;
	/** What the loop hands the transport: converted, obfuscated and transformed like a real turn. */
	context: Context;
	stream: StreamFn;
	options: SimpleStreamOptions;
	countTokens: (text: string) => number;
	/** Rewrites every string before it leaves the host (the session's secret obfuscator). */
	redact?: (text: string) => string;
	maxChars?: number;
	signal?: AbortSignal;
}

/** The provider body the transport would send, or `undefined` when it never reached `onPayload`. */
async function captureProviderBody(input: PreviewRequestInput): Promise<{ body: unknown } | undefined> {
	const abort = new AbortController();
	let captured: { body: unknown } | undefined;
	const options: SimpleStreamOptions = {
		...input.options,
		signal: input.signal ? AbortSignal.any([input.signal, abort.signal]) : abort.signal,
		onPayload: payload => {
			captured = { body: payload };
			abort.abort();
			throw new PreviewCaptured();
		},
	};
	try {
		const response = await input.stream(input.model, input.context, options);
		await response.result();
	} catch {
		// The capture hook throws on purpose; any other failure leaves `captured` unset.
	}
	return captured;
}

/** Copy of `value` with every string redacted and inline binary blobs elided. */
function sanitizeTree(value: unknown, redact: ((text: string) => string) | undefined): unknown {
	if (typeof value === "string") {
		if (value.length >= BLOB_MIN_CHARS && BASE64_BODY.test(value.slice(0, 256)))
			return `[${value.length} chars of binary data]`;
		return redact ? redact(value) : value;
	}
	if (value === null || typeof value !== "object") return value;
	if (value instanceof Uint8Array) return `[${value.byteLength} bytes]`;
	if (Array.isArray(value)) return value.map(item => sanitizeTree(item, redact));
	const copy: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) copy[key] = sanitizeTree(child, redact);
	return copy;
}

/** Build the preview for the next request. Never sends it. */
export async function previewRequest(input: PreviewRequestInput): Promise<RequestPreview> {
	const { model, context, redact } = input;
	const captured = Object.hasOwn(PREVIEWABLE_APIS, model.api) ? await captureProviderBody(input) : undefined;
	const source: RequestPreview["source"] = captured ? "request" : "context";
	const shown = sanitizeTree(captured ? captured.body : context, redact);
	const tokens = input.countTokens(JSON.stringify(shown) ?? "");
	const json = JSON.stringify(shown, null, 2) ?? "null";
	const maxChars = input.maxChars ?? PREVIEW_MAX_CHARS;
	const truncated = json.length > maxChars;
	const notes: string[] = [];
	if (!captured) {
		notes.push(
			Object.hasOwn(PREVIEWABLE_APIS, model.api)
				? "The provider did not expose its request body; showing the context the next turn would hand it."
				: `${model.api} cannot show its request body without sending it; showing the context the next turn would hand it.`,
		);
	}
	notes.push(
		"Reflects the conversation as it stands; the prompt you send next, hooks that rewrite requests and pending steering are not included.",
	);
	return {
		source,
		model: `${model.provider}/${model.id}`,
		tokens,
		messages: context.messages.length,
		tools: context.tools?.length ?? 0,
		text: truncated ? json.slice(0, maxChars) : json,
		truncated,
		note: notes.join(" "),
	};
}
