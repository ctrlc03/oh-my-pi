/**
 * Voice input, phone side: record the microphone with `MediaRecorder` and hand the bytes to the
 * paired computer, which transcribes them locally (see `CompanionClient.requestTranscribe`).
 *
 * iOS Safari and the home-screen PWA record `audio/mp4`; Chromium records `audio/webm`. The
 * companion's decoder sniffs the bytes, so the container is sent exactly as recorded.
 */

import { blobToBase64 } from "./images";

/** Recordings stop by themselves here; the companion rejects anything longer than 300 s. */
export const MAX_RECORDING_MS = 3 * 60_000;
/** The app refuses to send more audio than this (before base64). */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

/** Preferred containers, best first. */
const MIME_TYPES = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"] as const;

export interface Recording {
	/** Ends the recording and resolves with it; every call returns the same result. Rejects after `cancel` or a recorder failure. */
	stop(): Promise<Blob>;
	/** Discards the recording and releases the microphone. */
	cancel(): void;
}

export interface RecordingOptions {
	/** The recording ended without `stop`/`cancel`: the time limit, or the system took the microphone (a call, a revoked permission). `stop()` still yields what was captured. */
	onEnd(): void;
}

function micError(err: unknown): Error {
	const name = typeof err === "object" && err !== null && "name" in err ? String(err.name) : "";
	switch (name) {
		case "NotAllowedError":
		case "SecurityError":
			return new Error(
				"Microphone access is blocked. Allow the microphone for this app in your browser's site settings (iPhone: Settings → Safari → Microphone), then try again.",
			);
		case "NotFoundError":
		case "OverconstrainedError":
			return new Error("No microphone was found on this device.");
		case "NotReadableError":
		case "AbortError":
			return new Error("The microphone is busy: another app may be using it.");
		default:
			return new Error(`Could not start recording: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/**
 * Asks for the microphone and starts recording.
 * @throws Error with a user-facing message when recording is unsupported or the microphone is refused.
 */
export async function startRecording({ onEnd }: RecordingOptions): Promise<Recording> {
	if (!navigator.mediaDevices?.getUserMedia) {
		throw new Error("Voice input needs a secure connection (HTTPS) and a browser that can use the microphone.");
	}
	if (typeof MediaRecorder === "undefined") throw new Error("This browser cannot record audio.");

	let stream: MediaStream;
	try {
		stream = await navigator.mediaDevices.getUserMedia({
			audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
		});
	} catch (err) {
		throw micError(err);
	}
	const release = (): void => {
		for (const track of stream.getTracks()) track.stop();
	};

	const mimeType = MIME_TYPES.find(type => MediaRecorder.isTypeSupported(type));
	let recorder: MediaRecorder;
	try {
		recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
	} catch (err) {
		release();
		throw micError(err);
	}

	const chunks: Blob[] = [];
	const finished = Promise.withResolvers<Blob>();
	let requested = false;
	let cancelled = false;
	let failure: Error | null = null;
	const limit = setTimeout(() => {
		if (recorder.state !== "inactive") recorder.stop();
	}, MAX_RECORDING_MS);

	recorder.ondataavailable = e => {
		if (e.data.size > 0) chunks.push(e.data);
	};
	recorder.onerror = e => {
		failure = new Error(`Recording failed: ${(e as ErrorEvent).message || "the recorder stopped unexpectedly"}`);
		if (recorder.state !== "inactive") recorder.stop();
	};
	recorder.onstop = () => {
		clearTimeout(limit);
		release();
		finished.resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || "" }));
		if (!requested && !cancelled) onEnd();
	};
	recorder.start();

	return {
		stop() {
			if (cancelled) return Promise.reject(new Error("Recording was cancelled."));
			requested = true;
			if (recorder.state !== "inactive") recorder.stop();
			return finished.promise.then(blob => {
				if (failure) throw failure;
				return blob;
			});
		},
		cancel() {
			cancelled = true;
			clearTimeout(limit);
			if (recorder.state !== "inactive") recorder.stop();
			release();
		},
	};
}

/**
 * Base64 of a recording, ready for `requestTranscribe`.
 * @throws Error with a user-facing message for an empty or oversized recording.
 */
export async function encodeRecording(blob: Blob): Promise<string> {
	if (blob.size === 0) throw new Error("Nothing was recorded.");
	if (blob.size > MAX_AUDIO_BYTES) {
		throw new Error(`That recording is too large to send (${(blob.size / 1024 / 1024).toFixed(1)} MB, limit 8 MB).`);
	}
	return await blobToBase64(blob);
}

/**
 * Splices `insert` into `text` over `[start, end)` (clamped), adding a space on either side
 * where it would otherwise run into a neighbouring word. Returns the new text and the caret
 * position after the inserted words.
 */
export function insertAtCaret(
	text: string,
	insert: string,
	start: number,
	end: number,
): { text: string; caret: number } {
	const from = Math.min(Math.max(0, start), text.length);
	const to = Math.min(Math.max(from, end), text.length);
	const before = text.slice(0, from);
	const after = text.slice(to);
	const lead = before !== "" && !/\s$/.test(before) ? " " : "";
	const trail = after !== "" && !/^\s/.test(after) ? " " : "";
	const spliced = before + lead + insert;
	return { text: spliced + trail + after, caret: spliced.length };
}

/** `m:ss` for a whole number of seconds. */
export function formatElapsed(seconds: number): string {
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
