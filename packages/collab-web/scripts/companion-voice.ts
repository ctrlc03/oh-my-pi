/**
 * Voice input for the `transcribe` and `transcribe-setup` requests. A device records on its microphone and the
 * companion transcribes the recording locally with omp's own speech-to-text (the model omp dictates with: the
 * `dictation` model role, else Parakeet), so audio never leaves the computer. The recording is decoded to 16 kHz
 * mono float samples with `afconvert` (macOS) or `ffmpeg`; a computer with neither, or whose omp checkout cannot
 * load the speech modules, reports no voice capability.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type * as AsrClient from "@oh-my-pi/pi-coding-agent/stt/asr-client";
import type * as Downloader from "@oh-my-pi/pi-coding-agent/stt/downloader";
import type * as Models from "@oh-my-pi/pi-coding-agent/stt/models";
import type { TranscribeInfo } from "../src/lib/companion";

/** Longest base64 payload accepted; the app caps recordings at 8 MB before encoding (~10.7 M chars). */
export const MAX_AUDIO_BASE64_CHARS = 12_000_000;
/** Longest recording transcribed, in seconds; the app stops recording at 3 minutes. */
export const MAX_AUDIO_SECONDS = 300;
/** Shortest recording worth transcribing, in seconds. */
export const MIN_AUDIO_SECONDS = 0.3;
const SAMPLE_RATE = 16_000;
const DECODE_TIMEOUT_MS = 60_000;
const AFCONVERT = "/usr/bin/afconvert";
/** The model omp dictates with when the `dictation` role names no local one (`src/priority.json`). */
const DEFAULT_MODEL_KEY = "parakeet-tdt-0.6b-v3";
const NOT_SET_UP = "Voice input is not set up on this computer yet.";

/** Recording formats the browsers produce (`MediaRecorder` on iOS Safari, Chrome, Firefox); `afconvert` cannot read webm or ogg. */
const FORMATS: Record<string, Format> = {
	"audio/mp4": { ext: "m4a", afconvert: true },
	"audio/x-m4a": { ext: "m4a", afconvert: true },
	"audio/aac": { ext: "aac", afconvert: true },
	"audio/mpeg": { ext: "mp3", afconvert: true },
	"audio/wav": { ext: "wav", afconvert: true },
	"audio/x-wav": { ext: "wav", afconvert: true },
	"audio/webm": { ext: "webm", afconvert: false },
	"audio/ogg": { ext: "ogg", afconvert: false },
};

/** @throws Error for a MIME type that is not a recording format (`;codecs=...` parameters are ignored). */
export function checkMimeType(value: unknown): Format {
	const type = typeof value === "string" ? value.split(";")[0]!.trim().toLowerCase() : "";
	if (!Object.hasOwn(FORMATS, type)) throw new Error("Unsupported audio format.");
	return FORMATS[type]!;
}

/**
 * The speech model to use given the contents of omp's `config.yml`: the local model of the `dictation` role
 * (`local/<key>`) when it names a known one, else omp's default dictation model. Cloud models are not supported.
 */
export function dictationModelKey(configText: string | null, isModelKey: (value: string) => boolean): string {
	let role: unknown;
	try {
		const config =
			configText === null ? null : (Bun.YAML.parse(configText) as { modelRoles?: Record<string, unknown> } | null);
		role = config?.modelRoles?.dictation;
	} catch {
		return DEFAULT_MODEL_KEY;
	}
	if (typeof role !== "string" || !role.startsWith("local/")) return DEFAULT_MODEL_KEY;
	const key = role.slice("local/".length);
	return isModelKey(key) ? key : DEFAULT_MODEL_KEY;
}

/**
 * The samples of a mono 16 kHz 32-bit float WAV file, as `afconvert` writes it. Walks the RIFF chunks rather
 * than assuming a 44-byte header: `afconvert` adds chunks (`FLLR`, `chna`, ...) before `data`.
 * @throws Error when the file is not such a WAV.
 */
