/**
 * The Personal agent's persistent inbox: what `notify_owner` and the companion's own alerts leave for the owner
 * (questions, About-you proposals, digests, info, alerts), kept until acted on, and the requests that act on
 * them (`personal-inbox*`, `-proposal-*`, `-digest*`, `-answer`). Everything is append-only JSONL through the
 * stores; an answer goes back to the agent as an owner-signed `answer` event, an accepted proposal changes
 * About you (through the About store, which keeps the history) and tells the live session with an
 * `about-updated` event. Pure over its deps: no timer, no network.
 *
 * The functions throw `Error` for a bad request; the companion answers those as `{ t: "error", reqId, message }`.
 */

import * as crypto from "node:crypto";
import {
	MAX_ABOUT_BYTES,
	PERSONAL_ROUTES,
	type PersonalChangeKind,
	type PersonalDigest,
	type PersonalInboxItem,
	type PersonalProposal,
	type PersonalReply,
	type PersonalRequest,
	type PersonalStatus,
} from "@oh-my-pi/pi-wire/personal";
import {
	MAX_DIGEST_BODY_CHARS,
	MAX_EVENT_BODY_CHARS,
	MAX_EVENT_TITLE_CHARS,
	MAX_NOTIFY_BODY_CHARS,
	MAX_NOTIFY_OPTION_CHARS,
	MAX_NOTIFY_OPTIONS,
	MAX_NOTIFY_TITLE_CHARS,
	MAX_PROPOSAL_TEXT_CHARS,
	type PersonalEvent,
	type PersonalEventKind,
	type PersonalIpcReply,
	type PersonalIpcRequest,
	type PersonalProposalDraft,
} from "@oh-my-pi/pi-wire/personal-ipc";
import { cleanLine, applyChange, diffLines, planChange, textLines } from "./companion-personal-about-edit";
import type { PersonalAboutStore, PersonalRejected, PersonalStores } from "./companion-personal-store";
import { dayKey } from "./companion-spend";

/** A push to the owner's devices, as the companion's `push()` takes it. */
export interface PersonalPush {
	title: string;
	body: string;
	/** A route of {@link PERSONAL_ROUTES}. */
	open: string;
	/** `personal-<kind>`: a newer notice replaces one still on screen. */
	tag: string;
	/** Things waiting for the owner. */
	badge?: number;
}

/** An event the companion signs as the owner (see `companion-personal-events`). */
export interface OwnerEventInput {
	/** Makes a repeat a duplicate (the same event is not queued twice). */
	id?: string;
	source: string;
	kind: PersonalEventKind;
	title: string;
	body: string;
	ref?: string;
}

export interface InboxDeps {
	stores: Pick<PersonalStores, "inbox" | "proposals" | "digests" | "rejected">;
	about: Pick<PersonalAboutStore, "read" | "write">;
	now(): number;
	/** Bump the status revision and tell the paired devices (`personal-changed`). */
	changed(what: PersonalChangeKind[]): void;
	/** Push to the subscribed devices that are not showing the app right now. */
	pushOwner(push: PersonalPush): void;
	enqueueOwnerEvent(event: OwnerEventInput): Promise<PersonalEvent>;
	onError(err: unknown): void;
}

export type NotifyRequest = Extract<PersonalIpcRequest, { op: "notify" }>;

/** The requests {@link PersonalInbox.handle} answers. */
export type InboxRequest = Extract<
	PersonalRequest,
	{
		t:
			| "personal-proposals"
			| "personal-proposal-edit"
			| "personal-proposal-accept"
			| "personal-proposal-reject"
			| "personal-digests"
			| "personal-digest-read"
			| "personal-inbox"
			| "personal-inbox-ack"
			| "personal-answer";
	}
>;

/** What a review run left behind, for its status. */
export interface ReviewOutcome {
	/** Proposals made since the review started. */
	proposals: number;
	digestId?: string;
}

export interface PersonalInbox {
	/** `POST /personal` `notify`: the agent has something for the owner. Replies with the refusal text the agent sees. */
	notify(request: NotifyRequest): Promise<PersonalIpcReply>;
	/** Answers a `personal-*` request of the inbox, proposals and digests; undefined for any other type. */
	handle(request: PersonalRequest): Promise<PersonalReply | undefined>;
	/** Open questions, pending proposals and unread digests, for `PersonalStatus.counts`. */
	counts(): Promise<PersonalStatus["counts"]>;
	/** The companion's own news (a limit reached, a backup that failed, the login lost): an inbox item of kind `alert`, and a push unless `push` is false. */
	alert(alert: { title: string; body: string; tag: string; push?: boolean }): Promise<PersonalInboxItem>;
	/** Closes a review run: the digest and the proposals it made since `since` get linked, and the digest gets the run's cost. */
	finishReview(run: { since: number; costUsd: number }): Promise<ReviewOutcome>;
}

