import { describe, expect, it } from "bun:test";
import type { CollabUiRequest, SessionEntry } from "@oh-my-pi/pi-wire";
import {
	askSpeech,
	createSilenceDetector,
	latestReply,
	pickVoice,
	rmsOf,
	SILENCE_DEFAULTS,
	SPEECH_LIMIT,
	speakableText,
	speechChunks,
	type VoiceLike,
} from "../src/lib/speech";

describe("speakableText", () => {
	it("omits code blocks, fenced or left open, saying so once", () => {
		const md = "Run this:\n\n```sh\nrm -rf /\n```\n\n~~~\nmore\n~~~\n\nThen it works.";
		expect(speakableText(md)).toBe("Run this:\nCode block omitted.\nThen it works.");
		expect(speakableText("Look:\n```ts\nconst a = 1;\nnever closed")).toBe("Look:\nCode block omitted.");
	});

	it("keeps a longer fence's inner fences out of the speech", () => {
		expect(speakableText("````md\n```\ninner\n```\n````\nDone.")).toBe("Code block omitted.\nDone.");
	});

	it("omits tables including their body rows", () => {
		const md = "Results:\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nAll green.";
		expect(speakableText(md)).toBe("Results:\nTable omitted.\nAll green.");
	});

	it("does not mistake a pipe in prose for a table", () => {
		expect(speakableText("Use a | b to pipe.")).toBe("Use a | b to pipe.");
	});

	it("speaks links by their text and bare URLs by host", () => {
		expect(speakableText("See [the docs](https://example.com/a/b?x=1) and https://www.github.com/o/r/pull/3.")).toBe(
			"See the docs and github.com.",
		);
		expect(speakableText("Open <https://my.omp.sh/#abc> now")).toBe("Open my.omp.sh now");
		expect(speakableText("![diagram](https://x.test/d.png) and ![](https://x.test/e.png)")).toBe("diagram and image");
	});

	it("strips markdown syntax but keeps snake_case and arithmetic", () => {
		const md = "# Title\n\nSome **bold**, *italic*, _more_ and `code` with a_b_c and 2 * 3 = 6.\n\n> quoted\n\n---";
		expect(speakableText(md)).toBe("Title.\nSome bold, italic, more and code with a_b_c and 2 * 3 = 6.\nquoted");
	});

	it("reads list items as separate sentences", () => {
		expect(speakableText("Steps:\n\n- one\n- [x] two\n3. three.")).toBe("Steps:\none.\ntwo.\nthree.");
	});

	it("joins a hard-wrapped paragraph", () => {
		expect(speakableText("first line\nsecond line\n\nnext")).toBe("first line second line\nnext");
	});

	it("cuts long text at a sentence and points at the screen", () => {
		const sentence = "This is a fairly ordinary sentence about nothing in particular. ";
		const spoken = speakableText(sentence.repeat(60));
		expect(spoken.endsWith("particular. The rest is on screen.")).toBe(true);
		expect(spoken.length).toBeLessThanOrEqual(SPEECH_LIMIT + " The rest is on screen.".length);
	});

	it("leaves text under the cap untouched and returns nothing for nothing", () => {
		expect(speakableText("Short and sweet.")).toBe("Short and sweet.");
		expect(speakableText("   \n\n")).toBe("");
		expect(speakableText("---\n[ref]: https://x.test")).toBe("");
	});
});

describe("askSpeech", () => {
	const base = { reqId: 1 };
	it("reads the question with numbered options", () => {
		const request: CollabUiRequest = {
			...base,
			kind: "select",
			title: "Which **branch**?",
			options: ["main", { label: "[feature](https://x.test)", description: "ignored" }],
		};
		expect(askSpeech(request)).toBe("Which branch?\nOptions:\n1, main.\n2, feature.");
	});

	it("reads an editor question without options", () => {
		expect(askSpeech({ ...base, kind: "editor", title: "Commit message" })).toBe("Commit message");
	});
});

describe("speechChunks", () => {
	it("groups sentences up to the limit and never splits mid-sentence when it fits", () => {
		const chunks = speechChunks("One two three. Four five six. Seven eight nine.", 20);
		expect(chunks).toEqual(["One two three.", "Four five six.", "Seven eight nine."]);
		expect(speechChunks("A. B. C.", 30)).toEqual(["A. B. C."]);
	});

	it("splits a sentence longer than the limit at spaces", () => {
		const long = Array.from({ length: 30 }, () => "word").join(" ");
		const chunks = speechChunks(long, 40);
		expect(chunks.length).toBeGreaterThan(2);
		expect(chunks.every(chunk => chunk.length <= 40)).toBe(true);
		expect(chunks.join(" ")).toBe(long);
	});

	it("keeps paragraph boundaries as chunk boundaries", () => {
		expect(speechChunks("Short one.\nShort two.")).toEqual(["Short one.", "Short two."]);
	});
});

