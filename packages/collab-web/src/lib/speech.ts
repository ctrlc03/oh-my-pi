/**
 * Hands-free mode, speaking side: turns a Markdown reply into text worth listening to and reads it
 * with the device's `speechSynthesis`. The text preparation, voice choice and chunking are pure
 * (and tested); the thin engine at the bottom is the only part that touches the browser.
 */

import type { CollabUiRequest, SessionEntry } from "@oh-my-pi/pi-wire";
import { replyText, turnRanges } from "./export";
import { readJson, writeJson } from "./storage";

/** A spoken reply stops here; the rest stays on screen. */
export const SPEECH_LIMIT = 1500;
const CODE_OMITTED = "Code block omitted.";
const TABLE_OMITTED = "Table omitted.";
const REST_ON_SCREEN = "The rest is on screen.";
const TERMINAL = /[.!?…:;。！？]$/;

const FENCE = /^\s*(`{3,}|~{3,})/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const THEMATIC_BREAK = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/;
const LINK_DEFINITION = /^\s{0,3}\[[^\]]+\]:\s+\S+/;

/** The host a URL points at, `www.` dropped; null when it does not parse. */
function hostOf(url: string): string | null {
	try {
		return new URL(url).hostname.replace(/^www\./, "") || null;
	} catch {
		return null;
	}
}

/** One line of inline Markdown as it should be heard: link text and hosts, no syntax. */
function inline(line: string): string {
	let text = line
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt: string) => alt.trim() || "image")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
		.replace(/<(https?:[^>\s]+)>/g, "$1")
		.replace(/https?:\/\/[^\s<>]+/g, url => {
			// Sentence punctuation and closing brackets after a URL belong to the sentence, not the address.
			const trimmed = url.replace(/[)\].,;:!?'"]+$/, "");
			const host = hostOf(trimmed);
			return host === null ? "" : host + url.slice(trimmed.length);
		})
		.replace(/`+([^`]+)`+/g, "$1")
		.replace(
			/\*\*\*([^*]+)\*\*\*|\*\*([^*]+)\*\*/g,
			(_, a: string | undefined, b: string | undefined) => a ?? b ?? "",
		)
		.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?![*\w])/g, "$1$2")
		.replace(/(^|\W)__([^_]+)__(?=\W|$)/g, "$1$2")
		.replace(/(^|\W)_([^_\s][^_]*?)_(?=\W|$)/g, "$1$2")
		.replace(/~~([^~]+)~~/g, "$1")
		.replace(/<\/?[a-zA-Z][^>]*>/g, "")
		.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1");
	text = text.replace(/\s+/g, " ").trim();
	return text;
}

/** `text` with a closing full stop, so the voice pauses at the end of a list item or heading. */
function sentence(text: string): string {
	return TERMINAL.test(text) ? text : `${text}.`;
}

/**
 * Prose out of Markdown: code blocks become "code block omitted", tables "table omitted", links
 * their text, bare URLs their host, and emphasis, headings, quotes and list markers disappear.
 * Long text is cut at a sentence near {@link SPEECH_LIMIT} and ends "the rest is on screen".
 * Returns "" when nothing speakable is left.
 */
