import { describe, expect, it } from "bun:test";
import type { Quiz, QuizAnswerRecord, QuizQuestion } from "@oh-my-pi/pi-wire/quiz";
import { QUIZ_VERSION } from "@oh-my-pi/pi-wire/quiz";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestionView, type QuestionViewProps } from "../src/components/quiz/QuestionView";

const quiz: Quiz = {
	v: QUIZ_VERSION,
	id: "qz-topic",
	title: "notes · topic",
	repo: { root: "/work/notes", name: "notes" },
	createdAt: 1,
	about: "session",
	sessionId: "session-1",
	parts: [{ index: 0, title: "FHE statistics", head: { commit: "folder" } }],
	questions: [],
	warnings: [],
};

function question(extra: Partial<QuizQuestion>): QuizQuestion {
	return {
		id: "q1",
		part: 0,
		kind: "open",
		prompt: "Why was noise growth the limit?",
		topic: "Noise growth",
		refs: [],
		...extra,
	};
}

function render(
	q: QuizQuestion,
	over: Partial<QuestionViewProps> = {},
	record: QuizAnswerRecord | undefined = undefined,
): string {
	return renderToStaticMarkup(
		<QuestionView
			code={{ excerpts: async () => [], cache: new Map() }}
			quiz={quiz}
			question={q}
			position={{ part: 1, partCount: 1, question: 1, questionCount: 1 }}
			progress={{ answered: 0, total: 1, fraction: 0 }}
			record={record}
			draft={undefined}
			onDraft={() => {}}
			submitting={false}
			error={null}
			onSubmit={() => {}}
			review={false}
			next={null}
			onNext={() => {}}
			onBackToResults={() => {}}
			{...over}
		/>,
	);
}

const cited = { entry: "t03", role: "user", quote: "keep the noise budget under control" } as const;

describe("a topic quiz's question", () => {
	it("shows a citation of the conversation as a quoted message with who wrote it", () => {
		const html = render(
			question({ session: [cited, { entry: "t04", role: "assistant", quote: "bootstrapping resets it" }] }),
		);
		expect(html).toContain("From the conversation");
		expect(html).toContain("keep the noise budget under control");
		expect(html).toContain("You");
		expect(html).toContain("Agent");
		expect(html).toContain("bootstrapping resets it");
		expect(html).not.toContain("The file");
		expect(html).not.toContain("Show in session");
	});

	it("offers Show in session on each citation only when the quiz's session is open", () => {
		const html = render(
			question({ session: [cited, { entry: "t04", role: "assistant", quote: "bootstrapping resets it" }] }),
			{
				onShowEntry: () => {},
			},
		);
		expect(html.split("Show in session")).toHaveLength(3);
	});

	it("marks a background question with a chip and cites nothing", () => {
		const html = render(question({ background: true }));
		expect(html).toContain("qz-chip-background");
		expect(html).toContain("Background");
		expect(html).not.toContain("From the conversation");
		expect(html).not.toContain("qz-code-area");
		expect(html).toContain("qz-split-solo");
		expect(render(question({}))).not.toContain("Background");
	});

	it("renders a question with no citations of any kind, and its verdict", () => {
		const bare = render(question({}));
		expect(bare).toContain("Why was noise growth the limit?");
		expect(bare).toContain("qz-split-solo");
		const record: QuizAnswerRecord = {
			text: "It grows with every multiplication.",
			at: 2,
			verdict: { kind: "partly", explanation: "Close: bootstrapping is the other half.", graded: "model" },
		};
		const done = render(question({ background: true }), {}, record);
		expect(done).toContain("Close: bootstrapping is the other half.");
		expect(done).toContain("Your answer");
		expect(done).not.toContain("qz-code-area");
	});

	it("keeps the file box for a question that cites files, with or without a conversation citation", () => {
		const refs = [{ path: "notes/fhe.md", line: 4, token: "noise" }];
		const files = render(question({ refs }));
		expect(files).toContain("The file");
		expect(files).toContain("qz-code-area");
		expect(files).not.toContain("qz-split-solo");
		const both = render(question({ refs, session: [cited] }));
		expect(both).toContain("From the conversation");
		expect(both).toContain("The file");
	});
});
