/**
 * Types for omp's local speech-to-text modules the companion transcribes voice input with (tsconfig `paths`
 * maps `@oh-my-pi/pi-coding-agent/stt/asr-client`, `/stt/downloader` and `/stt/models` here). This project
 * type-checks with the browser's DOM lib, and the real module graph only type-checks against the workspace's
 * non-DOM lib. bun still resolves the real modules at runtime. Keep in sync with
 * packages/coding-agent/src/stt/{asr-client,downloader,models}.ts.
 */

/** A model key of the speech model catalog (`STT_MODELS`). */
export type SttModelKey = string;

/** A catalog entry (the subset the companion reads). */
export interface SttModelSpec {
	key: SttModelKey;
	/** Model name, e.g. "Parakeet TDT v3 (SoTA)". */
	label: string;
	/** Approximate download size, e.g. "~680 MB". */
	sizeHint: string;
}

export const DEFAULT_STT_MODEL_KEY: SttModelKey;
export function isSttModelKey(value: string): value is SttModelKey;
/** The catalog entry of `key`, or the default model's when the key is unknown. */
export function resolveSttModelSpec(key: string | undefined): SttModelSpec;

/** Whether the model is fully present in the local cache. */
export function isSttModelCached(key: string): Promise<boolean>;
/** Download (or warm from cache) the model on the speech worker; rejects when it cannot be obtained. */
export function downloadSttModel(key: string): Promise<void>;

export interface SttClient {
	/** Transcribe 16 kHz mono float samples on the warm speech worker. */
	transcribe(modelKey: SttModelKey, audio: Float32Array): Promise<string>;
}
export const sttClient: SttClient;
/** Stop the speech worker subprocess. */
export function shutdownSttClient(): Promise<void>;