export function parseFloatWav(bytes: Uint8Array): Float32Array {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
	if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("decoder output is not a WAV file");
	let format = false;
	for (let at = 12; at + 8 <= bytes.length;) {
		const id = tag(at);
		const size = view.getUint32(at + 4, true);
		const body = at + 8;
		if (id === "fmt ") {
			if (body + 18 > bytes.length) break;
			const code = view.getUint16(body, true);
			// WAVE_FORMAT_EXTENSIBLE carries the real format code first in its sub-format GUID.
			const float =
				code === 3 || (code === 0xfffe && body + 26 <= bytes.length && view.getUint16(body + 24, true) === 3);
			if (
				!float ||
				view.getUint16(body + 2, true) !== 1 ||
				view.getUint32(body + 4, true) !== SAMPLE_RATE ||
				view.getUint16(body + 14, true) !== 32
			)
				throw new Error("decoder output is not 16 kHz mono float audio");
			format = true;
		} else if (id === "data") {
			if (!format) throw new Error("decoder output has no format chunk");
			// A streamed file leaves the size 0 or 0xFFFFFFFF: the data then runs to the end.
			const end = size === 0 || body + size > bytes.length ? bytes.length : body + size;
			// Copied: the samples are not 4-byte aligned in the file.
			return new Float32Array(bytes.slice(body, body + Math.floor((end - body) / 4) * 4).buffer);
		}
		at = body + size + (size & 1);
	}
	throw new Error("decoder output has no audio data");
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

async function run(command: string[]): Promise<void> {
	const proc = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: DECODE_TIMEOUT_MS });
	const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) throw new Error(`${path.basename(command[0]!)} exited with ${code}: ${stderr.trim().slice(-300)}`);
}

interface Decoders {
	/** macOS `afconvert` is installed. */
	afconvert: boolean;
	/** Path of `ffmpeg`, when installed. */
	ffmpeg: string | null;
}

interface Format {
	ext: string;
	afconvert: boolean;
}

async function findDecoders(): Promise<Decoders> {
	const afconvert = await fs.access(AFCONVERT).then(
		() => true,
		() => false,
	);
	return { afconvert, ffmpeg: Bun.which("ffmpeg") };
}

interface SttModules {
	asr: typeof AsrClient;
	downloader: typeof Downloader;
	models: typeof Models;
}

/** What voice input runs on, once the speech modules loaded and a decoder exists. */
interface Capability {
	modules: SttModules;
	decoders: Decoders;
}

export interface Voice {
	/** What the computer can transcribe with; null when it cannot. Cheap: only the model cache is checked per call. */
	info(): Promise<TranscribeInfo | null>;
	/** @throws Error with a message fit for the device. */
	transcribe(base64: string, mimeType: string): Promise<string>;
	/** Download the speech model; concurrent calls share one download. */
	setup(): Promise<void>;
	/** Stop the speech worker. */
	close(): Promise<void>;
}