const MAX_RATIONALE_CHARS = 1_000;
const MAX_SECTION_CHARS = 120;
const MAX_EVIDENCE = 20;
const MAX_EVIDENCE_CHARS = 128;
const MAX_LEARNED = 50;
const MAX_INBOX_LIMIT = 500;
const DEFAULT_INBOX_LIMIT = 100;
const DEFAULT_PAGE = 20;
const MAX_PAGE = 100;
const MAX_ACK_IDS = 200;
const MAX_ANSWER_CHARS = 4_000;
/** The push body is a nudge: the full text is in the inbox. */
const PUSH_BODY_CHARS = 160;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** A proposal text folded for comparison: no list marker, lower case, single spaces, no closing punctuation. */
export function normaliseProposalText(text: string): string {
	return cleanLine(text)
		.toLowerCase()
		.replace(/\s+/g, " ")
		.replace(/[\s.!?;:]+$/, "");
}

/** What a repeat of a rejected proposal is compared on. */
export function proposalKey(draft: Pick<PersonalProposalDraft, "op" | "target" | "text">): string {
	return draft.op === "remove"
		? `remove: ${normaliseProposalText(draft.target ?? "")}`
		: normaliseProposalText(draft.text ?? "");
}

/** Proposals about the same line replace one another: the same target, or the same line added to the same section. */
function supersedeKey(p: Pick<PersonalProposalDraft, "op" | "section" | "target" | "text">): string {
	return p.op === "add"
		? `add: ${normaliseProposalText(p.section ?? "")}: ${normaliseProposalText(p.text ?? "")}`
		: `line: ${normaliseProposalText(p.target ?? "")}`;
}

const rejectedId = (key: string): string => `rj-${crypto.createHash("sha256").update(key).digest("hex").slice(0, 24)}`;

function isDraftOp(value: unknown): value is PersonalProposalDraft["op"] {
	return value === "add" || value === "replace" || value === "remove";
}

function required(value: unknown, max: number, name: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
	if (value.length > max) throw new Error(`${name} is too long (at most ${max} characters)`);
	return value.trim();
}

