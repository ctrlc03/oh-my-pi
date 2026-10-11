import type { PromptMention } from "@oh-my-pi/pi-wire";
import { FolderGit2, GitPullRequest } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { GuestClient } from "../../lib/client";
import {
	activeMention,
	applyMention,
	matchPrs,
	matchSessions,
	type MentionQuery,
	mentionToken,
	type PrCandidate,
	prsInTexts,
	resolveMentions,
	type SessionCandidate,
} from "../../lib/mentions";
import "./slash-menu.css";
import "./mention-menu.css";

/** Where the composer's `#` and `@` find what they can name; each is null when nothing can supply it. */
export interface MentionSources {
	/** Open pull requests of the session's repository, read through the paired computer. */
	prs: (() => Promise<PrCandidate[]>) | null;
	/** Sessions on the paired computer, most recent first. */
	sessions: (() => Promise<SessionCandidate[]>) | null;
	/** This session's id: it is never offered to itself. */
	currentSessionId: string | null;
}

export interface MentionMenuOptions {
	client: GuestClient;
	/** The draft and where the caret is in it; the popup follows them. */
	text: string;
	caret: number;
	/** This guest may type a prompt (never a view-only link). */
	enabled: boolean;
	/** Null when the host does not expand mentions: `#` and `@` stay plain text. */
	sources: MentionSources | null;
	/** Writes the draft with the picked token in it, and where the caret goes. */
	onPick(text: string, caret: number): void;
}

export interface MentionMenu {
	/** The popup, anchored above the composer field; null while closed. */
	menu: ReactNode;
	/** Offer a key to the popup first; true when it was used (the caller must not handle it again). */
	onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): boolean;
	/** The references `text` still carries, for the prompt that sends it. */
	resolve(text: string): PromptMention[];
}

/** A list read from the computer is reused this long before the next `#` or `@` reads it again. */
const LIST_TTL_MS = 60_000;

type Loaded<T> =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "ready"; items: T[]; at: number }
	| { status: "error"; message: string };

interface Row {
	key: string;
	mention: PromptMention;
	label: string;
	detail: string;
}

function mentionKey(mention: PromptMention): string {
	return mention.kind === "pr" ? `pr:${mention.number}` : `session:${mention.id}`;
}

function folderName(folder: string | undefined): string {
	return folder ? (folder.split("/").filter(Boolean).at(-1) ?? folder) : "";
}

/** Text of recent transcript entries, where pull request links the agent or user mentioned can be found. */
function recentTexts(client: GuestClient): string[] {
	const texts: string[] = [];
	for (const entry of client.getSnapshot().entries.slice(-300)) {
		const content =
			entry.type === "custom_message" ? entry.content : entry.type === "message" ? entry.message.content : undefined;
		if (typeof content === "string") texts.push(content);
		else if (Array.isArray(content)) for (const part of content) if (part.type === "text") texts.push(part.text);
	}
	return texts;
}

/** Keeps one list from the computer: read on first need, again once stale, never twice at once. */
function useList<T>(load: (() => Promise<T[]>) | null, wanted: boolean): Loaded<T> {
	const [state, setState] = useState<Loaded<T>>({ status: "idle" });
	const loading = useRef(false);
	const attemptedAt = useRef(0);
	useEffect(() => {
		if (!wanted || load === null || loading.current) return;
		if (Date.now() - attemptedAt.current < LIST_TTL_MS) return;
		attemptedAt.current = Date.now();
		loading.current = true;
		setState(prev => (prev.status === "ready" ? prev : { status: "loading" }));
		load().then(
			items => {
				loading.current = false;
				setState({ status: "ready", items, at: Date.now() });
			},
			(err: unknown) => {
				loading.current = false;
				// A failure is retried the next time the list is wanted, not after the freshness window.
				attemptedAt.current = 0;
				setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
			},
		);
	}, [load, wanted]);
	return state;
}

/**
 * Typing `#` in the composer lists pull requests of the session's repository, `@` lists other sessions on the paired
 * computer. Picking one writes its token (`#123`, `@session:abcd1234`) into the draft and remembers the reference,
 * which the prompt carries to the host; typing a token by hand works once its list has loaded. `@` followed by a path
 * (`@src/app.ts`) is not offered a session and stays plain text.
 *
 * Tab or a click picks; Enter picks only after ↑/↓ moved the highlight, so it still sends a message that merely
 * contains a `#` or `@`.
 */
