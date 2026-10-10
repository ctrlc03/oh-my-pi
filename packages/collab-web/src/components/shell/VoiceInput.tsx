import { LoaderCircle, Mic, Square, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CompanionClient, TranscribeInfo } from "../../lib/companion";
import { encodeRecording, formatElapsed, type Recording, startRecording } from "../../lib/voice";

/** What voice input needs from the paired computer. */
export interface VoiceSource {
	client: CompanionClient;
	info: TranscribeInfo;
	/** The computer's name, for the setup prompt. */
	machine: string | null;
}

type Step = "idle" | "confirm" | "downloading" | "starting" | "recording" | "transcribing";

export interface VoiceInput {
	step: Step;
	error: string | null;
	/** Whole seconds recorded so far. */
	elapsed: number;
	/** The mic button: asks for setup, starts recording, or stops it and transcribes. */
	press(): void;
	/** Drops the recording, or the setup prompt. */
	cancel(): void;
	/** Downloads the speech model on the computer. */
	download(): void;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Voice input state machine: setup prompt → recording → transcribing → `onText`. The text is
 * handed over, never sent; the caller decides where it lands.
 */
export function useVoiceInput(voice: VoiceSource | null, onText: (text: string) => void): VoiceInput {
	const [step, setStep] = useState<Step>("idle");
	const [error, setError] = useState<string | null>(null);
	const [startedAt, setStartedAt] = useState(0);
	const [elapsed, setElapsed] = useState(0);
	// The model was downloaded from here; the companion's next `hosts` broadcast confirms it.
	const [downloaded, setDownloaded] = useState(false);
	const recordingRef = useRef<Recording | null>(null);
	const aliveRef = useRef(true);
	const latest = useRef({ voice, onText });
	latest.current = { voice, onText };

	useEffect(() => {
		aliveRef.current = true;
		return () => {
			aliveRef.current = false;
			// Leaving the room mid-recording must release the microphone.
			recordingRef.current?.cancel();
			recordingRef.current = null;
		};
	}, []);

	useEffect(() => {
		if (step !== "recording") return;
		const tick = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 500);
		return () => clearInterval(tick);
	}, [step, startedAt]);

	const finish = useCallback(async (): Promise<void> => {
		const recording = recordingRef.current;
		if (!recording) return;
		recordingRef.current = null;
		setStep("transcribing");
		try {
			const blob = await recording.stop();
			const audio = await encodeRecording(blob);
			const current = latest.current.voice;
			if (!current) throw new Error("Your computer is offline.");
			const text = (await current.client.requestTranscribe(audio, blob.type || "application/octet-stream")).trim();
			if (!aliveRef.current) return;
			if (text === "") setError("No speech was detected.");
			else latest.current.onText(text);
		} catch (err) {
			if (aliveRef.current) setError(message(err));
		}
		if (aliveRef.current) setStep("idle");
	}, []);

	const begin = useCallback(async (): Promise<void> => {
		setStep("starting");
		try {
			const recording = await startRecording({ onEnd: () => void finish() });
			if (!aliveRef.current) {
				recording.cancel();
				return;
			}
			recordingRef.current = recording;
			setElapsed(0);
			setStartedAt(Date.now());
			setStep("recording");
		} catch (err) {
			if (!aliveRef.current) return;
			setError(message(err));
			setStep("idle");
		}
	}, [finish]);

	const press = useCallback((): void => {
		if (step === "recording") {
			void finish();
			return;
		}
		if (step === "confirm") {
			setStep("idle");
			return;
		}
		if (step !== "idle" || !latest.current.voice) return;
		setError(null);
		if (latest.current.voice.info.ready || downloaded) void begin();
		else setStep("confirm");
	}, [step, downloaded, begin, finish]);

	const cancel = useCallback((): void => {
		recordingRef.current?.cancel();
		recordingRef.current = null;
		setStep("idle");
	}, []);

	const download = useCallback((): void => {
		const current = latest.current.voice;
		if (!current) return;
		setError(null);
		setStep("downloading");
		current.client.requestTranscribeSetup().then(
			() => {
				if (!aliveRef.current) return;
				setDownloaded(true);
				setStep("idle");
			},
			(err: unknown) => {
				if (!aliveRef.current) return;
				setError(message(err));
				setStep("idle");
			},
		);
	}, []);

	return { step, error, elapsed, press, cancel, download };
}

export function VoiceButton({ input }: { input: VoiceInput }): ReactNode {
	const { step } = input;
	const recording = step === "recording";
	const working = step === "starting" || step === "downloading" || step === "transcribing";
	return (
		<button
			type="button"
			className={`sh-btn sh-btn-icon sh-voice-btn${recording ? " sh-voice-btn-rec" : ""}`}
			onClick={input.press}
			disabled={working}
			aria-label={recording ? "stop recording" : "voice input"}
			title={recording ? "stop and transcribe" : "voice input"}
		>
			{recording ? (
				<Square size={13} />
			) : working ? (
				<LoaderCircle size={16} className="sh-spin" />
			) : (
				<Mic size={16} />
			)}
		</button>
	);
}

/** The line above the composer that says what voice input is doing. */
export function VoiceStatus({ voice, input }: { voice: VoiceSource | null; input: VoiceInput }): ReactNode {
	const { step, error } = input;
	if (step === "confirm" && voice) {
		return (
			<div className="sh-voice" role="status">
				<span className="sh-voice-text">
					Voice input needs a one-time download of {voice.info.model} ({voice.info.size}) on{" "}
					{voice.machine ?? "your computer"}.
				</span>
				<span className="sh-voice-actions">
					<button type="button" className="sh-btn sh-btn-primary" onClick={input.download}>
						Download
					</button>
					<button type="button" className="sh-btn" onClick={input.cancel}>
						Cancel
					</button>
				</span>
			</div>
		);
	}
	if (step === "downloading" || step === "starting" || step === "transcribing") {
		const label =
			step === "downloading"
				? "Downloading on your computer…"
				: step === "starting"
					? "Starting the microphone…"
					: "Transcribing…";
		return (
			<div className="sh-voice" role="status">
				<LoaderCircle size={14} className="sh-spin" />
				<span className="sh-voice-text">{label}</span>
			</div>
		);
	}
	if (step === "recording") {
		return (
			<div className="sh-voice" role="status">
				<span className="sh-voice-dot" aria-hidden="true" />
				<span className="sh-voice-text">
					Recording <span className="sh-voice-time">{formatElapsed(input.elapsed)}</span>
				</span>
				<button
					type="button"
					className="sh-btn sh-btn-icon"
					onClick={input.cancel}
					aria-label="cancel recording"
					title="discard recording"
				>
					<X size={14} />
				</button>
			</div>
		);
	}
	if (error) {
		return (
			<div className="sh-voice sh-voice-error" role="alert">
				<span className="sh-voice-text">{error}</span>
			</div>
		);
	}
	return null;
}
