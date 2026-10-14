import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PERSONAL_ROUTES, type PersonalChangeKind, type PersonalReply } from "@oh-my-pi/pi-wire/personal";
import type {
	NotifyOwnerInput,
	PersonalEvent,
	PersonalIpcReply,
	PersonalTurnOrigin,
} from "@oh-my-pi/pi-wire/personal-ipc";
import { applyChange, planChange, textLines } from "../scripts/companion-personal-about-edit";
import {
	createPersonalInbox,
	normaliseProposalText,
	type OwnerEventInput,
	type PersonalPush,
	proposalKey,
} from "../scripts/companion-personal-inbox";
import { createAboutStore, openPersonalStores, personalPaths } from "../scripts/companion-personal-store";
import { dayKey } from "../scripts/companion-spend";

const TEMPLATE = `# About you

<!-- keep short -->

## Who I am

- Ada, engineer

## How I like to work

- 

## Hard rules

- Never push to main

## Current projects

- 
`;

const NOW = new Date(2026, 9, 14, 12).getTime();

describe("companion-personal-inbox", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "personal-inbox-"));
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	async function harness(opts: { failEvents?: boolean } = {}) {
		const paths = personalPaths(dir);
		const stores = openPersonalStores(paths);
		await fs.mkdir(paths.agentDir, { recursive: true });
		await fs.writeFile(paths.aboutFile, TEMPLATE);
		let now = NOW;
		const about = createAboutStore(paths, () => now);
		await about.seed();
		const pushes: PersonalPush[] = [];
		const events: OwnerEventInput[] = [];
		const changes: PersonalChangeKind[][] = [];
		const errors: unknown[] = [];
		const inbox = createPersonalInbox({
			stores,
			about,
			now: () => now,
			changed: what => void changes.push(what),
			pushOwner: p => void pushes.push(p),
			enqueueOwnerEvent: async e => {
				if (opts.failEvents) throw new Error("channel full");
				events.push(e);
				return { id: e.id ?? "x", at: now, trust: "owner", ...e } as PersonalEvent;
			},
			onError: err => void errors.push(err),
		});
		const notify = (
			item: Partial<NotifyOwnerInput> & Pick<NotifyOwnerInput, "kind">,
			origin: PersonalTurnOrigin = "owner",
			runKind: "live" | "review" = "live",
		): Promise<PersonalIpcReply> =>
			inbox.notify({ op: "notify", sessionId: "s1", runKind, origin, item: { title: "Hi", body: "Body", ...item } });
		let reqId = 0;
		const ask = async (req: Record<string, unknown>): Promise<PersonalReply> => {
			const reply = await inbox.handle({ ...req, reqId: ++reqId } as never);
			if (reply === undefined) throw new Error("not handled");
			return reply;
		};
		return {
			paths,
			stores,
			about,
			inbox,
			pushes,
			events,
			changes,
			errors,
			notify,
			ask,
			clock: (next: number) => {
				now = next;
			},
		};
	}

	const proposal = (over: Record<string, unknown> = {}) => ({
		kind: "proposal" as const,
		title: "About you",
		body: "You asked for this 4 times",
		proposal: {
			op: "add" as const,
			section: "How I like to work",
			text: "Prefer squash merges",
			rationale: "asked 4 times",
			...over,
		},
	});

	describe("notify", () => {
		it("stores an info item and pushes it with the inbox route and a per-kind tag", async () => {
			const h = await harness();
			const reply = await h.notify({ kind: "info", title: "Build done", body: "All green" });
			expect(reply).toMatchObject({ ok: true, pushed: true });
			const items = await h.stores.inbox.list();
			expect(items).toHaveLength(1);
			expect(items[0]).toMatchObject({ kind: "info", title: "Build done", origin: "owner", state: "open" });
			expect(h.pushes).toEqual([
				{ title: "Build done", body: "All green", open: PERSONAL_ROUTES.inbox, tag: "personal-info", badge: 0 },
			]);
			expect(h.changes[0]).toEqual(["inbox", "status"]);
		});

		it("skips the push when told, and refuses what is malformed", async () => {
			const h = await harness();
			expect(await h.notify({ kind: "info", push: false })).toMatchObject({ ok: true, pushed: false });
			expect(h.pushes).toEqual([]);
			expect(await h.notify({ kind: "info", title: "x".repeat(121) })).toMatchObject({ ok: false });
			expect(await h.notify({ kind: "info", body: "  " })).toMatchObject({ ok: false });
			expect(await h.notify({ kind: "bogus" as never })).toMatchObject({ ok: false });
			expect(await h.notify({ kind: "info" }, "guest")).toMatchObject({
				ok: false,
				error: expect.stringContaining("guest"),
			});
			expect(await h.stores.inbox.list()).toHaveLength(1);
		});

		it("keeps question options, counts the badge, and limits the options", async () => {
			const h = await harness();
			await h.notify({ kind: "question", title: "Which?", options: ["A", "B"] });
			expect((await h.stores.inbox.list())[0]?.options).toEqual(["A", "B"]);
			expect(h.pushes[0]?.badge).toBe(1);
			const many = await h.notify({ kind: "question", options: ["1", "2", "3", "4", "5", "6", "7"] });
			expect(many).toMatchObject({ ok: false });
			expect(await h.notify({ kind: "question", options: ["x".repeat(81)] })).toMatchObject({ ok: false });
		});

		it("accepts a digest only from a review run, quiet unless asked, and finishReview links it", async () => {
			const h = await harness();
			const digest = {
				kind: "digest" as const,
				title: "What I learned",
				body: "- likes squash",
				digest: { day: "2026-10-13", learned: ["m1"] },
			};
			expect(await h.notify(digest)).toMatchObject({ ok: false, error: expect.stringContaining("review") });
			expect(await h.notify({ ...digest, digest: { day: "13/10" } }, "owner", "review")).toMatchObject({
				ok: false,
			});
			const started = NOW - 1;
			const reply = await h.notify(digest, "owner", "review");
			expect(reply).toMatchObject({ ok: true, pushed: false });
			expect(h.pushes).toEqual([]);
			await h.notify({ ...digest, push: true }, "owner", "review");
			expect(h.pushes).toHaveLength(1);
			await h.notify(proposal(), "owner", "review");
			const done = await h.inbox.finishReview({ since: started, costUsd: 0.31 });
			expect(done.proposals).toBe(1);
			const stored = (await h.stores.digests.list()).find(d => d.id === done.digestId);
			expect(stored).toMatchObject({ day: "2026-10-13", learned: ["m1"], costUsd: 0.31, read: false });
			expect(stored?.proposals).toHaveLength(1);
			expect(await h.inbox.counts()).toEqual({ questions: 0, proposals: 1, digests: 2 });
		});
	});

	describe("proposals", () => {
		it("creates a proposal with the base revision, marks external origin, and shows a diff", async () => {
			const h = await harness();
			expect(await h.notify(proposal(), "external")).toMatchObject({ ok: true });
			const reply = await h.ask({ t: "personal-proposals" });
			if (reply.t !== "personal-proposals") throw new Error("wrong reply");
			const [p] = reply.proposals;
			expect(p).toMatchObject({
				status: "pending",
				fromExternal: true,
				baseRev: 1,
				text: "Prefer squash merges",
				edited: false,
			});
			expect(p?.diff.filter(l => l.op === "add").map(l => l.text)).toEqual(["- Prefer squash merges"]);
			// The template's empty bullet gives way to the line.
			expect(p?.diff.filter(l => l.op === "del").map(l => l.text)).toEqual(["- "]);
			expect(h.changes.at(-1)).toContain("proposals");
		});

		it("refuses a proposal that is missing its parts", async () => {
			const h = await harness();
			expect(await h.notify({ kind: "proposal", title: "t", body: "b" })).toMatchObject({ ok: false });
			expect(await h.notify(proposal({ section: undefined }))).toMatchObject({ ok: false });
			expect(await h.notify(proposal({ rationale: "" }))).toMatchObject({ ok: false });
			expect(await h.notify(proposal({ op: "replace", text: "x", target: undefined }))).toMatchObject({ ok: false });
			expect(await h.notify(proposal({ text: "x".repeat(601) }))).toMatchObject({ ok: false });
			expect(await h.stores.proposals.list()).toEqual([]);
		});

		it("accepts: AGENTS.md changes, history and revision move, the session is told, the item is done", async () => {
			const h = await harness();
			await h.notify(proposal());
			const [p] = await h.stores.proposals.list();
			const reply = await h.ask({ t: "personal-proposal-accept", id: p?.id });
			if (reply.t !== "personal-proposal-accept") throw new Error("wrong reply");
			expect(reply.applied).toBe(true);
			expect(reply.proposal).toMatchObject({ status: "accepted" });
			expect(reply.about.rev).toBe(2);
			const file = await Bun.file(h.paths.aboutFile).text();
			expect(file).toContain("## How I like to work\n\n- Prefer squash merges\n\n## Hard rules");
			expect(file).not.toContain("- \n\n## Hard rules");
			const history = await h.about.history();
			expect(history.map(v => [v.rev, v.by])).toEqual([
				[2, "proposal"],
				[1, "setup"],
			]);
			expect(history[0]?.proposalId).toBe(p?.id);
			expect(h.events).toHaveLength(1);
			expect(h.events[0]).toMatchObject({ kind: "about-updated", ref: p?.id, id: `about-${p?.id}` });
			expect(h.events[0]?.body).toContain("Prefer squash merges");
			const [item] = await h.stores.inbox.list();
			expect(item).toMatchObject({ state: "done", answer: { option: "accepted" } });
			expect(h.changes.at(-1)).toEqual(["proposals", "inbox", "about", "status"]);
			// Accepting again does nothing.
			const again = await h.ask({ t: "personal-proposal-accept", id: p?.id });
			expect(again).toMatchObject({ applied: false });
			expect((await h.about.history()).length).toBe(2);
			expect(h.events).toHaveLength(1);
		});

		it("replaces and removes lines, keeping the list marker", async () => {
			const h = await harness();
			await h.notify(
				proposal({
					op: "replace",
					section: undefined,
					target: "Never push to main",
					text: "Never push to main or release",
				}),
			);
			await h.notify(proposal({ op: "remove", section: undefined, target: "Ada, engineer", text: undefined }));
			const [replace, remove] = await h.stores.proposals.list();
			await h.ask({ t: "personal-proposal-accept", id: replace?.id });
			await h.ask({ t: "personal-proposal-accept", id: remove?.id });
			const file = await Bun.file(h.paths.aboutFile).text();
			expect(file).toContain("- Never push to main or release\n");
			expect(file).not.toContain("Ada, engineer");
			expect((await h.about.read()).rev).toBe(3);
		});

		it("says applied: false when the target line is gone, and does not change About you", async () => {
			const h = await harness();
			await h.notify(
				proposal({ op: "replace", section: undefined, target: "Ada, engineer", text: "Ada, staff engineer" }),
			);
			const [p] = await h.stores.proposals.list();
			// The owner edits About you by hand first.
			await fs.writeFile(h.paths.aboutFile, TEMPLATE.replace("- Ada, engineer", "- Ada Lovelace"));
			const reply = await h.ask({ t: "personal-proposal-accept", id: p?.id });
			if (reply.t !== "personal-proposal-accept") throw new Error("wrong reply");
			expect(reply.applied).toBe(false);
			expect(reply.proposal.status).toBe("superseded");
			expect(reply.about.text).toContain("Ada Lovelace");
			expect(h.events).toEqual([]);
			expect(reply.proposal.diff.map(l => l.op)).toEqual(["del", "add"]);
		});

		it("creates a missing section at the end and does not add a line twice", async () => {
			const h = await harness();
			await h.notify(proposal({ section: "Tools", text: "Use bun" }));
			const [p] = await h.stores.proposals.list();
			await h.ask({ t: "personal-proposal-accept", id: p?.id });
			expect(await Bun.file(h.paths.aboutFile).text()).toMatch(/- \n\n## Tools\n\n- Use bun\n$/);
			await h.notify(proposal({ section: "Tools", text: "Use bun" }));
			const second = (await h.stores.proposals.list()).find(x => x.id !== p?.id);
			const reply = await h.ask({ t: "personal-proposal-accept", id: second?.id });
			expect(reply).toMatchObject({ applied: true });
			expect((await h.about.read()).rev).toBe(2);
		});

		it("edits the proposed line, which is what gets applied", async () => {
			const h = await harness();
			await h.notify(proposal());
			const [p] = await h.stores.proposals.list();
			const edited = await h.ask({ t: "personal-proposal-edit", id: p?.id, text: "- Always squash\nmerge" });
			if (edited.t !== "personal-proposal-edit") throw new Error("wrong reply");
			expect(edited.proposal).toMatchObject({ text: "Always squash merge", edited: true, status: "pending" });
			await h.ask({ t: "personal-proposal-accept", id: p?.id });
			expect(await Bun.file(h.paths.aboutFile).text()).toContain("- Always squash merge");
			await expect(h.ask({ t: "personal-proposal-edit", id: p?.id, text: "late" })).rejects.toThrow(
				"already decided",
			);
		});

		it("refuses to edit a removal or an empty line", async () => {
			const h = await harness();
			await h.notify(proposal({ op: "remove", section: undefined, target: "Ada, engineer", text: undefined }));
			const [p] = await h.stores.proposals.list();
			await expect(h.ask({ t: "personal-proposal-edit", id: p?.id, text: "x" })).rejects.toThrow("removal");
			await expect(h.ask({ t: "personal-proposal-edit", id: "nope", text: "x" })).rejects.toThrow("unknown");
		});

		it("remembers a rejection and refuses the same proposal again, naming the date", async () => {
			const h = await harness();
			await h.notify(proposal());
			const [p] = await h.stores.proposals.list();
			const reply = await h.ask({ t: "personal-proposal-reject", id: p?.id });
			expect(reply).toMatchObject({ proposal: { status: "rejected" } });
			expect((await h.stores.inbox.list())[0]).toMatchObject({ state: "done", answer: { option: "rejected" } });
			h.clock(NOW + 3 * 86_400_000);
			const repeat = await h.notify(proposal({ text: "- prefer SQUASH merges." }));
			expect(repeat).toMatchObject({
				ok: false,
				error: expect.stringContaining(`Rejected before: the owner rejected this proposal on ${dayKey(NOW)}`),
			});
			expect(await h.stores.proposals.list()).toHaveLength(1);
			// A different proposal still goes through; and a rejected one stays rejected.
			expect(await h.notify(proposal({ text: "Prefer rebase" }))).toMatchObject({ ok: true });
			expect(await h.ask({ t: "personal-proposal-reject", id: p?.id })).toMatchObject({
				proposal: { status: "rejected" },
			});
			expect(await h.stores.rejected.list()).toHaveLength(1);
		});

		it("supersedes an older pending proposal for the same line", async () => {
			const h = await harness();
			await h.notify(
				proposal({ op: "replace", section: undefined, target: "Never push to main", text: "Never push" }),
			);
			await h.notify(
				proposal({ op: "replace", section: undefined, target: "- never push to main", text: "Never push, ever" }),
			);
			await h.notify(proposal({ op: "replace", section: undefined, target: "Ada, engineer", text: "Ada" }));
			const all = await h.stores.proposals.list();
			expect(all.map(p => p.status)).toEqual(["superseded", "pending", "pending"]);
			const items = await h.stores.inbox.list();
			expect(items.map(i => i.state)).toEqual(["done", "open", "open"]);
			expect((await h.inbox.counts()).proposals).toBe(2);
			const superseded = await h.ask({ t: "personal-proposals", status: "superseded" });
			expect(superseded).toMatchObject({ proposals: [{ status: "superseded" }] });
		});

		it("reports a failed event as an error but still applies the accepted change", async () => {
			const h = await harness({ failEvents: true });
			await h.notify(proposal());
			const [p] = await h.stores.proposals.list();
			expect(await h.ask({ t: "personal-proposal-accept", id: p?.id })).toMatchObject({ applied: true });
			expect(h.errors).toHaveLength(1);
			expect(await Bun.file(h.paths.aboutFile).text()).toContain("Prefer squash merges");
		});

		it("sends only the change when About you is too long to repeat in an event", async () => {
			const h = await harness();
			await fs.writeFile(h.paths.aboutFile, `${TEMPLATE}\n${"- filler line\n".repeat(700)}`);
			await h.notify(proposal());
			const [p] = await h.stores.proposals.list();
			await h.ask({ t: "personal-proposal-accept", id: p?.id });
			const body = h.events[0]?.body ?? "";
			expect(body.length).toBeLessThanOrEqual(8_000);
			expect(body).toContain("+ - Prefer squash merges");
		});
	});

	describe("answers", () => {
		it("turns a quick reply into an owner event, closes the question, and refuses a second answer", async () => {
			const h = await harness();
			await h.notify({ kind: "question", title: "Deploy?", body: "Staging is green", options: ["yes", "no"] });
			const [q] = await h.stores.inbox.list();
			const reply = await h.ask({ t: "personal-answer", itemId: q?.id, option: "yes", text: "after lunch" });
			if (reply.t !== "personal-answer") throw new Error("wrong reply");
			expect(reply.item).toMatchObject({ state: "done", answer: { option: "yes", text: "after lunch", at: NOW } });
			expect(h.events).toHaveLength(1);
			expect(h.events[0]).toMatchObject({
				kind: "answer",
				ref: q?.id,
				id: `answer-${q?.id}`,
				source: "owner-answer",
			});
			expect(h.events[0]?.body).toContain("Staging is green");
			expect(h.events[0]?.body).toContain("yes\nafter lunch");
			await expect(h.ask({ t: "personal-answer", itemId: q?.id, text: "again" })).rejects.toThrow(
				"already answered",
			);
			expect(h.events).toHaveLength(1);
		});

		it("takes free text for a question with options, and refuses a bad answer", async () => {
			const h = await harness();
			await h.notify({ kind: "question", options: ["yes", "no"] });
			await h.notify({ kind: "info" });
			const [q, info] = await h.stores.inbox.list();
			await expect(h.ask({ t: "personal-answer", itemId: q?.id, option: "maybe" })).rejects.toThrow("options");
			await expect(h.ask({ t: "personal-answer", itemId: q?.id })).rejects.toThrow("option or some text");
			await expect(h.ask({ t: "personal-answer", itemId: info?.id, text: "hi" })).rejects.toThrow("question");
			await expect(h.ask({ t: "personal-answer", itemId: "nope", text: "hi" })).rejects.toThrow("unknown");
			expect(await h.ask({ t: "personal-answer", itemId: q?.id, text: "not now" })).toMatchObject({
				item: { answer: { text: "not now" } },
			});
		});

		it("lets only one of two simultaneous answers win", async () => {
			const h = await harness();
			await h.notify({ kind: "question" });
			const [q] = await h.stores.inbox.list();
			const results = await Promise.allSettled([
				h.ask({ t: "personal-answer", itemId: q?.id, text: "a" }),
				h.ask({ t: "personal-answer", itemId: q?.id, text: "b" }),
			]);
			expect(results.map(r => r.status).sort()).toEqual(["fulfilled", "rejected"]);
			expect(h.events).toHaveLength(1);
		});

		it("leaves the question open when the event cannot be queued", async () => {
			const failing = await harness({ failEvents: true });
			await failing.notify({ kind: "question" });
			const [open] = await failing.stores.inbox.list();
			await expect(failing.ask({ t: "personal-answer", itemId: open?.id, text: "x" })).rejects.toThrow(
				"channel full",
			);
			expect((await failing.stores.inbox.get(open?.id ?? ""))?.state).toBe("open");
		});
	});

	describe("inbox", () => {
		it("lists open items newest first, done ones on request, and limits", async () => {
			const h = await harness();
			await h.notify({ kind: "info", title: "one" });
			h.clock(NOW + 1000);
			await h.notify({ kind: "info", title: "two" });
			h.clock(NOW + 2000);
			await h.notify({ kind: "question", title: "three" });
			const [first] = await h.stores.inbox.list();
			await h.ask({ t: "personal-inbox-ack", ids: [first?.id] });
			const open = await h.ask({ t: "personal-inbox" });
			expect(open).toMatchObject({ items: [{ title: "three" }, { title: "two" }] });
			const all = await h.ask({ t: "personal-inbox", includeDone: true, limit: 2 });
			if (all.t !== "personal-inbox") throw new Error("wrong reply");
			expect(all.items.map(i => i.title)).toEqual(["three", "two"]);
			expect(await h.ask({ t: "personal-inbox", includeDone: true })).toMatchObject({
				items: expect.arrayContaining([expect.objectContaining({ title: "one", state: "done" })]),
			});
		});

		it("marks read: information is done, a question or proposal stays open", async () => {
			const h = await harness();
			await h.notify({ kind: "info" });
			await h.notify({ kind: "question" });
			await h.notify(proposal());
			const ids = (await h.stores.inbox.list()).map(i => i.id);
			const reply = await h.ask({ t: "personal-inbox-ack", ids: [...ids, "unknown"] });
			if (reply.t !== "personal-inbox-ack") throw new Error("wrong reply");
			expect(reply.items.map(i => [i.kind, i.state, i.readAt])).toEqual([
				["info", "done", NOW],
				["question", "open", NOW],
				["proposal", "open", NOW],
			]);
			await expect(h.ask({ t: "personal-inbox-ack", ids: "x" })).rejects.toThrow("list");
		});

		it("files a companion alert as an item of kind alert with its own tag", async () => {
			const h = await harness();
			const item = await h.inbox.alert({ title: "Backup failed", body: "folder missing", tag: "personal-backup" });
			expect(item).toMatchObject({ kind: "alert", state: "open", origin: "owner" });
			expect(h.pushes).toEqual([
				{
					title: "Backup failed",
					body: "folder missing",
					open: PERSONAL_ROUTES.inbox,
					tag: "personal-backup",
					badge: 0,
				},
			]);
			await h.inbox.alert({ title: "quiet", body: "b", tag: "t", push: false });
			expect(h.pushes).toHaveLength(1);
			expect(await h.stores.inbox.list()).toHaveLength(2);
		});

		it("answers nothing for a request that is not its own", async () => {
			const h = await harness();
			expect(await h.inbox.handle({ t: "personal-status", reqId: 1 })).toBeUndefined();
		});
	});

	describe("digest list", () => {
		it("pages newest first and marks read", async () => {
			const h = await harness();
			const digest = (day: string) => ({ kind: "digest" as const, title: day, body: "b", digest: { day } });
			await h.notify(digest("2026-10-11"), "owner", "review");
			h.clock(NOW + 1000);
			await h.notify(digest("2026-10-12"), "owner", "review");
			const page = await h.ask({ t: "personal-digests", limit: 1 });
			if (page.t !== "personal-digests") throw new Error("wrong reply");
			expect(page.digests.map(d => d.day)).toEqual(["2026-10-12"]);
			const older = await h.ask({ t: "personal-digests", before: NOW + 1000 });
			expect(older).toMatchObject({ digests: [{ day: "2026-10-11" }] });
			const id = page.digests[0]?.id;
			expect(await h.ask({ t: "personal-digest-read", id })).toMatchObject({ digest: { read: true } });
			expect((await h.inbox.counts()).digests).toBe(1);
			expect((await h.stores.inbox.list()).map(i => i.state)).toEqual(["open", "done"]);
			await expect(h.ask({ t: "personal-digest-read", id: "nope" })).rejects.toThrow("unknown");
		});
	});
});

