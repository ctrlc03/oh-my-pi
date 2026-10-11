import type { CollabCommand, SessionEntry } from "@oh-my-pi/pi-wire";
import { Laptop, LoaderCircle, type LucideIcon, MessageSquareText, Search, Slash, Zap } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useEffect, useId, useMemo, useState } from "react";
import type { CompanionClient, SessionOverview, SessionSearchHit } from "../../lib/companion";
import { highlightRuns } from "../../lib/fuzzy";
import { relTime, shortenPath } from "../../lib/format";
import { setJumpIntent } from "../../lib/jump-intent";
import {
	closePalette,
	DEFAULT_SECTION,
	loadRecents,
	type PaletteEntry,
	type PaletteItem,
	type PaletteScope,
	parseQuery,
	type Ranked,
	rankItems,
	rememberPick,
	SCOPE_PREFIX,
	usePaletteRegistry,
} from "../../lib/palette";
import { findMessages } from "../../lib/palette-messages";
import { extractLink, type RecentRoom } from "../../lib/rooms";
import { queryTerms, searchable, splitMatches } from "../../lib/search-terms";
import { effectiveKeys, formatCombo, IS_MAC, shortcutFires, useOverrides } from "../../lib/shortcuts";
import type { CompanionHandle } from "../../lib/use-companion";
import { Sheet } from "./Sheet";
import "./palette.css";

/** Rows shown per kind when nothing narrows the palette; a scope (`>`, `/`, `@`, `#`) lifts the cap. */
const LIMIT: Record<RowKind, number> = { action: 8, command: 6, session: 6, message: 6 };
const SCOPED_LIMIT = 50;
const RECENT_LIMIT = 6;
/** Rows of the empty palette per kind (the recent picks come first, outside these). */
const EMPTY_LIMIT: Record<RowKind, number> = { action: SCOPED_LIMIT, command: 0, session: 5, message: 0 };
const REMOTE_DEBOUNCE_MS = 250;
const REMOTE_LIMIT = 12;

type RowKind = "action" | "command" | "session" | "message";

const GROUP_LABEL: Record<RowKind, string> = {
	action: "Actions",
	command: "Commands",
	session: "Sessions",
	message: "Messages",
};

const KIND_ICON: Record<RowKind, LucideIcon> = {
	action: Zap,
	command: Slash,
	session: Laptop,
	message: MessageSquareText,
};

const SCOPE_OF_KIND: Record<RowKind, PaletteScope> = {
	action: "actions",
	command: "commands",
	session: "sessions",
	message: "messages",
};

const SCOPES: readonly { scope: PaletteScope | null; label: string }[] = [
	{ scope: null, label: "All" },
	{ scope: "actions", label: "Actions" },
	{ scope: "commands", label: "Commands" },
	{ scope: "sessions", label: "Sessions" },
	{ scope: "messages", label: "Messages" },
];

const PLACEHOLDER: Record<PaletteScope | "all", string> = {
	all: "Search actions, commands, sessions, messages",
	actions: "Search actions",
	commands: "Search slash commands",
	sessions: "Search sessions",
	messages: "Search what was said",
};

interface Row extends PaletteItem {
	kind: RowKind;
	icon: LucideIcon;
	subtitle?: string;
	/** Right-aligned text: the entry's section, a session's state, a message's author and age. */
	trailing?: string;
	/** Keycaps of the shortcut that does the same. */
	keys?: string;
	/** Words of a message hit to mark in its title. */
	terms?: readonly string[];
	/** Runs with the palette still open and shows its progress and error here; the palette closes when it resolves. */
	pending?: true;
	run(): void | Promise<void>;
}

interface Remote {
	sessions: SessionOverview[];
	hits: SessionSearchHit[];
	truncated: boolean;
	loading: boolean;
	error: string | null;
}

const NO_REMOTE: Remote = { sessions: [], hits: [], truncated: false, loading: false, error: null };