/** The proposal as the agent sent it, checked and cleaned; throws the refusal text. */
function parseDraft(raw: PersonalProposalDraft | undefined): PersonalProposalDraft {
	if (typeof raw !== "object" || raw === null) throw new Error("a proposal needs the `proposal` field");
	if (!isDraftOp(raw.op)) throw new Error("proposal.op must be add, replace or remove");
	const rationale = required(raw.rationale, MAX_RATIONALE_CHARS, "proposal.rationale");
	const evidence = Array.isArray(raw.evidence)
		? raw.evidence
				.filter((id): id is string => typeof id === "string" && id !== "" && id.length <= MAX_EVIDENCE_CHARS)
				.slice(0, MAX_EVIDENCE)
		: undefined;
	const draft: PersonalProposalDraft = { op: raw.op, rationale, ...(evidence === undefined ? {} : { evidence }) };
	if (raw.section !== undefined) {
		draft.section = required(raw.section, MAX_SECTION_CHARS, "proposal.section")
			.replace(/^#+\s*/, "")
			.replace(/:\s*$/, "");
	}
	if (raw.op === "add") {
		if (draft.section === undefined)
			throw new Error("an `add` proposal needs proposal.section (a heading of About you)");
		draft.text = cleanLine(required(raw.text, MAX_PROPOSAL_TEXT_CHARS, "proposal.text"));
		return draft;
	}
	draft.target = cleanLine(required(raw.target, MAX_PROPOSAL_TEXT_CHARS, "proposal.target"));
	if (raw.op === "replace") draft.text = cleanLine(required(raw.text, MAX_PROPOSAL_TEXT_CHARS, "proposal.text"));
	return draft;
}

function parseOptions(options: string[] | undefined): string[] | undefined {
	if (options === undefined || options.length === 0) return undefined;
	if (!Array.isArray(options) || options.length > MAX_NOTIFY_OPTIONS) {
		throw new Error(`at most ${MAX_NOTIFY_OPTIONS} options`);
	}
	return options.map(option => required(option, MAX_NOTIFY_OPTION_CHARS, "an option"));
}

function parseDigest(raw: { day: string; learned?: string[] } | undefined): { day: string; learned: string[] } {
	if (typeof raw !== "object" || raw === null) throw new Error("a digest needs the `digest` field");
	if (typeof raw.day !== "string" || !DAY_RE.test(raw.day) || Number.isNaN(Date.parse(raw.day))) {
		throw new Error("digest.day must be a date, YYYY-MM-DD");
	}
	const learned = Array.isArray(raw.learned)
		? raw.learned.filter((id): id is string => typeof id === "string" && id !== "").slice(0, MAX_LEARNED)
		: [];
	return { day: raw.day, learned };
}

function newId(prefix: string, now: number): string {
	return `${prefix}-${now.toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

const byNewest = <T extends { at: number }>(a: T, b: T): number => b.at - a.at;

export function createPersonalInbox(deps: InboxDeps): PersonalInbox {
	const { stores } = deps;
	let chain: Promise<unknown> = Promise.resolve();
	/** Requests change records one after another: two devices answering at once cannot both win. */
	const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
		const run = chain.catch(() => undefined).then(work);
		chain = run;
		return run;
	};

	async function counts(): Promise<PersonalStatus["counts"]> {
		const [items, proposals, digests] = await Promise.all([
			stores.inbox.list(),
			stores.proposals.list(),
			stores.digests.list(),
		]);
		return {
			questions: items.filter(item => item.kind === "question" && item.state === "open").length,
			proposals: proposals.filter(p => p.status === "pending").length,
			digests: digests.filter(d => !d.read).length,
		};
	}

	async function pushItem(item: PersonalInboxItem): Promise<void> {
		const waiting = await counts();
		deps.pushOwner({
			title: item.title,
			body: clip(item.body, PUSH_BODY_CHARS),
			open: PERSONAL_ROUTES.inbox,
			tag: `personal-${item.kind}`,
			badge: waiting.questions + waiting.proposals,
		});
	}

	/** The proposal for the app: a pending one shows its diff against About you as it is now. */
	async function present(proposal: PersonalProposal): Promise<PersonalProposal> {
		if (proposal.status !== "pending") return proposal;
		const lines = textLines((await deps.about.read()).text);
		return {
			...proposal,
			diff: diffLines(lines, planChange(lines, proposal, proposal.text), proposal, proposal.text),
		};
	}

	async function closeItem(id: string, patch: Partial<PersonalInboxItem>): Promise<void> {
		const item = await stores.inbox.get(id);
		if (item !== undefined && item.state === "open") await stores.inbox.put({ ...item, state: "done", ...patch });
	}

	async function notify(request: NotifyRequest): Promise<PersonalIpcReply> {
		try {
			return await exclusive(() => notifyNow(request));
		} catch (err) {
			if (err instanceof Error) return { ok: false, error: err.message };
			throw err;
		}
	}

	async function notifyNow(request: NotifyRequest): Promise<PersonalIpcReply> {
		const { item: input, origin } = request;
		if (origin === "guest") throw new Error("a guest turn cannot contact the owner");
		const now = deps.now();
		const title = required(input.title, MAX_NOTIFY_TITLE_CHARS, "title");
		if (input.kind !== "info" && input.kind !== "question" && input.kind !== "proposal" && input.kind !== "digest") {
			throw new Error("kind must be info, question, proposal or digest");
		}
		const body = required(
			input.body,
			input.kind === "digest" ? MAX_DIGEST_BODY_CHARS : MAX_NOTIFY_BODY_CHARS,
			"body",
		);
		const item: PersonalInboxItem = {
			id: newId("in", now),
			kind: input.kind,
			title,
			body,
			at: now,
			origin,
			state: "open",
		};
		const changed: PersonalChangeKind[] = ["inbox", "status"];

		if (input.kind === "question") {
			const options = parseOptions(input.options);
			if (options !== undefined) item.options = options;
		} else if (input.kind === "digest") {
			if (request.runKind !== "review") throw new Error("a digest is only written by the nightly review run");
			const digest = parseDigest(input.digest);
			const record: PersonalDigest = {
				id: newId("dg", now),
				at: now,
				day: digest.day,
				title,
				body,
				learned: digest.learned,
				proposals: [],
				costUsd: 0,
				read: false,
			};
			item.digestId = record.id;
			await stores.digests.put(record);
			changed.push("digests");
		} else if (input.kind === "proposal") {
			const draft = parseDraft(input.proposal);
			const key = proposalKey(draft);
			const rejected = (await stores.rejected.list()).find(r => r.normalised === key);
			if (rejected !== undefined) {
				throw new Error(
					`Rejected before: the owner rejected this proposal on ${dayKey(rejected.at)}. Do not propose it again.`,
				);
			}
			const proposals = await stores.proposals.list();
			const same = supersedeKey(draft);
			for (const old of proposals) {
				if (old.status !== "pending" || supersedeKey(old) !== same) continue;
				await stores.proposals.put({ ...old, status: "superseded", decidedAt: now });
				await closeItem(old.itemId, {});
			}
			const proposal: PersonalProposal = {
				...draft,
				text: draft.text ?? "",
				id: newId("pr", now),
				at: now,
				status: "pending",
				edited: false,
				baseRev: (await deps.about.read()).rev,
				fromExternal: origin === "external",
				itemId: item.id,
				diff: [],
			};
			item.proposalId = proposal.id;
			await stores.proposals.put(proposal);
			changed.push("proposals");
		}

		await stores.inbox.put(item);
		deps.changed(changed);
		// A digest is quiet unless the agent asks; everything else nudges unless it says not to.
		const pushed = input.push ?? input.kind !== "digest";
		if (pushed) await pushItem(item);
		return { ok: true, itemId: item.id, pushed };
	}

	async function alert(a: { title: string; body: string; tag: string; push?: boolean }): Promise<PersonalInboxItem> {
		const now = deps.now();
		const item: PersonalInboxItem = {
			id: newId("in", now),
			kind: "alert",
			title: clip(a.title, MAX_NOTIFY_TITLE_CHARS),
			body: clip(a.body, MAX_NOTIFY_BODY_CHARS),
			at: now,
			// The companion's own news carries the owner's trust: it is not something the agent read outside.
			origin: "owner",
			state: "open",
		};
		await exclusive(() => stores.inbox.put(item));
		deps.changed(["inbox", "status"]);
		if (a.push !== false) {
			const waiting = await counts();
			deps.pushOwner({
				title: item.title,
				body: clip(item.body, PUSH_BODY_CHARS),
				open: PERSONAL_ROUTES.inbox,
				tag: a.tag,
				badge: waiting.questions + waiting.proposals,
			});
		}
		return item;
	}

	async function list(request: Extract<InboxRequest, { t: "personal-inbox" }>): Promise<PersonalReply> {
		const limit = Math.min(Math.max(1, Math.floor(request.limit ?? DEFAULT_INBOX_LIMIT)), MAX_INBOX_LIMIT);
		const items = (await stores.inbox.list())
			.filter(item => request.includeDone === true || item.state === "open")
			.sort(byNewest)
			.slice(0, limit);
		return { t: "personal-inbox", reqId: request.reqId, items };
	}

	async function ack(request: Extract<InboxRequest, { t: "personal-inbox-ack" }>): Promise<PersonalReply> {
		if (!Array.isArray(request.ids)) throw new Error("ids must be a list");
		const ids = request.ids.slice(0, MAX_ACK_IDS);
		const now = deps.now();
		const acked = await exclusive(async () => {
			const found: PersonalInboxItem[] = [];
			for (const item of await stores.inbox.list()) {
				if (!ids.includes(item.id)) continue;
				// A question or proposal stays open until it is answered or decided; the rest is done once read.
				const settled = item.kind === "question" || item.kind === "proposal" ? item.state : "done";
				const next: PersonalInboxItem = { ...item, state: settled, readAt: item.readAt ?? now };
				await stores.inbox.put(next);
				found.push(next);
			}
			return found;
		});
		deps.changed(["inbox", "status"]);
		return { t: "personal-inbox-ack", reqId: request.reqId, items: acked };
	}

	async function answer(request: Extract<InboxRequest, { t: "personal-answer" }>): Promise<PersonalReply> {
		const { option } = request;
		const free = typeof request.text === "string" ? request.text.trim() : "";
		if (typeof request.itemId !== "string") throw new Error("itemId is required");
		if (option === undefined && free === "") throw new Error("an answer needs an option or some text");
		if (free.length > MAX_ANSWER_CHARS)
			throw new Error(`the answer is too long (at most ${MAX_ANSWER_CHARS} characters)`);
		const item = await exclusive(async () => {
			const current = await stores.inbox.get(request.itemId);
			if (current === undefined) throw new Error("unknown question");
			if (current.kind !== "question") throw new Error("only a question can be answered");
			if (current.state !== "open") throw new Error("this question was already answered");
			if (option !== undefined && !(current.options ?? []).includes(option))
				throw new Error("not one of the options");
			const now = deps.now();
			const said = [option, free].filter(part => part !== undefined && part !== "").join("\n");
			// The event is durable before the question closes: a failure leaves it open to answer again, and
			// the event id makes that repeat a duplicate.
			await deps.enqueueOwnerEvent({
				id: `answer-${current.id}`,
				source: "owner-answer",
				kind: "answer",
				title: clip(`Answer: ${current.title}`, MAX_EVENT_TITLE_CHARS),
				body: clip(
					`Question: ${current.title}\n${current.body}\n\nThe owner's answer:\n${said}`,
					MAX_EVENT_BODY_CHARS,
				),
				ref: current.id,
			});
			const done: PersonalInboxItem = {
				...current,
				state: "done",
				readAt: current.readAt ?? now,
				answer: { ...(option === undefined ? {} : { option }), ...(free === "" ? {} : { text: free }), at: now },
			};
			await stores.inbox.put(done);
			return done;
		});
		deps.changed(["inbox", "status"]);
		return { t: "personal-answer", reqId: request.reqId, item };
	}

	async function getProposal(id: string): Promise<PersonalProposal> {
		const proposal = await stores.proposals.get(id);
		if (proposal === undefined) throw new Error("unknown proposal");
		return proposal;
	}

	async function edit(request: Extract<InboxRequest, { t: "personal-proposal-edit" }>): Promise<PersonalReply> {
		const proposal = await exclusive(async () => {
			const current = await getProposal(request.id);
			if (current.status !== "pending") throw new Error("this proposal was already decided");
			if (current.op === "remove") throw new Error("a removal has no text to edit");
			const line = cleanLine(required(request.text, MAX_PROPOSAL_TEXT_CHARS, "text"));
			if (line === "") throw new Error("text is required");
			const next: PersonalProposal = { ...current, text: line, edited: line !== current.text || current.edited };
			await stores.proposals.put(next);
			return next;
		});
		deps.changed(["proposals"]);
		return { t: "personal-proposal-edit", reqId: request.reqId, proposal: await present(proposal) };
	}

	async function accept(request: Extract<InboxRequest, { t: "personal-proposal-accept" }>): Promise<PersonalReply> {
		const result = await exclusive(async () => {
			const current = await getProposal(request.id);
			const before = await deps.about.read();
			if (current.status !== "pending") return { proposal: current, about: before, applied: false, changed: false };
			const now = deps.now();
			const lines = textLines(before.text);
			const change = planChange(lines, current, current.text);
			const diff = diffLines(lines, change, current, current.text);
			if (change === undefined) {
				// The line it is about is gone: nothing to apply, and Accept would never work.
				const stale: PersonalProposal = { ...current, status: "superseded", decidedAt: now, diff };
				await stores.proposals.put(stale);
				await closeItem(current.itemId, { readAt: now });
				return { proposal: stale, about: before, applied: false, changed: true };
			}
			let about = before;
			const unchanged = change.remove === 0 && change.insert.length === 0;
			if (!unchanged) {
				const next = applyChange(before.text, change);
				if (Buffer.byteLength(next) > MAX_ABOUT_BYTES) throw new Error("About you would become too long");
				about = await deps.about.write(next, "proposal", current.id);
			}
			const accepted: PersonalProposal = { ...current, status: "accepted", decidedAt: now, diff };
			await stores.proposals.put(accepted);
			await closeItem(current.itemId, { readAt: now, answer: { option: "accepted", at: now } });
			if (!unchanged) await tellSession(about.rev, about.text, accepted);
			return { proposal: accepted, about, applied: true, changed: true };
		});
		if (result.changed) deps.changed(["proposals", "inbox", "about", "status"]);
		return {
			t: "personal-proposal-accept",
			reqId: request.reqId,
			proposal: result.proposal,
			about: result.about,
			applied: result.applied,
		};
	}

	/** The running session reads `AGENTS.md` only at start, so it is told what changed. The write is already done: a failure here is only reported. */
	async function tellSession(rev: number, aboutText: string, proposal: PersonalProposal): Promise<void> {
		const whole = `About you changed (revision ${rev}). The full new text follows; use it from now on.\n\n${aboutText}`;
		const changes = proposal.diff
			.filter(line => line.op !== "keep")
			.map(line => `${line.op === "add" ? "+" : "-"} ${line.text}`)
			.join("\n");
		const body =
			whole.length <= MAX_EVENT_BODY_CHARS
				? whole
				: clip(
						`About you changed (revision ${rev}); it is too long to repeat. The change:\n${changes}\n\nRead AGENTS.md for the rest at the next start.`,
						MAX_EVENT_BODY_CHARS,
					);
		try {
			await deps.enqueueOwnerEvent({
				id: `about-${proposal.id}`,
				source: "companion",
				kind: "about-updated",
				title: "About you was updated",
				body,
				ref: proposal.id,
			});
		} catch (err) {
			deps.onError(err);
		}
	}

	async function reject(request: Extract<InboxRequest, { t: "personal-proposal-reject" }>): Promise<PersonalReply> {
		const proposal = await exclusive(async () => {
			const current = await getProposal(request.id);
			if (current.status !== "pending") return current;
			const now = deps.now();
			const lines = textLines((await deps.about.read()).text);
			const rejected: PersonalProposal = {
				...current,
				status: "rejected",
				decidedAt: now,
				diff: diffLines(lines, planChange(lines, current, current.text), current, current.text),
			};
			const key = proposalKey(current);
			const record: PersonalRejected = {
				id: rejectedId(key),
				text: current.text !== "" ? current.text : (current.target ?? ""),
				normalised: key,
				at: now,
				proposalId: current.id,
				...(current.section === undefined ? {} : { section: current.section }),
				...(current.target === undefined ? {} : { target: current.target }),
			};
			await stores.rejected.put(record);
			await stores.proposals.put(rejected);
			await closeItem(current.itemId, { readAt: now, answer: { option: "rejected", at: now } });
			return rejected;
		});
		deps.changed(["proposals", "inbox", "status"]);
		return { t: "personal-proposal-reject", reqId: request.reqId, proposal };
	}

	async function proposals(request: Extract<InboxRequest, { t: "personal-proposals" }>): Promise<PersonalReply> {
		const status = request.status ?? "pending";
		const found = (await stores.proposals.list()).filter(p => p.status === status).sort(byNewest);
		return { t: "personal-proposals", reqId: request.reqId, proposals: await Promise.all(found.map(present)) };
	}

	async function digests(request: Extract<InboxRequest, { t: "personal-digests" }>): Promise<PersonalReply> {
		const limit = Math.min(Math.max(1, Math.floor(request.limit ?? DEFAULT_PAGE)), MAX_PAGE);
		const found = (await stores.digests.list())
			.filter(d => request.before === undefined || d.at < request.before)
			.sort(byNewest)
			.slice(0, limit);
		return { t: "personal-digests", reqId: request.reqId, digests: found };
	}

	async function digestRead(request: Extract<InboxRequest, { t: "personal-digest-read" }>): Promise<PersonalReply> {
		const digest = await exclusive(async () => {
			const current = await stores.digests.get(request.id);
			if (current === undefined) throw new Error("unknown digest");
			const now = deps.now();
			const read: PersonalDigest = { ...current, read: true };
			if (!current.read) await stores.digests.put(read);
			const item = (await stores.inbox.list()).find(i => i.digestId === current.id);
			if (item !== undefined) await closeItem(item.id, { readAt: now });
			return read;
		});
		deps.changed(["digests", "inbox", "status"]);
		return { t: "personal-digest-read", reqId: request.reqId, digest };
	}

	return {
		notify,
		counts,
		alert,
		async handle(request) {
			switch (request.t) {
				case "personal-inbox":
					return await list(request);
				case "personal-inbox-ack":
					return await ack(request);
				case "personal-answer":
					return await answer(request);
				case "personal-proposals":
					return await proposals(request);
				case "personal-proposal-edit":
					return await edit(request);
				case "personal-proposal-accept":
					return await accept(request);
				case "personal-proposal-reject":
					return await reject(request);
				case "personal-digests":
					return await digests(request);
				case "personal-digest-read":
					return await digestRead(request);
				default:
					return undefined;
			}
		},
		async finishReview({ since, costUsd }) {
			const made = (await stores.proposals.list()).filter(p => p.at >= since);
			const digest = (await stores.digests.list()).filter(d => d.at >= since).sort(byNewest)[0];
			if (digest !== undefined) {
				await stores.digests.put({ ...digest, costUsd, proposals: made.map(p => p.id) });
				deps.changed(["digests"]);
			}
			return { proposals: made.length, ...(digest === undefined ? {} : { digestId: digest.id }) };
		},
	};
}
