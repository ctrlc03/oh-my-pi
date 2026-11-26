import { describe, expect, it } from "bun:test";
import { agentMessage, asyncNotifyReports, firstLinePlain } from "../src/lib/agent-notices";

describe("agent notices", () => {
	it("reads job notices whose details arrive as JSON text, as saved sessions hold them", () => {
		const details = JSON.stringify({
			reports: [
				{ id: "bg_186", type: "bash", pattern: "uid=0", lines: ["[*] appeared"], omitted: 2, running: true },
				{ id: "devserver", type: "service", pattern: "ready", lines: ["ready on :3000"], stopped: true },
				{ type: "bash", lines: ["no id"] },
			],
		});
		expect(asyncNotifyReports(details)).toEqual([
			{
				id: "bg_186",
				service: false,
				pattern: "uid=0",
				lines: ["[*] appeared"],
				omitted: 2,
				running: true,
				stopped: false,
			},
			{
				id: "devserver",
				service: true,
				pattern: "ready",
				lines: ["ready on :3000"],
				omitted: 0,
				running: false,
				stopped: true,
			},
		]);
		expect(asyncNotifyReports("not json")).toEqual([]);
	});

	it("takes an incoming message's body from `message` and the other kinds' from `body`", () => {
		expect(agentMessage("irc:incoming", { from: "Scout", message: "found it" })).toMatchObject({
			kind: "incoming",
			from: "Scout",
			to: null,
			body: "found it",
		});
		expect(
			agentMessage("irc:workpool", { pool: "fix", from: "pool:fix", to: "W1", body: "next item" }),
		).toMatchObject({
			kind: "workpool",
			pool: "fix",
			body: "next item",
		});
		// A details shape this client does not know falls back to the message's text.
		expect(agentMessage("irc:incoming", { from: "Scout", body: "wrong field" })).toBeNull();
		expect(agentMessage("note", { message: "x" })).toBeNull();
	});

	it("previews a Markdown message by its first line as plain text", () => {
		expect(firstLinePlain("\n## **Done**: `relay.ts` fixed\n\nmore")).toBe("Done: relay.ts fixed");
		expect(firstLinePlain("- first item\n- second")).toBe("first item");
	});
});
