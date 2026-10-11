import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FollowUps, type FollowUpsProps } from "../src/components/shell/FollowUps";
import type { GuestClient } from "../src/lib/client";

const base: FollowUpsProps = {
	client: {} as GuestClient,
	followUps: ["run the tests", "/compact", "then commit"],
	ids: ["qa", "qb", "qc"],
	editable: true,
	readOnly: false,
	live: true,
	resolveMentions: () => [],
};

function buttons(html: string, label: string): string[] {
	return html.split("<button").filter(chunk => chunk.includes(`aria-label="${label}"`));
}

describe("FollowUps", () => {
	it("offers edit, reorder and steer per follow-up, but no edit for a slash command", () => {
		const html = renderToStaticMarkup(<FollowUps {...base} />);
		expect(buttons(html, "edit queued follow-up")).toHaveLength(2);
		expect(buttons(html, "move queued follow-up earlier")).toHaveLength(3);
		expect(buttons(html, "send queued follow-up into the running turn")).toHaveLength(3);
	});

	it("stops the first from moving earlier and the last from moving later", () => {
		const html = renderToStaticMarkup(<FollowUps {...base} />);
		const earlier = buttons(html, "move queued follow-up earlier");
		const later = buttons(html, "move queued follow-up later");
		expect(earlier[0]).toContain("disabled");
		expect(earlier[1]).not.toContain("disabled");
		expect(later[2]).toContain("disabled");
		expect(later[0]).not.toContain("disabled");
	});

	it("only removes when the host cannot edit by id, and shows nothing to a read-only guest", () => {
		const plain = renderToStaticMarkup(<FollowUps {...base} editable={false} />);
		expect(buttons(plain, "edit queued follow-up")).toHaveLength(0);
		expect(buttons(plain, "move queued follow-up earlier")).toHaveLength(0);
		expect(buttons(plain, "remove queued follow-up")).toHaveLength(3);
		const watching = renderToStaticMarkup(<FollowUps {...base} readOnly />);
		expect(watching).toContain("then commit");
		expect(watching).not.toContain("<button");
	});
});
