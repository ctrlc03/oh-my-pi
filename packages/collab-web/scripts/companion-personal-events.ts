/**
 * The companion's half of the Personal agent's event channel (docs/personal-agent.md "Events and the event
 * inbox"): normalising what producers hand over, signing owner-trust events, writing the channel files the live
 * session drains, keeping an event record per event, and tidying up (expiry, the pending cap, claims of a session
 * that died). Wire shapes and limits are in `@oh-my-pi/pi-wire/personal-ipc`.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PersonalChangeKind, PersonalEventRecord, PersonalEventStatus } from "@oh-my-pi/pi-wire/personal";
import {
	EVENT_CLAIM_STALE_MS,
	EVENT_INGRESS_PER_MINUTE,
	EVENT_TTL_MS,
	MAX_EVENT_BODY_CHARS,
	MAX_EVENT_SOURCE_CHARS,
	MAX_EVENT_TITLE_CHARS,
	MAX_EVENT_URL_CHARS,
	MAX_PENDING_EVENTS,
	type PersonalBeat,
	type PersonalEvent,
	type PersonalEventInput,
	type PersonalEventKind,
	type PersonalEventPostReply,
	type PersonalReceiptOutcome,
	parsePersonalEvent,
	personalEventCanonical,
	personalEventFileName,
} from "@oh-my-pi/pi-wire/personal-ipc";
import { type JsonlStore, type PersonalPaths, writeFileAtomic } from "./companion-personal-store";

const MINUTE_MS = 60_000;
const INPUT_ID_RE = /^[A-Za-z0-9_.:@-]{1,128}$/;
const INPUT_SOURCE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
/** Producers a local script may name itself after without the `script:` prefix: they are outside content all the same. */
const EXTERNAL_PRODUCERS: Record<string, true> = { script: true, github: true, email: true, calendar: true };
const SCRIPT_PREFIX = "script:";

/** HMAC-SHA256 (hex) of the event's canonical text under the owner key. */
export function signEvent(event: PersonalEvent, key: string): string {
	return crypto.createHmac("sha256", key).update(personalEventCanonical(event)).digest("hex");
}

/** The source label an event from `POST /event` gets: a known external producer as is, anything else under `script:`. */
export function scriptSource(source: string): string {
	if (Object.hasOwn(EXTERNAL_PRODUCERS, source) || source.startsWith(SCRIPT_PREFIX)) return source;
	return `${SCRIPT_PREFIX}${source}`;
}

/** The stable event id of a `POST /event` with an idempotency key: the same source and key give the same id. */
export function stableEventId(source: string, id: string): string {
	return `ext-${crypto.createHash("sha256").update(`${source}\0${id}`).digest("hex").slice(0, 40)}`;
}

export interface EventDraft {
	source: string;
	kind: PersonalEventKind;
	title: string;
	body: string;
	url?: string;
	/** `answer`/`about-updated`: the inbox item or proposal. */
	ref?: string;
	/** Default: random. */
	id?: string;
	/** Default: now. */
	at?: number;
}

export interface IngestResult {
	status: 200 | 400 | 429;
	reply: PersonalEventPostReply;
}

export interface PersonalEvents {
	/** `POST /event`: validate, mark external, answer duplicates, rate-limit per source, write the channel file. */
	ingest(input: unknown): Promise<IngestResult>;
	/** An event the companion itself makes (an answer from the app, an owner-made schedule, housekeeping): signed. */
	enqueueOwner(draft: EventDraft): Promise<PersonalEvent>;
	/** An event from outside content that is not a `POST /event` (a source's poll result, a schedule the agent made): unsigned. */
	enqueueExternal(draft: EventDraft): Promise<PersonalEvent>;
	/** What the session says became of an event. */
	receipt(eventId: string, outcome: PersonalReceiptOutcome, detail?: string): Promise<void>;
	/** Expire stale events, keep to the pending cap, hand claims of a dead session back to the inbox. */
	maintain(): Promise<void>;
	/** Files waiting in `inbox/`. */
	pending(): Promise<number>;
}

export interface PersonalEventsOptions {
	paths: PersonalPaths;
	events: JsonlStore<PersonalEventRecord>;
	now(): number;
	ownerKey(): Promise<string | null>;
	changed(what: PersonalChangeKind[]): void;
}

const RECEIPT_STATUS: Record<PersonalReceiptOutcome, PersonalEventStatus> = {
	delivered: "delivered",
	"rate-limited": "rate-limited",
	refused: "refused",
	failed: "failed",
	capped: "capped",
};