export function speakableText(markdown: string): string {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	const paragraphs: string[] = [];
	let current: string[] = [];
	const flush = (): void => {
		if (current.length > 0) paragraphs.push(current.join(" "));
		current = [];
	};
	/** A marker for a block that is not read; consecutive ones say it once. */
	const omit = (marker: string): void => {
		flush();
		if (paragraphs.at(-1) !== marker) paragraphs.push(marker);
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const fence = FENCE.exec(line);
		if (fence) {
			const mark = fence[1]!;
			const closing = new RegExp(`^\\s*${mark[0] === "`" ? "`" : "~"}{${mark.length},}\\s*$`);
			i++;
			while (i < lines.length && !closing.test(lines[i]!)) i++;
			omit(CODE_OMITTED);
			continue;
		}
		if (line.includes("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]!) && lines[i + 1]!.includes("-")) {
			i++;
			while (i + 1 < lines.length && lines[i + 1]!.trim() !== "" && lines[i + 1]!.includes("|")) i++;
			omit(TABLE_OMITTED);
			continue;
		}
		if (line.trim() === "") {
			flush();
			continue;
		}
		if (THEMATIC_BREAK.test(line) || LINK_DEFINITION.test(line) || /^\s*=+\s*$/.test(line)) continue;

		const unquoted = line.replace(/^\s*(?:>\s?)+/, "");
		const heading = HEADING.exec(unquoted);
		if (heading) {
			const text = inline(heading[1]!);
			if (text) {
				flush();
				paragraphs.push(sentence(text));
			}
			continue;
		}
		if (LIST_ITEM.test(unquoted)) {
			const text = inline(unquoted.replace(LIST_ITEM, ""));
			if (text) {
				flush();
				paragraphs.push(sentence(text));
			}
			continue;
		}
		const text = inline(unquoted);
		if (text) current.push(text);
	}
	flush();
	return capSpeech(paragraphs.join("\n"));
}

/** `text` cut to {@link SPEECH_LIMIT} at the last sentence (else word) boundary, with the pointer to the screen. */
export function capSpeech(text: string): string {
	if (text.length <= SPEECH_LIMIT) return text;
	const head = text.slice(0, SPEECH_LIMIT);
	const stop = Math.max(
		head.lastIndexOf(". "),
		head.lastIndexOf("! "),
		head.lastIndexOf("? "),
		head.lastIndexOf("\n"),
	);
	const space = head.lastIndexOf(" ");
	const cut = stop > SPEECH_LIMIT / 2 ? stop + 1 : space > 0 ? space : SPEECH_LIMIT;
	return `${sentence(head.slice(0, cut).trimEnd())} ${REST_ON_SCREEN}`;
}

/** What a pending `ask` sounds like: the question, then its numbered options. */
export function askSpeech(request: CollabUiRequest): string {
	const title = speakableText(request.title).replace(/\n/g, " ");
	if (request.kind !== "select") return capSpeech(title);
	const options = request.options.map((option, i) => {
		const label = speakableText(typeof option === "string" ? option : option.label).replace(/\n/g, " ");
		return `${i + 1}, ${label}`;
	});
	return capSpeech(options.length === 0 ? title : [sentence(title), "Options:", ...options.map(sentence)].join("\n"));
}

/**
 * The reply of the latest turn: every assistant text since the last prompt. `id` is the entry that
 * ends it, so a new reply is a new id. Null while the turn has said nothing.
 */
export function latestReply(entries: readonly SessionEntry[]): { id: string; markdown: string } | null {
	const turn = turnRanges(entries).at(-1);
	if (turn === undefined) return null;
	const slice = entries.slice(turn.from, turn.to);
	for (let i = slice.length - 1; i >= 0; i--) {
		const entry = slice[i]!;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		if (!entry.message.content.some(block => block.type === "text" && block.text.trim() !== "")) continue;
		return { id: entry.id, markdown: replyText(slice) };
	}
	return null;
}

/**
 * Sentences grouped into pieces of at most `max` characters: engines drop or stall on one long
 * utterance (Chrome cuts out after about fifteen seconds), and pieces give the voice natural pauses.
 */
export function speechChunks(text: string, max = 220): string[] {
	const chunks: string[] = [];
	for (const paragraph of text.split("\n")) {
		let chunk = "";
		const push = (): void => {
			if (chunk.trim()) chunks.push(chunk.trim());
			chunk = "";
		};
		for (const part of paragraph.match(/[^.!?。！？]+[.!?。！？]+["')\]]*\s*|[^.!?。！？]+$/g) ?? []) {
			if (part.length > max) {
				push();
				let rest = part;
				while (rest.length > max) {
					const at = rest.lastIndexOf(" ", max);
					const cut = at > 0 ? at : max;
					chunks.push(rest.slice(0, cut).trim());
					rest = rest.slice(cut);
				}
				chunk = rest;
			} else if (chunk.length + part.length > max) {
				push();
				chunk = part;
			} else {
				chunk += part;
			}
		}
		push();
	}
	return chunks.filter(Boolean);
}

export interface VoiceLike {
	name: string;
	lang: string;
	default: boolean;
	localService: boolean;
}

/** Joke voices that ship with macOS and iOS; never the one anyone wants a reply read in. */
const NOVELTY =
	/^(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|deranged|hysterical|fred|junior|ralph|kathy)\b/i;
const NATURAL = /enhanced|premium|natural|neural|siri/i;

const normalizeLang = (lang: string): string => lang.toLowerCase().replace("_", "-");

/**
 * The most natural installed voice for `lang` (a BCP-47 tag): same region beats same language, and
 * enhanced/neural voices beat compact ones. Null when none speaks the language; the engine then
 * picks one from the utterance's language.
 */
export function pickVoice<T extends VoiceLike>(voices: readonly T[], lang: string): T | null {
	const wanted = normalizeLang(lang);
	const primary = wanted.split("-")[0]!;
	let best: T | null = null;
	let bestScore = 0;
	for (const voice of voices) {
		const have = normalizeLang(voice.lang);
		let score = have === wanted ? 100 : have.split("-")[0] === primary ? 60 : 0;
		if (score === 0) continue;
		if (NOVELTY.test(voice.name)) score -= 200;
		if (NATURAL.test(voice.name)) score += 30;
		else if (/google/i.test(voice.name)) score += 15;
		if (voice.default) score += 10;
		if (voice.localService) score += 5;
		if (score > bestScore) {
			best = voice;
			bestScore = score;
		}
	}
	return best;
}

/** Speaking speeds offered in the app. */
export const SPEECH_RATES = [1, 1.25, 1.5] as const;
export type SpeechRate = (typeof SPEECH_RATES)[number];
const RATE_KEY = "omp-collab-speech-rate";

/** The speed remembered on this device. */
export function storedRate(): SpeechRate {
	const raw = readJson(RATE_KEY);
	return SPEECH_RATES.find(rate => rate === raw) ?? 1;
}

export function storeRate(rate: SpeechRate): void {
	writeJson(RATE_KEY, rate);
}

// ---- silence detection (pure; the engine below feeds it microphone levels) ----

export interface SilenceConfig {
	/** RMS (0..1) at or above which a sample counts as speech. */
	threshold: number;
	/** Loud for this long before it counts as speech, so a click or cough does not. */
	minSpeechMs: number;
	/** Quiet this long after speech ends the recording. */
	silenceMs: number;
	/** Nobody spoke within this long: give up listening. */
	noSpeechMs: number;
	/** The longest an utterance is recorded. */
	maxMs: number;
}

export const SILENCE_DEFAULTS: SilenceConfig = {
	threshold: 0.02,
	minSpeechMs: 200,
	silenceMs: 1500,
	noSpeechMs: 8000,
	maxMs: 60_000,
};

/** `stop`: transcribe what was said; `no-speech`: nothing was said, discard and stop listening. */
export type SilenceVerdict = "listening" | "stop" | "no-speech";

/** Root-mean-square level of a block of samples in -1..1. */
export function rmsOf(samples: ArrayLike<number>): number {
	if (samples.length === 0) return 0;
	let sum = 0;
	for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
	return Math.sqrt(sum / samples.length);
}

/**
 * Decides when an utterance is over. Feed it one RMS level per tick with a monotonic clock in ms;
 * the first call starts the clock.
 */
export function createSilenceDetector(config: SilenceConfig = SILENCE_DEFAULTS): {
	push(rms: number, now: number): SilenceVerdict;
} {
	let startedAt: number | null = null;
	let loudSince: number | null = null;
	let quietSince: number | null = null;
	let heard = false;
	return {
		push(rms, now) {
			startedAt ??= now;
			if (rms >= config.threshold) {
				loudSince ??= now;
				quietSince = null;
				if (now - loudSince >= config.minSpeechMs) heard = true;
			} else {
				loudSince = null;
				if (heard) quietSince ??= now;
			}
			if (heard) {
				if (now - startedAt >= config.maxMs) return "stop";
				if (quietSince !== null && now - quietSince >= config.silenceMs) return "stop";
				return "listening";
			}
			// A voice just starting at the deadline gets its minimum span to count.
			return loudSince === null && now - startedAt >= config.noSpeechMs ? "no-speech" : "listening";
		},
	};
}

// ---- engine (browser only) ----

export function speechAvailable(): boolean {
	return typeof speechSynthesis !== "undefined" && typeof SpeechSynthesisUtterance !== "undefined";
}

/**
 * Unlocks speech for later, script-started playback. iOS only starts `speechSynthesis` from a user
 * gesture the first time, so the hands-free toggle calls this from its tap handler.
 */
export function primeSpeech(): void {
	if (!speechAvailable()) return;
	const utterance = new SpeechSynthesisUtterance(" ");
	utterance.volume = 0;
	speechSynthesis.speak(utterance);
	// Voices load lazily; asking now has them ready for the first reply.
	speechSynthesis.getVoices();
}

/** Characters per second an engine speaks at 1.0×, roughly; only sizes the watchdog. */
const WATCHDOG_MS_PER_CHAR = 130;
const WATCHDOG_SLACK_MS = 10_000;

/**
 * Reads `text` aloud at `rate` in the document's language. `onEnd` runs once when it finishes or
 * fails (never after the returned `cancel`, which silences it at once). A watchdog ends playback
 * an engine never reports done, as iOS sometimes does.
 */
export function speak(text: string, rate: SpeechRate, onEnd: () => void): () => void {
	if (!speechAvailable() || text.trim() === "") {
		queueMicrotask(onEnd);
		return () => {};
	}
	const lang = document.documentElement.lang || navigator.language || "en";
	const voice = pickVoice(speechSynthesis.getVoices(), lang);
	const chunks = speechChunks(text);
	let done = false;
	const finish = (): void => {
		if (done) return;
		done = true;
		clearTimeout(watchdog);
		onEnd();
	};
	const watchdog = setTimeout(
		() => {
			speechSynthesis.cancel();
			finish();
		},
		(text.length * WATCHDOG_MS_PER_CHAR) / rate + WATCHDOG_SLACK_MS,
	);
	// The engine drops utterances nothing references (a Chrome bug), so `utterances` stays alive until the end.
	const utterances = chunks.map((chunk, i) => {
		const utterance = new SpeechSynthesisUtterance(chunk);
		utterance.rate = rate;
		utterance.lang = voice?.lang ?? lang;
		if (voice) utterance.voice = voice;
		if (i === chunks.length - 1) utterance.onend = finish;
		utterance.onerror = finish;
		return utterance;
	});
	speechSynthesis.cancel();
	for (const utterance of utterances) speechSynthesis.speak(utterance);
	return () => {
		if (done) return;
		done = true;
		clearTimeout(watchdog);
		utterances.length = 0;
		speechSynthesis.cancel();
	};
}
