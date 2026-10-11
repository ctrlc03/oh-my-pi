/**
 * The `sessions` and `session-search` requests for scripts/mock-companion.ts, so the command palette's
 * sessions and messages (and the all-sessions search) can be tried in a browser. The sessions are
 * canned: the mock companion's own hosts (live) plus a few ended ones, with a handful of prompts and
 * replies each.
 */

import type {
	CompanionHost,
	CompanionReply,
	CompanionRequest,
	SessionOverview,
	SessionSearchHit,
} from "../src/lib/companion";
import { queryTerms } from "../src/lib/search-terms";

const HOUR = 60 * 60 * 1000;

interface CannedMessage {
	role: "user" | "assistant";
	text: string;
}

const ENDED: { title: string; folder: string; messages: CannedMessage[] }[] = [
	{
		title: "billing-migration",
		folder: "/work/billing",
		messages: [
			{
				role: "user",
				text: "Migrate the invoices table to the new schema and keep the old column until the backfill is done.",
			},
			{
				role: "assistant",
				text: "The migration adds `invoice_total_cents`, backfills it in batches of 500 and keeps `total` readable for rollback.",
			},
		],
	},
	{
		title: "onboarding-flow",
		folder: "/work/web-app",
		messages: [
			{ role: "user", text: "The onboarding flow loses the draft when the user reloads on step three." },
			{ role: "assistant", text: "Step state now lives in the URL, so a reload on step three restores the draft." },
		],
	},
];

const LIVE_MESSAGES: CannedMessage[] = [
	{ role: "user", text: "Why is the login test flaky on CI?" },
	{
		role: "assistant",
		text: "The login test races the session cookie write; waiting on the cookie makes it deterministic.",
	},
];

export interface MockSearch {
	/** Fields the mock companion's `hosts` frame needs for the app to offer message search. */
	capabilities: { canSearch: true };
	handles(request: CompanionRequest): boolean;
	answer(request: CompanionRequest): CompanionReply;
}

export function createMockSearch(hosts: readonly CompanionHost[]): MockSearch {
	const now = Date.now();
	const everyone = (): { overview: SessionOverview; messages: CannedMessage[] }[] => [
		...hosts.map((host, n) => ({
			overview: {
				sessionId: host.sessionId,
				title: host.sessionName,
				folder: host.cwd,
				startedAt: host.startedAt,
				endedAt: null,
				requests: 12 + n,
				toolCalls: 40 + n,
				subagents: 0,
				tokens: 120_000,
				cost: 0.42,
				models: host.model === null ? [] : [host.model],
				instanceId: host.instanceId,
				live: "host" as const,
			},
			messages: LIVE_MESSAGES,
		})),
		...ENDED.map((session, n) => ({
			overview: {
				sessionId: `ended-${n}`,
				title: session.title,
				folder: session.folder,
				startedAt: now - (30 + n) * HOUR,
				endedAt: now - (29 + n) * HOUR,
				requests: 20,
				toolCalls: 60,
				subagents: 0,
				tokens: 200_000,
				cost: 1.1,
				models: ["anthropic/claude-sonnet-5-5"],
			},
			messages: session.messages,
		})),
	];
	return {
		capabilities: { canSearch: true },
		handles: request => request.t === "sessions" || request.t === "session-search",
		answer(request) {
			if (request.t === "sessions") {
				const terms = queryTerms(request.q ?? "");
				const sessions = everyone()
					.map(entry => entry.overview)
					.filter(session => {
						const haystack = `${session.title ?? ""} ${session.folder}`.toLowerCase();
						return terms.every(term => haystack.includes(term));
					})
					.slice(0, request.limit ?? 200);
				return { t: "sessions", reqId: request.reqId, sessions };
			}
			if (request.t !== "session-search") throw new Error(`the mock companion does not answer ${request.t}`);
			const terms = queryTerms(request.query);
			const results: SessionSearchHit[] = [];
			for (const { overview, messages } of everyone()) {
				messages.forEach((message, at) => {
					if (!terms.every(term => message.text.toLowerCase().includes(term))) return;
					results.push({
						sessionId: overview.sessionId,
						title: overview.title,
						cwd: overview.folder,
						entryId: `${overview.sessionId}-m${at}`,
						role: message.role,
						snippet: message.text,
						time: now - (at + 1) * 60_000,
						instanceId: overview.instanceId,
						live: overview.live,
					});
				});
			}
			return {
				t: "session-search",
				reqId: request.reqId,
				results: results.slice(0, request.limit ?? 50),
				truncated: false,
			};
		},
	};
}