export function createPersonalEvents(options: PersonalEventsOptions): PersonalEvents {
	const { paths, events: records, now } = options;
	/** Per source, when its `POST /event`s of the last minute arrived. */
	const ingressTimes = new Map<string, number[]>();

	const write = async (event: PersonalEvent): Promise<void> => {
		await fs.mkdir(paths.inboxDir, { recursive: true, mode: 0o700 });
		await writeFileAtomic(path.join(paths.inboxDir, personalEventFileName(event)), `${JSON.stringify(event)}\n`);
	};

	const record = (event: PersonalEvent, status: PersonalEventStatus, detail?: string): PersonalEventRecord => ({
		id: event.id,
		source: event.source,
		kind: event.kind,
		trust: event.trust,
		at: event.at,
		title: event.title,
		...(event.url === undefined ? {} : { url: event.url }),
		status,
		...(detail === undefined ? {} : { detail }),
	});

	const normalise = (draft: EventDraft, trust: PersonalEvent["trust"]): PersonalEvent => ({
		id: draft.id ?? `${draft.kind}-${crypto.randomUUID()}`,
		source: draft.source.slice(0, MAX_EVENT_SOURCE_CHARS),
		kind: draft.kind,
		at: draft.at ?? now(),
		title: draft.title.replace(/\s+/g, " ").trim().slice(0, MAX_EVENT_TITLE_CHARS),
		body: draft.body.slice(0, MAX_EVENT_BODY_CHARS),
		...(draft.url === undefined ? {} : { url: draft.url.slice(0, MAX_EVENT_URL_CHARS) }),
		trust,
		...(draft.ref === undefined ? {} : { ref: draft.ref }),
	});

	const enqueue = async (event: PersonalEvent): Promise<PersonalEvent> => {
		// A producer that names its event (`answer-<item>`) asks for it once: the same id again is a no-op.
		if ((await records.get(event.id)) !== undefined) return event;
		await write(event);
		await records.put(record(event, "queued"));
		options.changed(["events"]);
		return event;
	};

	/** Files of `inbox/`, oldest first, parsed; an unreadable file is removed (it can never be delivered). */
	const inboxFiles = async (): Promise<{ file: string; event: PersonalEvent | undefined }[]> => {
		let names: string[];
		try {
			names = (await fs.readdir(paths.inboxDir)).filter(name => name.endsWith(".json")).sort();
		} catch {
			return [];
		}
		return await Promise.all(
			names.map(async name => {
				const file = path.join(paths.inboxDir, name);
				try {
					return { file, event: parsePersonalEvent(JSON.parse(await Bun.file(file).text())) };
				} catch {
					return { file, event: undefined };
				}
			}),
		);
	};

	const settle = async (event: PersonalEvent, status: PersonalEventStatus, detail: string): Promise<void> => {
		await records.put({ ...record(event, status, detail) });
		options.changed(["events"]);
	};

	const returnStaleClaims = async (): Promise<void> => {
		let sessions: string[];
		try {
			sessions = await fs.readdir(paths.claimedDir);
		} catch {
			return;
		}
		const beat: PersonalBeat | undefined = await Bun.file(paths.beatFile)
			.json()
			.then(
				(raw: PersonalBeat) => raw,
				() => undefined,
			);
		const t = now();
		for (const sessionId of sessions) {
			const dir = path.join(paths.claimedDir, sessionId);
			let names: string[];
			try {
				names = await fs.readdir(dir);
			} catch {
				continue;
			}
			const alive = beat?.sessionId === sessionId && t - beat.at < EVENT_CLAIM_STALE_MS;
			for (const name of names) {
				if (alive) break;
				const claimed = path.join(dir, name);
				// A session whose own beat went stale, or whose claim another session's fresh beat outlives, is gone. Any other
				// claim may be a session that is just starting and has not beaten yet: wait out the stale time from the claim.
				const mtime = await fs.stat(claimed).then(
					s => s.mtimeMs,
					() => t,
				);
				const own = beat?.sessionId === sessionId;
				const replaced = beat !== undefined && !own && t - beat.at < EVENT_CLAIM_STALE_MS;
				if (!own && !replaced && t - mtime < EVENT_CLAIM_STALE_MS) continue;
				await fs.mkdir(paths.inboxDir, { recursive: true, mode: 0o700 });
				await fs.rename(claimed, path.join(paths.inboxDir, name)).catch(() => undefined);
			}
			if (!alive) await fs.rmdir(dir).catch(() => undefined);
		}
	};

	return {
		async ingest(input) {
			if (typeof input !== "object" || input === null || Array.isArray(input))
				return { status: 400, reply: { ok: false, error: "invalid event" } };
			const body = input as Partial<PersonalEventInput> & Record<string, unknown>;
			const fail = (error: string, status: 400 | 429 = 400): IngestResult => ({
				status,
				reply: { ok: false, error },
			});
			if (typeof body.title !== "string" || body.title.trim() === "") return fail("title is required");
			if (typeof body.body !== "string") return fail("body is required");
			if (body.title.length > MAX_EVENT_TITLE_CHARS)
				return fail(`title is over ${MAX_EVENT_TITLE_CHARS} characters`);
			if (body.body.length > MAX_EVENT_BODY_CHARS) return fail(`body is over ${MAX_EVENT_BODY_CHARS} characters`);
			if (body.url !== undefined && (typeof body.url !== "string" || body.url.length > MAX_EVENT_URL_CHARS))
				return fail("invalid url");
			if (body.source !== undefined && (typeof body.source !== "string" || !INPUT_SOURCE_RE.test(body.source)))
				return fail("invalid source");
			if (body.id !== undefined && (typeof body.id !== "string" || !INPUT_ID_RE.test(body.id)))
				return fail("invalid id");
			if (body.at !== undefined && (typeof body.at !== "number" || !Number.isFinite(body.at)))
				return fail("invalid at");
			const t = now();
			if (body.at !== undefined && body.at < t - EVENT_TTL_MS) return fail("event is older than 24 hours");
			const source = scriptSource(body.source ?? "script");
			if (source.length > MAX_EVENT_SOURCE_CHARS) return fail("source is too long");

			const recent = (ingressTimes.get(source) ?? []).filter(at => t - at < MINUTE_MS);
			if (recent.length >= EVENT_INGRESS_PER_MINUTE) {
				ingressTimes.set(source, recent);
				return fail(`too many events from ${source}; at most ${EVENT_INGRESS_PER_MINUTE} a minute`, 429);
			}
			const id = body.id === undefined ? `ext-${crypto.randomUUID()}` : stableEventId(source, body.id);
			if ((await records.get(id)) !== undefined) return { status: 200, reply: { ok: true, id, duplicate: true } };
			ingressTimes.set(source, [...recent, t]);
			const event = normalise(
				{
					id,
					source,
					kind: "event",
					title: body.title,
					body: body.body,
					url: body.url,
					at: Math.min(body.at ?? t, t),
				},
				"external",
			);
			await enqueue(event);
			return { status: 200, reply: { ok: true, id, duplicate: false } };
		},
		async enqueueOwner(draft) {
			const key = await options.ownerKey();
			if (key === null) throw new Error("the owner key is missing: run setup again");
			const event = normalise(draft, "owner");
			return await enqueue({ ...event, mac: signEvent(event, key) });
		},
		async enqueueExternal(draft) {
			return await enqueue(normalise(draft, "external"));
		},
		async receipt(eventId, outcome, detail) {
			const existing = await records.get(eventId);
			if (existing === undefined) return;
			await records.put({
				...existing,
				status: RECEIPT_STATUS[outcome],
				...(detail === undefined ? {} : { detail }),
				...(outcome === "delivered" ? { deliveredAt: now() } : {}),
			});
			options.changed(["events"]);
		},
		async maintain() {
			const t = now();
			await returnStaleClaims();
			let files = await inboxFiles();
			for (const { file, event } of files) {
				if (event === undefined) {
					await fs.rm(file, { force: true });
				} else if (event.kind !== "answer" && t - event.at > EVENT_TTL_MS) {
					await fs.rm(file, { force: true });
					await settle(event, "expired", "not delivered within 24 hours");
				}
			}
			files = (await inboxFiles()).filter(({ event }) => event !== undefined);
			// Over the cap, the oldest outside events go first: owner events are the owner's own answers and housekeeping.
			let over = files.length - MAX_PENDING_EVENTS;
			for (const { file, event } of files) {
				if (over <= 0) break;
				if (event === undefined || event.trust === "owner") continue;
				await fs.rm(file, { force: true });
				await settle(event, "expired", "dropped: too many events waiting");
				over--;
			}
		},
		async pending() {
			return (await inboxFiles()).length;
		},
	};
}