describe("pickVoice", () => {
	const voice = (name: string, lang: string, extra: Partial<VoiceLike> = {}): VoiceLike => ({
		name,
		lang,
		default: false,
		localService: true,
		...extra,
	});

	it("prefers the exact region, then the language", () => {
		const voices = [voice("Daniel", "en-GB"), voice("Samantha", "en-US"), voice("Anna", "de-DE")];
		expect(pickVoice(voices, "en-US")?.name).toBe("Samantha");
		expect(pickVoice(voices, "en-AU")?.name).toBe("Daniel");
		expect(pickVoice(voices, "de")?.name).toBe("Anna");
	});

	it("prefers enhanced voices and never a novelty voice", () => {
		const voices = [
			voice("Fred", "en-US", { default: true }),
			voice("Samantha", "en-US"),
			voice("Ava (Enhanced)", "en-US"),
		];
		expect(pickVoice(voices, "en")?.name).toBe("Ava (Enhanced)");
		expect(pickVoice([voice("Zarvox", "en-US")], "en-US")).toBeNull();
		expect(pickVoice([voice("Zarvox", "en-US"), voice("Moira", "en-IE")], "en-US")?.name).toBe("Moira");
	});

	it("returns null when no voice speaks the language, and accepts underscore tags", () => {
		expect(pickVoice([voice("Anna", "de-DE")], "fr")).toBeNull();
		expect(pickVoice([voice("Samantha", "en_US")], "en-US")?.name).toBe("Samantha");
	});
});

describe("latestReply", () => {
	const prompt = (id: string): SessionEntry =>
		({ type: "message", id, message: { role: "user", content: "hi" } }) as unknown as SessionEntry;
	const reply = (id: string, ...blocks: unknown[]): SessionEntry =>
		({ type: "message", id, message: { role: "assistant", content: blocks } }) as unknown as SessionEntry;
	const text = (t: string) => ({ type: "text", text: t });
	const tool = { type: "toolCall", id: "t", name: "read", arguments: {} };

	it("joins the assistant text of the last turn and names its final reply", () => {
		const entries = [
			prompt("p1"),
			reply("a1", text("old")),
			prompt("p2"),
			reply("a2", text("Looking."), tool),
			reply("a3", text("Done.")),
		];
		expect(latestReply(entries)).toEqual({ id: "a3", markdown: "Looking.\n\nDone." });
	});

	it("is null until the new turn has said something", () => {
		expect(latestReply([prompt("p1"), reply("a1", text("old")), prompt("p2"), reply("a2", tool)])).toBeNull();
		expect(latestReply([])).toBeNull();
	});
});

describe("rmsOf", () => {
	it("measures level, not sign", () => {
		expect(rmsOf([])).toBe(0);
		expect(rmsOf([0.5, -0.5, 0.5, -0.5])).toBeCloseTo(0.5);
		expect(rmsOf(new Float32Array(100))).toBe(0);
	});
});

describe("createSilenceDetector", () => {
	const LOUD = 0.1;
	const QUIET = 0.001;
	/** Feeds one level every 100 ms from `from` to `to` (exclusive) and returns the first non-listening verdict with its time. */
	const run = (
		detector: ReturnType<typeof createSilenceDetector>,
		level: (t: number) => number,
		to: number,
		from = 0,
	): { verdict: string; at: number } => {
		for (let t = from; t < to; t += 100) {
			const verdict = detector.push(level(t), t);
			if (verdict !== "listening") return { verdict, at: t };
		}
		return { verdict: "listening", at: to };
	};

	it("stops 1.5 s after speech falls quiet", () => {
		const detector = createSilenceDetector();
		const result = run(detector, t => (t < 3000 ? LOUD : QUIET), 20_000);
		expect(result.verdict).toBe("stop");
		expect(result.at).toBe(3000 + SILENCE_DEFAULTS.silenceMs);
	});

	it("tolerates a pause shorter than the silence window", () => {
		const detector = createSilenceDetector();
		// speech, 1.0 s pause, speech again, then quiet
		const level = (t: number): number => (t < 2000 || (t >= 3000 && t < 5000) ? LOUD : QUIET);
		const result = run(detector, level, 20_000);
		expect(result.verdict).toBe("stop");
		expect(result.at).toBe(5000 + SILENCE_DEFAULTS.silenceMs);
	});

	it("gives up when nobody speaks within 8 s", () => {
		const result = run(createSilenceDetector(), () => QUIET, 20_000);
		expect(result).toEqual({ verdict: "no-speech", at: SILENCE_DEFAULTS.noSpeechMs });
	});

	it("does not count a click as speech", () => {
		const result = run(createSilenceDetector(), t => (t === 1000 ? LOUD : QUIET), 20_000);
		expect(result.verdict).toBe("no-speech");
	});

	it("keeps listening to speech that begins right at the deadline", () => {
		const level = (t: number): number => (t >= 7900 && t < 9000 ? LOUD : QUIET);
		const result = run(createSilenceDetector(), level, 20_000);
		expect(result.verdict).toBe("stop");
	});

	it("cuts continuous speech at the maximum", () => {
		const result = run(createSilenceDetector(), () => LOUD, 120_000);
		expect(result).toEqual({ verdict: "stop", at: SILENCE_DEFAULTS.maxMs });
	});

	it("measures time from the first sample, not from zero", () => {
		const result = run(createSilenceDetector(), () => QUIET, 100_000 + 20_000, 100_000);
		expect(result.at).toBe(100_000 + SILENCE_DEFAULTS.noSpeechMs);
	});
});
