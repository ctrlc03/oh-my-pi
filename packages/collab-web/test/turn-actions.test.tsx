import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { renderToStaticMarkup } from "react-dom/server";
import "./transcript-dom-shim";
import { Transcript } from "../src/components/transcript/Transcript";

const stamp = "2026-10-10T08:30:00.000Z";
const user = (id: string, text: string): SessionEntry => ({
	type: "message",
	id,
	parentId: null,
	timestamp: stamp,
	message: { role: "user", content: text, timestamp: 0 },
});
const reply = (id: string, ...text: string[]): SessionEntry => ({
	type: "message",
	id,
	parentId: null,
	timestamp: stamp,
	message: {
		role: "assistant",
		content: text.map(t => ({ type: "text" as const, text: t })),
		model: "m",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
		stopReason: "stop",
		timestamp: 0,
	},
});

function render(props: { entries: SessionEntry[]; working?: boolean; chat?: boolean; compact?: boolean }): string {
	return renderToStaticMarkup(
		<Transcript
			entries={props.entries}
			stream={null}
			streamDone={true}
			activeTools={new Map()}
			working={props.working ?? false}
			chat={props.chat}
			compact={props.compact}
			onEditPrompt={() => {}}
		/>,
	);
}

const count = (html: string, needle: string): number => html.split(needle).length - 1;

describe("turn actions", () => {
	const entries = [user("u1", "one"), reply("a1", "first"), reply("a2", "second"), user("u2", "two"), reply("a3", "third")];

	for (const chat of [true, false]) {
		it(`follows each finished turn once in the ${chat ? "chat" : "full"} view`, () => {
			const html = render({ entries, chat });
			expect(count(html, 'class="tr-turn-actions"')).toBe(2);
			// After the turn's last reply, not between its two replies.
			expect(html.indexOf("second")).toBeLessThan(html.indexOf('class="tr-turn-actions"'));
			expect(html.indexOf('class="tr-turn-actions"')).toBeLessThan(html.indexOf("two"));
		});
	}

	it("leaves out the turn the agent is still working on", () => {
		expect(count(render({ entries, working: true }), 'class="tr-turn-actions"')).toBe(1);
	});

	it("is absent in the compact drawer transcript, which also has no edit action", () => {
		const html = render({ entries, compact: true });
		expect(html).not.toContain("tr-turn-actions");
		expect(html).not.toContain("tr-edit");
	});

	it("offers edit on every prompt row", () => {
		expect(count(render({ entries }), 'aria-label="edit and resend"')).toBe(2);
	});

	it("offers no Copy reply for a turn without reply text", () => {
		const html = render({ entries: [user("u1", "go"), reply("a1")] });
		expect(html).toContain("tr-turn-actions");
		expect(html).not.toContain("Copy reply");
	});
});
