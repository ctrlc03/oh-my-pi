import { describe, expect, it } from "bun:test";
import type { HostFrame, SessionPermission } from "@oh-my-pi/pi-wire";
import { MockApprovals } from "../scripts/mock-approvals";

function setup(guestsCanSaveProject: boolean) {
	const frames: HostFrame[] = [];
	const notices: string[] = [];
	const approvals = new MockApprovals({
		sendWriters: frame => frames.push(frame),
		notice: (_level, message) => notices.push(message),
		guestsCanSaveProject,
	});
	const ask = (command: string): number => {
		const before = frames.length;
		expect(approvals.prompt(`approve ${command}`)).toBe(true);
		const frame = frames[before];
		if (frame?.t !== "ui-request" || frame.request.kind !== "select") throw new Error("expected a select ui-request");
		return frame.request.reqId;
	};
	return { approvals, frames, notices, ask };
}

describe("MockApprovals", () => {
	it("ignores prompts that are not an approve request", () => {
		expect(setup(false).approvals.prompt("hello")).toBe(false);
	});

	it("offers every choice and stops asking once a session rule is saved", () => {
		const { approvals, frames, ask } = setup(false);
		const reqId = ask("bun test a.test.ts");
		const request = frames[0];
		if (request?.t !== "ui-request" || request.request.kind !== "select") throw new Error("unreachable");
		expect(request.request.approval?.choices.map(choice => choice.kind)).toEqual([
			"once",
			"session",
			"project",
			"deny",
			"deny-project",
		]);
		expect(approvals.answer(reqId, "Always allow (this session)")).toBe(true);
		const before = frames.length;
		approvals.prompt("approve bun test b.test.ts");
		expect(frames.slice(before).some(frame => frame.t === "ui-request")).toBe(false);
	});

	it("applies a guest's project choice once, unless the host lets guests save it", () => {
		const refused = setup(false);
		refused.approvals.answer(refused.ask("bun test a"), "Always allow (this project)");
		const before = refused.frames.length;
		refused.approvals.prompt("approve bun test b");
		expect(refused.frames.length).toBeGreaterThan(before);
		expect(refused.notices.some(message => message.includes("guestsCanSaveApprovals"))).toBe(true);

		const allowed = setup(true);
		allowed.approvals.answer(allowed.ask("bun test a"), "Always allow (this project)");
		const after = allowed.frames.length;
		allowed.approvals.prompt("approve bun test b");
		expect(allowed.frames.length).toBe(after);
	});
});

describe("MockApprovals for a vendor agent", () => {
	function vendor(initial: SessionPermission) {
		let permission = initial;
		const frames: HostFrame[] = [];
		const notices: string[] = [];
		const approvals = new MockApprovals({
			sendWriters: frame => frames.push(frame),
			notice: (_level, message) => notices.push(message),
			guestsCanSaveProject: true,
			foreign: { permission: () => permission },
		});
		return { approvals, frames, notices, setPermission: (next: SessionPermission) => (permission = next) };
	}

	it("asks with the vendor's three choices and no project rule", () => {
		const { approvals, frames } = vendor("supervised");
		approvals.prompt("approve bun test");
		const request = frames[0];
		if (request?.t !== "ui-request" || request.request.kind !== "select")
			throw new Error("expected a select ui-request");
		expect(request.request.approval).toEqual({
			tool: "bash",
			rule: "bash: bun test",
			guestProject: false,
			choices: [
				{ label: "Approve once", kind: "once" },
				{ label: "Approve for this session", kind: "session" },
				{ label: "Deny", kind: "deny" },
			],
		});
		expect(approvals.answer(request.request.reqId, "Approve for this session")).toBe(true);
	});

	it("approves without asking under full access", () => {
		const { approvals, frames, notices, setPermission } = vendor("full");
		approvals.prompt("approve rm -rf build");
		expect(frames).toEqual([]);
		expect(notices[0]).toContain("full access");
		setPermission("supervised");
		approvals.prompt("approve rm -rf build");
		expect(frames).toHaveLength(1);
	});
});