/** Past sessions and messages from the paired computer for what is typed; empty until it answers, and for a query too short to search. */
function useRemote(
	client: CompanionClient | null,
	canSearch: boolean,
	scope: PaletteScope | null,
	text: string,
): Remote {
	const [typed, setTyped] = useState(text);
	useEffect(() => {
		const timer = setTimeout(() => setTyped(text), REMOTE_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [text]);
	const [remote, setRemote] = useState<Remote>(NO_REMOTE);
	const wantSessions = scope === null || scope === "sessions";
	const wantMessages = canSearch && (scope === null || scope === "messages");
	useEffect(() => {
		if (client === null || !searchable(typed) || (!wantSessions && !wantMessages)) {
			setRemote(NO_REMOTE);
			return;
		}
		let stale = false;
		setRemote(previous => ({ ...previous, loading: true, error: null }));
		const sessionsCall = wantSessions
			? client.requestSessions({ limit: REMOTE_LIMIT, q: typed })
			: Promise.resolve<SessionOverview[]>([]);
		const messagesCall = wantMessages
			? client.searchSessions(typed, REMOTE_LIMIT)
			: Promise.resolve({ results: [] as SessionSearchHit[], truncated: false });
		void Promise.allSettled([sessionsCall, messagesCall]).then(([sessions, messages]) => {
			if (stale) return;
			const failure =
				sessions.status === "rejected" ? sessions.reason : messages.status === "rejected" ? messages.reason : null;
			setRemote({
				sessions: sessions.status === "fulfilled" ? sessions.value : [],
				hits: messages.status === "fulfilled" ? messages.value.results : [],
				truncated: messages.status === "fulfilled" && messages.value.truncated,
				loading: false,
				error: failure === null ? null : failure instanceof Error ? failure.message : String(failure),
			});
		});
		return () => {
			stale = true;
		};
	}, [client, wantSessions, wantMessages, typed]);
	return remote;
}

export interface CommandPaletteProps {
	/** What the palette opened with (`openPalette(query)`). */
	initial: string;
	/** Slash commands this writer can run, already without the ones that need a paired computer when there is none. */
	commands: readonly CollabCommand[];
	/** Every entry of the session on screen. */
	entries: readonly SessionEntry[];
	/** The session on screen; null before it is known. */
	sessionId: string | null;
	companion: CompanionHandle | null;
	rooms: readonly RecentRoom[];
	currentRoomId: string | null;
	/** Put `text` (`/name `) in the message box. */
	onCommand(text: string): void;
	/** Fetch a link for a hosting session and join it; rejects with a readable message. */
	onOpenHost(instanceId: string): Promise<void>;
	onOpenLink(link: string): void;
	/** Open the all-sessions sheet on a search, for results that need a choice (resume, share) before they open. */
	onOpenAllSessions(initial: { mode: "sessions" | "messages"; query: string }): void;
}

function sessionTitle(title: string | null, cwd: string): string {
	return title ?? (cwd.split("/").filter(Boolean).pop() || "Untitled");
}

/**
 * ⌘K: one search over what the app can do (registered actions), what the session can be told (its slash
 * commands), where else to go (sessions on the paired computer and recent rooms) and what was said (the
 * session on screen, and every session when the computer can search them). A leading `>`, `/`, `@` or `#`
 * narrows it to one kind. Picking a row runs it; the recent picks come first.
 */
export function CommandPalette({
	initial,
	commands,
	entries,
	sessionId,
	companion,
	rooms,
	currentRoomId,
	onCommand,
	onOpenHost,
	onOpenLink,
	onOpenAllSessions,
}: CommandPaletteProps): ReactNode {
	const listId = useId();
	const registry = usePaletteRegistry();
	// Remapped keys show in the rows and close the palette: both follow the overrides.
	const overrides = useOverrides();
	const [raw, setRaw] = useState(initial);
	const { scope, text } = parseQuery(raw);
	const [recents] = useState(loadRecents);
	const [active, setActive] = useState(0);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const live = companion?.snap.phase === "live";
	const client = live ? (companion?.client ?? null) : null;
	const remote = useRemote(client, live && companion?.snap.canSearch === true, scope, text);

	// The palette's own shortcut closes it from anywhere in the dialog (the one in the app only opens it).
	useEffect(() => {
		const onKey = (e: globalThis.KeyboardEvent): void => {
			if (e.isComposing || !shortcutFires("palette", e, null, IS_MAC)) return;
			e.preventDefault();
			closePalette();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const rows = useMemo(() => {
		const list: Row[] = [];
		const typing = text !== "";
		for (const entry of registry) {
			if (entry.searchOnly === true && !typing) continue;
			list.push(actionRow(entry));
		}
		for (const command of commands) {
			list.push({
				key: `command:${command.name}`,
				kind: "command",
				icon: Slash,
				title: `/${command.name}`,
				keywords: command.description ? [command.description] : undefined,
				subtitle: command.description,
				run: () => onCommand(`/${command.name} `),
			});
			if (!typing) continue;
			for (const choice of command.choices ?? []) {
				list.push({
					key: `command:${command.name} ${choice.value}`,
					kind: "command",
					icon: Slash,
					title: `/${command.name} ${choice.label ?? choice.value}`,
					subtitle: choice.description,
					run: () => onCommand(`/${command.name} ${choice.value}`),
				});
			}
		}
		const seen = new Set<string>(sessionId === null ? [] : [sessionId]);
		const hostInstances = new Set<string>();
		if (live && companion !== null) {
			for (const host of companion.snap.hosts) {
				hostInstances.add(host.instanceId);
				if (seen.has(host.sessionId)) continue;
				seen.add(host.sessionId);
				const state = host.inputRequired ? "needs input" : host.busy === true ? "working" : "live";
				list.push({
					key: `session:${host.sessionId}`,
					kind: "session",
					icon: Laptop,
					title: sessionTitle(host.sessionName, host.cwd),
					keywords: [host.cwd],
					subtitle: shortenPath(host.cwd),
					trailing: state,
					pending: true,
					run: () => onOpenHost(host.instanceId),
				});
			}
			for (const idle of companion.snap.idle) {
				hostInstances.add(idle.instanceId);
				if (seen.has(idle.sessionId)) continue;
				seen.add(idle.sessionId);
				list.push({
					key: `session:${idle.sessionId}`,
					kind: "session",
					icon: Laptop,
					title: sessionTitle(idle.sessionName, idle.cwd),
					keywords: [idle.cwd],
					subtitle: shortenPath(idle.cwd),
					trailing: "running",
					pending: true,
					run: async () => {
						const shared = companion.client;
						if (shared === null) throw new Error("the computer is not connected");
						const link = extractLink(await shared.shareSession(idle.instanceId));
						if (!link) throw new Error("the computer returned an unreadable link");
						onOpenLink(link);
					},
				});
			}
		}
		for (const room of rooms) {
			if (room.roomId === currentRoomId) continue;
			if (room.instanceId !== undefined && hostInstances.has(room.instanceId)) continue;
			list.push({
				key: `room:${room.roomId}`,
				kind: "session",
				icon: Laptop,
				title: room.title,
				keywords: room.cwd === null ? undefined : [room.cwd],
				subtitle: room.cwd === null ? undefined : shortenPath(room.cwd),
				trailing: relTime(room.lastSeen),
				run: () => onOpenLink(room.link),
			});
		}
		for (const past of remote.sessions) {
			if (seen.has(past.sessionId) || past.live !== undefined) continue;
			seen.add(past.sessionId);
			list.push({
				key: `past:${past.sessionId}`,
				kind: "session",
				icon: Laptop,
				title: sessionTitle(past.title, past.folder),
				keywords: [past.folder],
				subtitle: shortenPath(past.folder),
				trailing: `ended ${relTime(past.endedAt ?? past.startedAt)}`,
				run: () => onOpenAllSessions({ mode: "sessions", query: text }),
			});
		}
		if (searchable(text) && sessionId !== null) {
			const terms = queryTerms(text);
			for (const hit of findMessages(entries, text, REMOTE_LIMIT)) {
				list.push({
					key: `message:${hit.entryId}`,
					kind: "message",
					icon: MessageSquareText,
					title: hit.snippet,
					terms,
					trailing: `${hit.role === "user" ? "You" : "Agent"}${hit.time === null ? "" : ` · ${relTime(hit.time)}`}`,
					run: () => setJumpIntent({ sessionId, entryId: hit.entryId }),
				});
			}
		}
		if (searchable(text)) {
			const terms = queryTerms(text);
			for (const hit of remote.hits) {
				if (hit.sessionId === sessionId) continue;
				const { instanceId } = hit;
				const base = {
					key: `message:${hit.sessionId}:${hit.entryId}`,
					kind: "message",
					icon: MessageSquareText,
					title: hit.snippet,
					terms,
					subtitle: sessionTitle(hit.title, hit.cwd),
					trailing: `${hit.role === "user" ? "You" : "Agent"} · ${relTime(hit.time)}`,
				} satisfies Omit<Row, "run">;
				if (hit.live === "host" && instanceId !== undefined) {
					list.push({
						...base,
						pending: true,
						run: async () => {
							setJumpIntent({ sessionId: hit.sessionId, entryId: hit.entryId });
							try {
								await onOpenHost(instanceId);
							} catch (err) {
								setJumpIntent(null);
								throw err;
							}
						},
					});
				} else list.push({ ...base, run: () => onOpenAllSessions({ mode: "messages", query: text }) });
			}
		}
		return list;
	}, [
		registry,
		commands,
		entries,
		sessionId,
		companion,
		live,
		rooms,
		currentRoomId,
		remote,
		text,
		onCommand,
		onOpenHost,
		onOpenLink,
		onOpenAllSessions,
		// Keycaps are read while building the rows.
		overrides,
	]);

	const groups = useMemo(() => buildGroups(rows, scope, text, recents), [rows, scope, text, recents]);
	const flat = useMemo(() => groups.flatMap(group => group.rows), [groups]);
	const current = Math.min(active, Math.max(0, flat.length - 1));
	useEffect(() => {
		document.getElementById(`${listId}-${current}`)?.scrollIntoView({ block: "nearest" });
	}, [listId, current]);

	const choose = (ranked: Ranked<Row>): void => {
		if (busy !== null) return;
		const { item } = ranked;
		if (item.kind !== "message") rememberPick(item.key);
		if (item.pending !== true) {
			closePalette();
			void item.run();
			return;
		}
		setBusy(item.key);
		setError(null);
		Promise.resolve()
			.then(() => item.run())
			.then(
				() => closePalette(),
				(err: unknown) => {
					setError(err instanceof Error ? err.message : String(err));
					setBusy(null);
				},
			);
	};

	const move = (to: number): void => {
		if (flat.length === 0) return;
		setActive(Math.max(0, Math.min(flat.length - 1, to)));
	};
	const step = (delta: 1 | -1): void => {
		if (flat.length === 0) return;
		setActive((current + delta + flat.length) % flat.length);
	};
	const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
		if (e.nativeEvent.isComposing) return;
		if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
			e.preventDefault();
			step(1);
		} else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
			e.preventDefault();
			step(-1);
		} else if (e.key === "PageDown") {
			e.preventDefault();
			move(current + 8);
		} else if (e.key === "PageUp") {
			e.preventDefault();
			move(current - 8);
		} else if (e.key === "Enter") {
			e.preventDefault();
			const picked = flat[current];
			if (picked !== undefined) choose(picked);
		}
	};

	const typedAnything = raw.trim() !== "";
	const waiting = remote.loading;
	let index = -1;

	return (
		<Sheet label="command palette" size="palette" onClose={closePalette}>
			<div className="sh-palette">
				<label className="sh-palette-input">
					<Search size={16} />
					<input
						className="sh-palette-field"
						value={raw}
						onChange={e => {
							setRaw(e.currentTarget.value);
							setActive(0);
							setError(null);
						}}
						onKeyDown={onKeyDown}
						placeholder={PLACEHOLDER[scope ?? "all"]}
						role="combobox"
						aria-expanded
						aria-controls={listId}
						aria-activedescendant={flat.length > 0 ? `${listId}-${current}` : undefined}
						aria-label="search actions, commands, sessions and messages"
						autoCapitalize="off"
						autoCorrect="off"
						autoComplete="off"
						spellCheck={false}
						enterKeyHint="go"
						autoFocus
					/>
					{waiting && <LoaderCircle size={14} className="sh-spin" />}
				</label>
				<div className="sh-palette-scopes" role="group" aria-label="search in">
					{SCOPES.map(item => (
						<button
							key={item.label}
							type="button"
							className={scope === item.scope ? "sh-palette-scope sh-palette-scope-on" : "sh-palette-scope"}
							aria-pressed={scope === item.scope}
							onClick={() => {
								setRaw(item.scope === null ? text : `${SCOPE_PREFIX[item.scope]}${text}`);
								setActive(0);
							}}
						>
							{item.label}
						</button>
					))}
				</div>
				{error !== null && <div className="sh-connect-error">{error}</div>}
				{remote.error !== null && (
					<div className="sh-palette-note">Your computer's search failed: {remote.error}</div>
				)}
				<ul className="sh-palette-list" id={listId} role="listbox" aria-label="results">
					{groups.map(group => (
						<li key={group.label} role="presentation" className="sh-palette-section">
							<div className="sh-palette-group" role="presentation">
								{group.label}
							</div>
							<ul role="presentation" className="sh-palette-rows">
								{group.rows.map(ranked => {
									index += 1;
									const at = index;
									const { item } = ranked;
									const Icon = item.icon;
									return (
										<li
											key={item.key}
											id={`${listId}-${at}`}
											role="option"
											aria-selected={at === current}
											className={at === current ? "sh-palette-row sh-palette-row-on" : "sh-palette-row"}
											onMouseMove={() => {
												if (at !== current) setActive(at);
											}}
											onClick={() => choose(ranked)}
										>
											<Icon size={15} className="sh-palette-icon" />
											<span className="sh-palette-copy">
												<span className="sh-palette-title">
													<Marked item={item} positions={ranked.positions} />
												</span>
												{item.subtitle !== undefined && item.subtitle !== "" && (
													<span className="sh-palette-sub">{item.subtitle}</span>
												)}
											</span>
											{busy === item.key ? (
												<LoaderCircle size={14} className="sh-spin" />
											) : (
												<>
													{item.trailing !== undefined && (
														<span className="sh-palette-trail">{item.trailing}</span>
													)}
													{item.keys !== undefined && (
														<kbd className="sh-kbd sh-palette-kbd">{item.keys}</kbd>
													)}
												</>
											)}
										</li>
									);
								})}
							</ul>
						</li>
					))}
				</ul>
				{flat.length === 0 && (
					<div className="sh-companion-empty">
						{waiting
							? "Searching…"
							: typedAnything
								? scope === "messages" && !searchable(text)
									? "Type at least two characters to search what was said."
									: "Nothing matches."
								: "Nothing to list yet."}
					</div>
				)}
				{remote.truncated && (
					<div className="sh-palette-note">Showing the newest messages. Add a word to narrow the search.</div>
				)}
				<div className="sh-palette-foot" aria-hidden>
					<span>
						<kbd className="sh-kbd">↑</kbd> <kbd className="sh-kbd">↓</kbd> move
					</span>
					<span>
						<kbd className="sh-kbd">↵</kbd> run
					</span>
					<span>
						<kbd className="sh-kbd">&gt;</kbd> actions · <kbd className="sh-kbd">/</kbd> commands ·{" "}
						<kbd className="sh-kbd">@</kbd> sessions · <kbd className="sh-kbd">#</kbd> messages
					</span>
				</div>
			</div>
		</Sheet>
	);
}

function actionRow(entry: PaletteEntry): Row {
	const section = entry.section ?? DEFAULT_SECTION;
	return {
		key: `action:${entry.id}`,
		kind: "action",
		icon: entry.icon ?? KIND_ICON.action,
		title: entry.title,
		keywords: [section, ...(entry.keywords ?? [])],
		trailing: section === DEFAULT_SECTION ? undefined : section,
		keys: entry.shortcut === undefined ? undefined : formatCombo(effectiveKeys(entry.shortcut), IS_MAC),
		run: entry.run,
	};
}

interface Group {
	label: string;
	rows: Ranked<Row>[];
}

/** A group of ranked rows for each kind that has any, in the order they should show. */
function buildGroups(
	rows: readonly Row[],
	scope: PaletteScope | null,
	text: string,
	recents: readonly string[],
): Group[] {
	const kinds = (Object.keys(GROUP_LABEL) as RowKind[]).filter(
		kind => scope === null || SCOPE_OF_KIND[kind] === scope,
	);
	const taken = new Set<string>();
	const groups: { group: Group; top: number; order: number }[] = [];
	if (scope === null && text === "") {
		const recent = rankItems(
			rows.filter(row => row.kind !== "message" && recents.includes(row.key)),
			"",
			recents,
		).slice(0, RECENT_LIMIT);
		if (recent.length > 0) {
			for (const ranked of recent) taken.add(ranked.item.key);
			groups.push({ group: { label: "Recent", rows: recent }, top: Number.POSITIVE_INFINITY, order: -1 });
		}
	}
	kinds.forEach((kind, order) => {
		const own = rows.filter(row => row.kind === kind && !taken.has(row.key));
		const cap = scope !== null ? SCOPED_LIMIT : text === "" ? EMPTY_LIMIT[kind] : LIMIT[kind];
		// Messages are word matches, not fuzzy: they keep their newest-first order.
		const ranked =
			kind === "message" ? own.map(item => ({ item, score: 0, positions: [] })) : rankItems(own, text, recents);
		const shown = ranked.slice(0, cap);
		if (shown.length === 0) return;
		groups.push({
			group: { label: GROUP_LABEL[kind], rows: shown },
			top: kind === "message" ? Number.NEGATIVE_INFINITY : shown[0]!.score,
			order,
		});
	});
	// The kind holding the best match leads; with nothing typed, or on a tie, the kinds keep their usual order.
	groups.sort((a, b) => (text === "" ? 0 : b.top - a.top) || a.order - b.order);
	return groups.map(entry => entry.group);
}

/** The row's title with the matched characters (or, for a message, the searched words) marked. */
function Marked({ item, positions }: { item: Row; positions: readonly number[] }): ReactNode {
	const runs = item.terms !== undefined ? splitMatches(item.title, item.terms) : highlightRuns(item.title, positions);
	let offset = 0;
	return runs.map(run => {
		const at = offset;
		offset += run.text.length;
		return run.hit ? (
			<mark key={at} className="sh-palette-hit">
				{run.text}
			</mark>
		) : (
			<span key={at}>{run.text}</span>
		);
	});
}
