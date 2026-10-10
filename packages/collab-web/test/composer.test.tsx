import { describe, expect, it } from "bun:test";
import type { KeyboardEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GuestClient } from "../src/lib/client";
import type { ComposerProps } from "../src/components/shell/Composer";
import { Composer, shouldSubmitOnEnter } from "../src/components/shell/Composer";
import { encodeBase64Url } from "../src/lib/link";

const LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`;
const client = new GuestClient(LINK, "tester");

function props(uiRequest: ComposerProps["uiRequest"]): ComposerProps {
	return {
		client,
		phase: "live",
		readOnly: false,
		uiRequest,
		working: true,
		queuedMessageCount: 0,
		followUp: false,
		followUps: [],
		upload: null,
		draftKey: null,
		voice: null,
		models: null,
		model: undefined,
		thinkingLevel: undefined,
		thinkingLevels: undefined,
		onSessionCommand: () => {},
	};
}

describe("Composer host UI requests", () => {
	it("renders selectable ask responses for mobile guests", () => {
		const html = renderToStaticMarkup(
			<Composer
				{...props({
					reqId: 1,
					kind: "select",
					title: "Continue?",
					options: ["Yes", { label: "No", description: "Stop here" }],
					selectionMarker: "radio",
				})}
			/>,
		);

		expect(html).toContain("Continue?");
		expect(html).toContain("Yes");
		expect(html).toContain("Stop here");
	});

	it("renders a submit field for custom ask responses", () => {
		const html = renderToStaticMarkup(
			<Composer {...props({ reqId: 2, kind: "editor", title: "Other", prefill: "draft" })} />,
		);

		expect(html).toContain("Other");
		expect(html).toContain("draft");
		expect(html).toContain("Submit");
	});

	it("keeps the editor submit enabled for whitespace-only drafts", () => {
		const html = renderToStaticMarkup(
			<Composer {...props({ reqId: 3, kind: "editor", title: "Other", prefill: "   " })} />,
		);

		const submit = { found: false, disabled: false };
		new HTMLRewriter()
			.on('button[title="submit response"]', {
				element(el) {
					submit.found = true;
					submit.disabled = el.hasAttribute("disabled");
				},
			})
			.transform(html);

		expect(submit.found).toBe(true);
		expect(submit.disabled).toBe(false);
	});
});

describe("Composer follow-ups", () => {
	const idle = props(null);

	function buttons(html: string): string[] {
		const found: string[] = [];
		new HTMLRewriter()
			.on("button[title]", {
				element(el) {
					found.push(el.getAttribute("title") ?? "");
				},
			})
			.transform(html);
		return found;
	}

	it("offers 'After turn' only while the agent works on a host that supports it", () => {
		const after = "send when this turn ends (Alt+Enter)";
		expect(buttons(renderToStaticMarkup(<Composer {...idle} followUp working />))).toContain(after);
		expect(buttons(renderToStaticMarkup(<Composer {...idle} followUp working={false} />))).not.toContain(after);
		expect(buttons(renderToStaticMarkup(<Composer {...idle} followUp={false} working />))).not.toContain(after);
	});

	it("lists queued follow-ups as chips and keeps them out of the queued badge", () => {
		const html = renderToStaticMarkup(
			<Composer {...idle} followUp followUps={["run the tests", "then commit"]} queuedMessageCount={3} />,
		);
		expect(html).toContain("run the tests");
		expect(html).toContain("then commit");
		expect(html).toContain("\u00d71</span>");
		const all = renderToStaticMarkup(
			<Composer {...idle} followUp followUps={["a", "b"]} queuedMessageCount={2} />,
		);
		expect(all).not.toContain("sh-queued");
	});

	it("hides the remove action from read-only guests", () => {
		const html = renderToStaticMarkup(<Composer {...idle} readOnly followUps={["later"]} />);
		expect(html).toContain("later");
		expect(html).not.toContain("remove queued follow-up");
	});
});

type KeyEvt = KeyboardEvent<HTMLTextAreaElement>;

function keydown(key: string, opts: { shiftKey?: boolean; isComposing?: boolean } = {}): KeyEvt {
	return {
		key,
		shiftKey: opts.shiftKey ?? false,
		nativeEvent: { isComposing: opts.isComposing ?? false },
	} as KeyEvt;
}

describe("shouldSubmitOnEnter IME guard", () => {
	it("submits on a plain Enter with no composition", () => {
		expect(shouldSubmitOnEnter(keydown("Enter"), false)).toBe(true);
	});

	it("does not submit while nativeEvent.isComposing is true", () => {
		expect(shouldSubmitOnEnter(keydown("Enter", { isComposing: true }), false)).toBe(false);
	});

	it("does not submit while the WebKit composing ref is still set", () => {
		expect(shouldSubmitOnEnter(keydown("Enter"), true)).toBe(false);
	});

	it("does not submit on Shift+Enter (newline)", () => {
		expect(shouldSubmitOnEnter(keydown("Enter", { shiftKey: true }), false)).toBe(false);
	});

	it("ignores non-Enter keys", () => {
		expect(shouldSubmitOnEnter(keydown("a"), false)).toBe(false);
	});

	it("inserts a newline instead of submitting on touch keyboards", () => {
		expect(shouldSubmitOnEnter(keydown("Enter"), false, true)).toBe(false);
	});
});
