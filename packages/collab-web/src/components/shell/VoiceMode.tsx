import type { CollabUiRequest } from "@oh-my-pi/pi-wire";
import { Headphones } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { GuestClient } from "../../lib/client";
import {
	askSpeech,
	createSilenceDetector,
	latestReply,
	primeSpeech,
	rmsOf,
	speak,
	speakableText,
	speechAvailable,
	useSpeechRate,
} from "../../lib/speech";
import { NO_SPEECH, type VoiceInput } from "./VoiceInput";
import "./voice-mode.css";

/** How long a transcription waits for Cancel before it is sent. */
const COUNTDOWN_MS = 1500;
/** A finished turn whose reply entry has not landed yet gets this long before it counts as silent. */
const REPLY_GRACE_MS = 600;

export interface HandsFreeOptions {
	client: GuestClient;
	input: VoiceInput;
	/** Voice input is offered and this guest may prompt (never a view-only link). */
	enabled: boolean;
	uiRequest: CollabUiRequest | null;
	working: boolean;
	/** Set while hands-free is on: takes a transcription and returns true when it will be sent. */
	interceptRef: RefObject<((text: string) => boolean) | null>;
	onSend(text: string): void;
	/** Puts a transcription into the draft instead (a cancelled countdown). */
	onDraft(text: string): void;
}

export interface HandsFree {
	/** The headphones toggle for the composer's action row; null where speech is unavailable. */
	button: ReactNode;
	/** The line above the composer: reading, countdown, or paused; null while the mic status says it all. */
	status: ReactNode;
}

/**
 * Hands-free mode: each finished reply is read aloud, then the microphone opens; the transcription
 * is sent after a short countdown. The agent's turn, not the user, sets the rhythm, so listening
 * pauses while it works. All timing lives here; the mic itself is the composer's {@link VoiceInput}.
 */