/** @param configPath omp's `config.yml`, which names the model the `dictation` role dictates with. */
export function createVoice(configPath: string): Voice {
	let capability: Promise<Capability | null> | undefined;
	let loaded: SttModules | null = null;
	let setupRun: Promise<void> | null = null;

	function capable(): Promise<Capability | null> {
		capability ??= (async () => {
			let modules: SttModules;
			try {
				// Dynamic on purpose: the module graph is large and a checkout where it does not load must still run
				// the companion, without voice input.
				const [asr, downloader, models] = await Promise.all([
					import("@oh-my-pi/pi-coding-agent/stt/asr-client"),
					import("@oh-my-pi/pi-coding-agent/stt/downloader"),
					import("@oh-my-pi/pi-coding-agent/stt/models"),
				]);
				modules = { asr, downloader, models };
			} catch (err) {
				console.error(`companion: voice input unavailable: ${errorText(err)}`);
				return null;
			}
			const decoders = await findDecoders();
			if (!decoders.afconvert && decoders.ffmpeg === null) {
				console.error("companion: voice input unavailable: neither afconvert nor ffmpeg found");
				return null;
			}
			loaded = modules;
			return { modules, decoders };
		})();
		return capability;
	}

	async function modelKey(modules: SttModules): Promise<string> {
		const text = await Bun.file(configPath)
			.text()
			.catch(() => null);
		return dictationModelKey(text, modules.models.isSttModelKey);
	}

	async function decode(base64: string, format: Format, decoders: Decoders): Promise<Float32Array> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-voice-"));
		try {
			const input = path.join(dir, `in.${format.ext}`);
			await fs.writeFile(input, Buffer.from(base64, "base64"));
			const failures: string[] = [];
			if (decoders.afconvert && format.afconvert) {
				const output = path.join(dir, "out.wav");
				try {
					await run([AFCONVERT, "-f", "WAVE", "-d", `LEF32@${SAMPLE_RATE}`, "-c", "1", input, output]);
					return parseFloatWav(new Uint8Array(await Bun.file(output).arrayBuffer()));
				} catch (err) {
					failures.push(errorText(err));
				}
			}
			if (decoders.ffmpeg !== null) {
				const output = path.join(dir, "out.f32");
				try {
					// One second more than the limit: a longer recording still reads as too long.
					const limit = String(MAX_AUDIO_SECONDS + 1);
					await run([
						decoders.ffmpeg,
						"-nostdin",
						"-v",
						"error",
						"-t",
						limit,
						"-i",
						input,
						"-ac",
						"1",
						"-ar",
						String(SAMPLE_RATE),
						"-f",
						"f32le",
						output,
					]);
					// Raw little-endian floats; copied, as the buffer of a read file is not a multiple of four bytes.
					const bytes = new Uint8Array(await Bun.file(output).arrayBuffer());
					return new Float32Array(bytes.slice(0, Math.floor(bytes.length / 4) * 4).buffer);
				} catch (err) {
					failures.push(errorText(err));
				}
			}
			if (failures.length === 0) throw new Error("This recording format needs ffmpeg on the computer.");
			console.error(`companion: decoding a recording failed: ${failures.join("; ")}`);
			throw new Error("The recording could not be decoded.");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	}

	return {
		async info() {
			const cap = await capable();
			if (cap === null) return null;
			const { models, downloader } = cap.modules;
			const key = await modelKey(cap.modules);
			const spec = models.resolveSttModelSpec(key);
			return { model: spec.label, size: spec.sizeHint, ready: await downloader.isSttModelCached(key) };
		},

		async transcribe(base64, mimeType) {
			const format = checkMimeType(mimeType);
			if (typeof base64 !== "string" || base64.length > MAX_AUDIO_BASE64_CHARS)
				throw new Error("The recording is too large.");
			if (base64 === "") throw new Error("Nothing was recorded.");
			const cap = await capable();
			if (cap === null) throw new Error("Voice input is not available on this computer.");
			const key = await modelKey(cap.modules);
			if (!(await cap.modules.downloader.isSttModelCached(key))) throw new Error(NOT_SET_UP);
			const samples = await decode(base64, format, cap.decoders);
			if (samples.length < MIN_AUDIO_SECONDS * SAMPLE_RATE) throw new Error("Nothing was recorded.");
			if (samples.length > MAX_AUDIO_SECONDS * SAMPLE_RATE) throw new Error("The recording is too long.");
			const text = (await cap.modules.asr.sttClient.transcribe(key, samples)).trim();
			if (text === "") throw new Error("No speech was recognized.");
			return text;
		},

		setup() {
			setupRun ??= (async () => {
				const cap = await capable();
				if (cap === null) throw new Error("Voice input is not available on this computer.");
				await cap.modules.downloader.downloadSttModel(await modelKey(cap.modules));
			})().finally(() => {
				setupRun = null;
			});
			return setupRun;
		},

		async close() {
			await loaded?.asr.shutdownSttClient();
		},
	};
}
