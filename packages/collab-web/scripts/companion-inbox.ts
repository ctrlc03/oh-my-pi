/**
 * The companion's inbox: hosted sessions that wait on an answer, and ones that
 * finished a turn recently, read from each session's file. Pure over its
 * inputs (entries come through `readEntries`) so it is testable from fixtures.
 */

import * as path from "node:path";
import type { CompanionHost, InboxItem } from "../src/lib/companion";
import { lastAssistantTurn, pendingAsk } from "./companion-sessions";

/** A finished turn older than this no longer counts as news. */
export const DONE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type Entries = Parameters<typeof pendingAsk>[0];

/**
 * Input items for hosts waiting on the user (their question and, for a single-choice
 * select, its options) and done items for idle hosts whose last turn ended within
 * {@link DONE_MAX_AGE_MS}; newest first.
 */
export async function buildInbox(
	hosts: readonly CompanionHost[],
	readEntries: (sessionId: string) => Promise<Entries>,
	now: number,
): Promise<InboxItem[]> {
	const items = await Promise.all(
		hosts.map(async (host): Promise<InboxItem | null> => {
			if (!host.inputRequired && host.busy !== false) return null;
			const entries = await readEntries(host.sessionId);
			const base = {
				instanceId: host.instanceId,
				title: host.sessionName || path.basename(host.cwd) || "session",
				cwd: host.cwd,
			};
			if (host.inputRequired) {
				const ask = pendingAsk(entries);
				return {
					...base,
					kind: "input",
					text: ask?.text ?? null,
					options: ask && ask.options.length > 0 ? ask.options : undefined,
					at: ask?.at ?? now,
				};
			}
			const turn = lastAssistantTurn(entries);
			if (!turn || turn.at === null || now - turn.at > DONE_MAX_AGE_MS) return null;
			return { ...base, kind: "done", text: turn.summary, at: turn.at };
		}),
	);
	return items.filter((item): item is InboxItem => item !== null).sort((a, b) => b.at - a.at);
}