export function useHandsFree({
	client,
	input,
	enabled,
	uiRequest,
	working,
	interceptRef,
	onSend,
	onDraft,
}: HandsFreeOptions): HandsFree {
	const available = enabled && speechAvailable();
	const [on, setOn] = useState(false);
	const active = on && available;
	const [speaking, setSpeaking] = useState(false);
	const [countdown, setCountdown] = useState<string | null>(null);
	const rate = useSpeechRate();

	const live = useRef({ input, uiRequest, working, onSend, onDraft, rate, available });
	live.current = { input, uiRequest, working, onSend, onDraft, rate, available };
	const stopSpeechRef = useRef<(() => void) | null>(null);
	const countdownRef = useRef<{ text: string; timer: Timer } | null>(null);
	/** The id of the last reply handed to the voice (or skipped), so none is read twice. */
	const spokenRef = useRef("");
	/** A turn started while hands-free was on, so its reply is still to be read. */
	const turnPendingRef = useRef(false);
	const wasWorkingRef = useRef(false);
	const askSpokenRef = useRef<number | null>(null);
	/** The microphone was still starting when hands-free turned off: stop it as soon as it opens. */
	const cancelOnOpenRef = useRef(false);
	/** Recordings in a row that held no words; one is retried, then listening waits for a tap. */
	const emptyRetriesRef = useRef(0);
	const prevStepRef = useRef(input.step);
	/** One audio context for every recording: created in the toggle tap, the only moment iOS lets one run. */
	const audioRef = useRef<AudioContext | null>(null);
	/** This recording is not metered (no running audio context), so it needs a tap to stop. */
	const [manualStop, setManualStop] = useState(false);

	const replyCache = useRef<{ entries: unknown; id: string } | null>(null);
	const readReplyKey = useCallback((): string => {
		const { entries } = client.getSnapshot();
		const cached = replyCache.current;
		if (cached !== null && cached.entries === entries) return cached.id;
		const id = latestReply(entries)?.id ?? "";
		replyCache.current = { entries, id };
		return id;
	}, [client]);
	// The server snapshot is the same getter: static rendering (tests) reads the client as is.
	const replyKey = useSyncExternalStore(
		useCallback(listener => client.subscribe(listener), [client]),
		readReplyKey,
		readReplyKey,
	);

	const stopSpeech = useCallback((): void => {
		stopSpeechRef.current?.();
		stopSpeechRef.current = null;
		setSpeaking(false);
	}, []);

	/** Ends a pending countdown; its text goes to the draft so nothing said is lost. */
	const abandonCountdown = useCallback((): void => {
		const pending = countdownRef.current;
		if (pending === null) return;
		clearTimeout(pending.timer);
		countdownRef.current = null;
		setCountdown(null);
		live.current.onDraft(pending.text);
	}, []);

	const openMic = useCallback((): void => {
		const l = live.current;
		if (l.working || l.uiRequest || l.input.step !== "idle") return;
		l.input.press();
	}, []);

	/** Opens the microphone when nothing else is going on, with a fresh retry allowance. */
	const listen = useCallback((): void => {
		emptyRetriesRef.current = 0;
		openMic();
	}, [openMic]);

	const say = useCallback(
		(text: string, then: () => void): void => {
			stopSpeech();
			setSpeaking(true);
			stopSpeechRef.current = speak(text, live.current.rate, () => {
				stopSpeechRef.current = null;
				setSpeaking(false);
				then();
			});
		},
		[stopSpeech],
	);

	/** Reads the latest turn's reply once; false when it has not arrived. */
	const readReply = useCallback((): boolean => {
		const reply = latestReply(client.getSnapshot().entries);
		if (reply === null || reply.id === spokenRef.current) return false;
		spokenRef.current = reply.id;
		turnPendingRef.current = false;
		const text = speakableText(reply.markdown);
		if (text === "") listen();
		else say(text, listen);
		return true;
	}, [client, listen, say]);

	const startCountdown = useCallback((text: string): void => {
		const timer = setTimeout(() => {
			countdownRef.current = null;
			setCountdown(null);
			live.current.onSend(text);
		}, COUNTDOWN_MS);
		countdownRef.current = { text, timer };
		setCountdown(text);
	}, []);

	// Turning on: stay quiet about replies already on screen, then listen. Turning off (or leaving
	// the room): silence, countdown and microphone stop at once.
	useEffect(() => {
		if (!active) return;
		spokenRef.current = latestReply(client.getSnapshot().entries)?.id ?? "";
		turnPendingRef.current = live.current.working;
		askSpokenRef.current = null;
		listen();
		return () => {
			stopSpeech();
			abandonCountdown();
			const micStep = live.current.input.step;
			if (micStep === "recording") live.current.input.cancel();
			else if (micStep === "starting") cancelOnOpenRef.current = true;
			void audioRef.current?.close();
			audioRef.current = null;
		};
	}, [active, client, listen, stopSpeech, abandonCountdown]);

	const { step, cancel } = input;
	useEffect(() => {
		if (cancelOnOpenRef.current && step === "recording") {
			cancelOnOpenRef.current = false;
			cancel();
		} else if (step === "idle") {
			cancelOnOpenRef.current = false;
		}
	}, [step, cancel]);

	// A recording with no words in it is retried once; the second empty one leaves "Tap to listen".
	const { error, stream } = input;
	useEffect(() => {
		const was = prevStepRef.current;
		prevStepRef.current = step;
		if (!active || was !== "transcribing" || step !== "idle" || error !== NO_SPEECH) return;
		if (emptyRetriesRef.current >= 1) return;
		emptyRetriesRef.current++;
		openMic();
	}, [active, step, error, openMic]);

	// No tap to stop: the level of the microphone ends the recording after speech goes quiet, and a
	// recording nobody speaks into is dropped. Without a running audio context the level reads zero,
	// which would pass for silence, so such a recording is left to a tap instead.
	useEffect(() => {
		setManualStop(false);
		if (!active || step !== "recording" || stream === null) return;
		let context = audioRef.current;
		if (context === null) {
			try {
				context = new AudioContext();
			} catch {
				setManualStop(true);
				return;
			}
			audioRef.current = context;
		}
		const audio = context;
		let cancelled = false;
		let stopMetering = (): void => {};
		void (async () => {
			// The tap's resume is usually done by now; give a slow one a moment.
			if (audio.state !== "running") {
				const { promise: grace, resolve } = Promise.withResolvers<void>();
				setTimeout(resolve, 300);
				await Promise.race([audio.resume().catch(() => {}), grace]);
			}
			if (cancelled) return;
			if (audio.state !== "running") {
				setManualStop(true);
				return;
			}
			const source = audio.createMediaStreamSource(stream);
			const analyser = audio.createAnalyser();
			analyser.fftSize = 1024;
			source.connect(analyser);
			const samples = new Float32Array(analyser.fftSize);
			const detector = createSilenceDetector();
			const timer = setInterval(() => {
				analyser.getFloatTimeDomainData(samples);
				const verdict = detector.push(rmsOf(samples), performance.now());
				if (verdict === "listening") return;
				clearInterval(timer);
				if (verdict === "stop") live.current.input.press();
				else live.current.input.cancel();
			}, 100);
			stopMetering = () => {
				clearInterval(timer);
				source.disconnect();
			};
		})();
		return () => {
			cancelled = true;
			stopMetering();
		};
	}, [active, step, stream]);

	// The agent's turn: pause when it starts, read the reply when it ends.
	useEffect(() => {
		if (!active) return;
		if (working) {
			if (!wasWorkingRef.current) {
				wasWorkingRef.current = true;
				turnPendingRef.current = true;
				stopSpeech();
				abandonCountdown();
				const micStep = live.current.input.step;
				if (micStep === "recording") live.current.input.cancel();
				else if (micStep === "starting") cancelOnOpenRef.current = true;
			}
			return;
		}
		wasWorkingRef.current = false;
		if (!turnPendingRef.current || readReply()) return;
		// The turn said nothing, or its reply entry is a moment behind the end of the turn.
		const timer = setTimeout(() => {
			turnPendingRef.current = false;
			listen();
		}, REPLY_GRACE_MS);
		return () => clearTimeout(timer);
	}, [active, working, replyKey, stopSpeech, abandonCountdown, readReply, listen]);

	// A question from the agent is read once, with its options; answering stays a tap.
	const askId = uiRequest?.reqId ?? null;
	useEffect(() => {
		const request = live.current.uiRequest;
		if (!active || request === null || askId === askSpokenRef.current) return;
		askSpokenRef.current = askId;
		const micStep = live.current.input.step;
		if (micStep === "recording") live.current.input.cancel();
		say(askSpeech(request), () => {});
	}, [active, askId, say]);

	// Tapping the mic while the voice is talking means: stop talking.
	useEffect(() => {
		if (active && speaking && step !== "idle") stopSpeech();
	}, [active, speaking, step, stopSpeech]);

	useEffect(() => {
		if (!active) return;
		interceptRef.current = text => {
			const l = live.current;
			if (!l.available || l.working) return false;
			emptyRetriesRef.current = 0;
			abandonCountdown();
			startCountdown(text);
			return true;
		};
		return () => {
			interceptRef.current = null;
		};
	}, [active, interceptRef, abandonCountdown, startCountdown]);

	const toggle = (): void => {
		// iOS lets speech start from script only once the page has spoken from a tap.
		if (!on) {
			primeSpeech();
			if (audioRef.current === null) {
				try {
					audioRef.current = new AudioContext();
				} catch {
					// No Web Audio: recordings are stopped by tap.
				}
			}
			void audioRef.current?.resume();
		}
		setOn(!on);
	};

	const button = available ? (
		<button
			type="button"
			className={`sh-btn sh-btn-icon sh-handsfree-btn${on ? " sh-handsfree-btn-on" : ""}`}
			onClick={toggle}
			aria-pressed={on}
			aria-label="Hands-free mode"
			title={
				on ? "Hands-free on: replies are read aloud, then it listens" : "Hands-free: read replies aloud and listen"
			}
		>
			<Headphones size={16} />
		</button>
	) : null;

	let label: string | null = null;
	let actions: ReactNode = null;
	if (countdown !== null) {
		label = `Sending: “${countdown.length > 120 ? `${countdown.slice(0, 120)}…` : countdown}”`;
		actions = (
			<button type="button" className="sh-btn" onClick={abandonCountdown}>
				Cancel
			</button>
		);
	} else if (speaking) {
		label = uiRequest ? "Reading the question…" : "Reading the reply…";
		actions = (
			<button
				type="button"
				className="sh-btn"
				onClick={() => {
					stopSpeech();
					listen();
				}}
			>
				Skip
			</button>
		);
	} else if (working) {
		label = uiRequest ? "Waiting for your answer" : "Listening paused — agent working";
	} else if (step === "recording" && manualStop) {
		label = "Tap stop when done";
	} else if (step === "idle" && !uiRequest) {
		label = "Tap to listen";
		actions = (
			<button type="button" className="sh-btn" onClick={listen}>
				Listen
			</button>
		);
	}

	const status = active && label !== null && (
		<div className="sh-voice sh-handsfree" role="status">
			<Headphones size={14} className="sh-handsfree-icon" aria-hidden="true" />
			<span className="sh-voice-text">{label}</span>
			<span className="sh-voice-actions">{actions}</span>
			{countdown !== null && <span className="sh-handsfree-bar" aria-hidden="true" />}
		</div>
	);

	return { button, status: status || null };
}
