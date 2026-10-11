/**
 * References in a prompt: `#123` names a pull request of the session's repository, `@session:<id>` another
 * omp session. The text keeps the token as typed; the references travel beside it (`prompt.mentions`), and
 * the host appends what the agent needs to resolve each one. `@` followed by anything else (`@src/app.ts`)
 * is plain text and never opens the menu.
 */
import type { PromptMention } from "@oh-my-pi/pi-wire";

/** Rows the menu lists at once. */
export const MAX_MENTION_ROWS = 8;
/** The host's marker for the block it appends; `stripMentionContext` removes it from prompts shown back. */
const CONTEXT_BLOCK = /\n*<referenced-context>[\s\S]*<\/referenced-context>\s*$/;
/** Characters of a session id the typed token shows. */
const SESSION_TOKEN_ID_CHARS = 8;

/** A pull request a `#` can name; `url` is empty when only its number is known. */
export interface PrCandidate {
	number: number;
	title: string;
	url: string;
}

/** A session an `@` can name. */
export interface SessionCandidate {
	id: string;
	title: string;
	/** Folder the session ran in, for telling same-titled sessions apart. */
	folder?: string;
}

/** The text a picked mention leaves in the prompt. */
export function mentionToken(mention: PromptMention): string {
	return mention.kind === "pr" ? `#${mention.number}` : `@session:${mention.id.slice(0, SESSION_TOKEN_ID_CHARS)}`;
}

/** The mention being typed at the caret: its kind, what follows the sigil, and the range to replace. */
export interface MentionQuery {
	kind: "pr" | "session";
	query: string;
	start: number;
	end: number;
}

/**
 * The `#` or `@` token ending at `caret`, or null. The sigil must start a word, so `a#1` and an e-mail
 * address are left alone; an `@` query is a session name or id, so it stops at the first character
 * a file path would contain (`/`, `.`) and `@src/app.ts` never offers a session.
 */
export function activeMention(text: string, caret: number): MentionQuery | null {
	const head = text.slice(0, caret);
	const pr = /(?:^|[\s(])#(\d*)$/.exec(head);
	if (pr) return { kind: "pr", query: pr[1] ?? "", start: caret - (pr[1]?.length ?? 0) - 1, end: caret };
	const session = /(?:^|[\s(])@([\w:-]*)$/.exec(head);
	if (session)
		return { kind: "session", query: session[1] ?? "", start: caret - (session[1]?.length ?? 0) - 1, end: caret };
	return null;
}

/** `text` with the mention being typed replaced by `mention`'s token and a space, and where the caret goes. */
export function applyMention(text: string, at: MentionQuery, mention: PromptMention): { text: string; caret: number } {
	const token = `${mentionToken(mention)} `;
	const rest = text.slice(at.end);
	const next = text.slice(0, at.start) + token + (rest.startsWith(" ") ? rest.slice(1) : rest);
	return { text: next, caret: at.start + token.length };
}

/** Pull requests whose number starts with, or whose title contains, the query; exact number first. */
export function matchPrs(prs: readonly PrCandidate[], query: string): PrCandidate[] {
	const q = query.trim().toLowerCase();
	const hits = prs.filter(pr => q === "" || String(pr.number).startsWith(q) || pr.title.toLowerCase().includes(q));
	hits.sort((a, b) => Number(String(b.number) === q) - Number(String(a.number) === q) || b.number - a.number);
	return hits.slice(0, MAX_MENTION_ROWS);
}

/** Sessions whose title, folder or id contains the query (`session:` prefix allowed), in the given order. */
export function matchSessions(sessions: readonly SessionCandidate[], query: string): SessionCandidate[] {
	const q = query
		.trim()
		.toLowerCase()
		.replace(/^session:?/, "");
	const hits = sessions.filter(
		session =>
			q === "" ||
			session.title.toLowerCase().includes(q) ||
			session.id.toLowerCase().startsWith(q) ||
			(session.folder?.toLowerCase().includes(q) ?? false),
	);
	return hits.slice(0, MAX_MENTION_ROWS);
}

/** Pull request references on `text` by number (`#123`), in order of appearance. */
const PR_TOKEN = /(?:^|[\s(])#(\d+)(?![\w-])/g;
const SESSION_TOKEN = /(?:^|[\s(])@session:([\w-]{4,64})(?![\w-])/g;

/**
 * The mentions `text` still carries, taken from what is known about them (picked in the menu, or listed
 * earlier): a `#N` with a known pull request, an `@session:<id>` whose id starts the known session's.
 * Each reference appears once.
 */
export function resolveMentions(text: string, known: Iterable<PromptMention>): PromptMention[] {
	const prs = new Map<number, PromptMention>();
	const sessions: Extract<PromptMention, { kind: "session" }>[] = [];
	for (const mention of known) {
		if (mention.kind === "pr") prs.set(mention.number, mention);
		else sessions.push(mention);
	}
	const found: PromptMention[] = [];
	for (const match of text.matchAll(PR_TOKEN)) {
		const pr = prs.get(Number(match[1]));
		if (pr && !found.includes(pr)) found.push(pr);
	}
	for (const match of text.matchAll(SESSION_TOKEN)) {
		const typed = match[1] ?? "";
		const session = sessions.find(candidate => candidate.id.startsWith(typed));
		if (session && !found.includes(session)) found.push(session);
	}
	return found;
}

/** `text` without the context block the host appended to a prompt that carried mentions. */
export function stripMentionContext(text: string): string {
	return text.replace(CONTEXT_BLOCK, "");
}

/** Pull request URLs (`https://host/owner/repo/pull/N`) in `texts`, newest first, one per number. */
export function prsInTexts(texts: Iterable<string>): PrCandidate[] {
	const seen = new Map<number, PrCandidate>();
	for (const text of texts) {
		for (const match of text.matchAll(/https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\/pull\/(\d+)(?![\w-])/g)) {
			const number = Number(match[1]);
			seen.set(number, { number, title: "", url: match[0] });
		}
	}
	return [...seen.values()].reverse();
}