describe("proposal text", () => {
	it("folds markers, case, spacing and closing punctuation", () => {
		expect(normaliseProposalText("- Prefer  Squash merges.")).toBe("prefer squash merges");
		expect(proposalKey({ op: "remove", target: "* Old line!" })).toBe("remove: old line");
		expect(proposalKey({ op: "add", text: "1. Prefer squash merges" })).toBe("prefer squash merges");
	});
});

describe("About you edits", () => {
	const text = TEMPLATE;
	it("adds under the section, replacing the template's empty bullet", () => {
		const lines = textLines(text);
		const change = planChange(lines, { op: "add", section: "## How I like to work:" }, "Squash");
		expect(change).toMatchObject({ remove: 1, insert: ["- Squash"] });
		expect(applyChange(text, change!)).toContain("## How I like to work\n\n- Squash\n\n## Hard rules");
	});

	it("appends after the last line of a section that has real lines, before the blank line", () => {
		const change = planChange(textLines(text), { op: "add", section: "hard rules" }, "Ask before deleting");
		expect(applyChange(text, change!)).toContain(
			"- Never push to main\n- Ask before deleting\n\n## Current projects",
		);
	});

	it("matches a target without marker or indent and finds a stale one", () => {
		const lines = textLines(text);
		expect(planChange(lines, { op: "remove", target: "  * Never push to main " }, "")).toMatchObject({
			remove: 1,
			insert: [],
		});
		expect(planChange(lines, { op: "replace", target: "gone" }, "x")).toBeUndefined();
		expect(planChange(lines, { op: "replace", target: "" }, "x")).toBeUndefined();
	});

	it("keeps the file's trailing newline", () => {
		const change = planChange(textLines("# T\n\n## A\n\n- x\n"), { op: "add", section: "A" }, "y");
		expect(applyChange("# T\n\n## A\n\n- x\n", change!)).toBe("# T\n\n## A\n\n- x\n- y\n");
		const bare = planChange(textLines("## A\n- x"), { op: "add", section: "A" }, "y");
		expect(applyChange("## A\n- x", bare!)).toBe("## A\n- x\n- y");
	});
});