export function useMentionMenu({ client, text, caret, enabled, sources, onPick }: MentionMenuOptions): MentionMenu {
	const listId = useId();
	const known = useRef(new Map<string, PromptMention>());
	const query: MentionQuery | null = enabled && sources !== null ? activeMention(text, caret) : null;
	const prQuery = query?.kind === "pr";
	const sessionQuery = query?.kind === "session";
	const [dismissed, setDismissed] = useState<string | null>(null);
	// The highlighted row for the query it was chosen under; `moved` once ↑/↓ put it there, which lets Enter pick it.
	const [cursor, setCursor] = useState({ key: "", at: 0, moved: false });
	const activeRef = useRef<HTMLButtonElement | null>(null);

	const prList = useList(sources?.prs ?? null, prQuery);
	const sessionList = useList(sources?.sessions ?? null, sessionQuery);
	const open = query !== null && dismissed !== text;

	const kind = query?.kind;
	const typed = query?.query ?? "";
	// Pull requests the conversation links to: the list when no computer is paired, and what it lacks otherwise.
	const linked = useMemo(() => (open && kind === "pr" ? prsInTexts(recentTexts(client)) : []), [open, kind, client]);
	const rows = useMemo<Row[]>(() => {
		if (!open) return [];
		if (kind === "pr") {
			const listed = prList.status === "ready" ? prList.items : [];
			const mentioned = linked.filter(pr => !listed.some(item => item.number === pr.number));
			return matchPrs([...listed, ...mentioned], typed).map(pr => ({
				key: `pr:${pr.number}`,
				mention: { kind: "pr", number: pr.number, title: pr.title, url: pr.url },
				label: `#${pr.number}`,
				detail: pr.title,
			}));
		}
		const listed = sessionList.status === "ready" ? sessionList.items : [];
		if (kind !== "session") return [];
		return matchSessions(
			listed.filter(session => session.id !== sources?.currentSessionId),
			typed,
		).map(session => ({
			key: `session:${session.id}`,
			mention: { kind: "session", id: session.id, title: session.title },
			label: session.title,
			detail: folderName(session.folder),
		}));
	}, [open, kind, typed, prList, sessionList, linked, sources?.currentSessionId]);

	// What the lists loaded is what a hand-typed token resolves against.
	useEffect(() => {
		if (prList.status === "ready") {
			for (const pr of prList.items) {
				known.current.set(`pr:${pr.number}`, { kind: "pr", number: pr.number, title: pr.title, url: pr.url });
			}
		}
		if (sessionList.status === "ready") {
			for (const s of sessionList.items)
				known.current.set(`session:${s.id}`, { kind: "session", id: s.id, title: s.title });
		}
	}, [prList, sessionList]);

	const loading = (prQuery && prList.status === "loading") || (sessionQuery && sessionList.status === "loading");
	const failure =
		prQuery && prList.status === "error"
			? prList.message
			: sessionQuery && sessionList.status === "error"
				? sessionList.message
				: null;
	const shown = open && (rows.length > 0 || loading || failure !== null);
	const cursorKey = query === null ? "" : `${query.kind}:${query.query}`;
	const index = cursor.key === cursorKey ? Math.min(cursor.at, Math.max(0, rows.length - 1)) : 0;
	const moved = cursor.key === cursorKey && cursor.moved;

	useEffect(() => {
		activeRef.current?.scrollIntoView({ block: "nearest" });
	}, [index, shown]);

	const pick = (row: Row): void => {
		if (query === null) return;
		known.current.set(mentionKey(row.mention), row.mention);
		const next = applyMention(text, query, row.mention);
		onPick(next.text, next.caret);
	};

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
		if (!open || rows.length === 0 || e.nativeEvent.isComposing) return false;
		const chosen = rows[index];
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			const step = e.key === "ArrowDown" ? 1 : -1;
			setCursor({ key: cursorKey, at: (index + step + rows.length) % rows.length, moved: true });
			return true;
		}
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			setDismissed(text);
			return true;
		}
		if (e.key === "Tab" && !e.shiftKey) {
			e.preventDefault();
			pick(chosen);
			return true;
		}
		if (e.key === "Enter" && moved && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
			e.preventDefault();
			pick(chosen);
			return true;
		}
		return false;
	};

	const resolve = useCallback((draft: string): PromptMention[] => resolveMentions(draft, known.current.values()), []);

	const menu = shown ? (
		<div className="sh-slash">
			<div
				className="sh-slash-list"
				role="listbox"
				id={listId}
				aria-label={sessionQuery ? "sessions" : "pull requests"}
			>
				{rows.map((row, i) => {
					const on = i === index;
					return (
						<button
							key={row.key}
							ref={on ? activeRef : undefined}
							type="button"
							role="option"
							aria-selected={on}
							className={`sh-slash-item${on ? " sh-slash-item-on" : ""}`}
							// Keep the caret in the textarea so the keyboard stays up on phones.
							onMouseDown={e => e.preventDefault()}
							onClick={() => pick(row)}
						>
							{row.mention.kind === "pr" ? (
								<GitPullRequest size={14} className="sh-slash-icon" />
							) : (
								<FolderGit2 size={14} className="sh-slash-icon" />
							)}
							<span className="sh-mention-label">{row.label}</span>
							{row.detail && <span className="sh-slash-desc">{row.detail}</span>}
							<span className="sh-slash-tag">{mentionToken(row.mention)}</span>
						</button>
					);
				})}
				{loading && <div className="sh-mention-status">Loading…</div>}
				{failure !== null && rows.length === 0 && <div className="sh-mention-status">{failure}</div>}
			</div>
		</div>
	) : null;

	return { menu, onKeyDown, resolve };
}
