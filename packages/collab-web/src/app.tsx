import type { SessionCommand } from "@oh-my-pi/pi-wire";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentDrawer } from "./components/agents/AgentDrawer";
import { AgentsPanel, isInactive } from "./components/agents/AgentsPanel";
import { LazyCodemapSheet } from "./components/codemap/LazyCodemapSheet";
import { LazyIdeSheet } from "./components/ide/LazyIdeSheet";
import { Banners } from "./components/shell/Banners";
import { ChangesSheet } from "./components/shell/ChangesSheet";
import { Composer, type ComposerHandle } from "./components/shell/Composer";
import { ConnectScreen } from "./components/shell/ConnectScreen";
import { useEditPrompt } from "./components/shell/EditPromptSheet";
import { FileSheet } from "./components/shell/FileSheet";
import { FixItHost } from "./components/shell/FixItHost";
import { HeaderBar } from "./components/shell/HeaderBar";
import { useMedia } from "./components/codemap/shared";
import { PaneSheet } from "./components/shell/PaneSheet";
import { GithubSheet } from "./components/shell/GithubSheet";
import { PreviewSheet } from "./components/shell/PreviewSheet";
import { RunSheet } from "./components/shell/RunSheet";
import { ScreensSheet } from "./components/shell/ScreensSheet";
import { SearchBar } from "./components/shell/SearchBar";
import { SessionAlert } from "./components/shell/SessionAlert";
import { SessionsSheet } from "./components/shell/SessionsSheet";
import { SessionsSidebar } from "./components/shell/SessionsSidebar";
import { SplitPane } from "./components/shell/SplitPane";
import { TaskProgress } from "./components/shell/TaskProgress";
import { Toasts } from "./components/shell/Toasts";
import { UpdateBar } from "./components/shell/UpdateBar";
import { UsageSheet } from "./components/shell/UsageSheet";
import { Transcript } from "./components/transcript/Transcript";
import { collectChanges } from "./lib/changes";
import { GuestClient } from "./lib/client";
import { extractPairing, loadPairing, type Pairing, savePairing } from "./lib/companion";
import { subscribeDraft } from "./lib/draft-bus";
import { sessionMarkdown } from "./lib/export";
import { blobToBase64 } from "./lib/images";
import { useAppBadge } from "./lib/badge";
import { applyOpenIntent, claimPendingAnswer, setOpenIntent } from "./lib/inbox";
import { onJumpIntent, takeJumpIntent } from "./lib/jump-intent";
import { useNewSince } from "./lib/new-since";
import { emitRoute, parseRoute } from "./lib/notify-route";
import { type PushControl, usePush } from "./lib/push";
import { registerServiceWorker, takeSharedLink } from "./lib/pwa";
import {
	activeLink,
	extractLink,
	forgetRoom,
	loadRooms,
	moveRoom,
	type RecentRoom,
	rememberRoom,
	roomIdOf,
	setActiveLink,
} from "./lib/rooms";
import { collectScreens } from "./lib/screens";
import {
	type BesideControl,
	focusedPane,
	loadIdeDock,
	saveIdeDock,
	TWO_PANES_QUERY,
	useBesideSession,
	useClientWake,
} from "./lib/use-split";
import { readJson, writeJson } from "./lib/storage";
import { currentSubagents } from "./lib/subagents";
import { currentTodos } from "./lib/todos";
import { loadTrim, saveTrim, trimEntries } from "./lib/trim";
import { sumUsage } from "./lib/usage";
import { type CompanionHandle, useCompanion } from "./lib/use-companion";
import { useHostRecovery } from "./lib/use-host-recovery";
import { useGuestSnapshot } from "./lib/use-guest";
import type { ToolRenderHost } from "./tool-render";
import "./components/shell/shell.css";
import "./components/shell/companion.css";
import "./components/codemap/codemap.css";

const NAME_KEY = "omp.collab.name";
/** Chat view preference (boolean); absent: phones get chat, larger screens the full transcript. */
const CHAT_KEY = "omp.collab.chat";
/** Docked sessions sidebar preference (boolean, docked widths only); absent: open. */
const SIDEBAR_KEY = "omp.collab.sidebar";
/** Matches the shell.css breakpoint where the sessions sidebar stops docking beside the panel. */
const SIDEBAR_DOCK_QUERY = "(min-width: 1101px)";
const PHONE_QUERY = "(max-width: 640px)";
/** Matches the shell.css breakpoint where the rail stops docking beside the transcript. */
const WIDE_QUERY = "(min-width: 901px)";
/** Visual viewport this much shorter than the layout viewport means an on-screen keyboard is up. */
const KEYBOARD_MIN_PX = 120;

interface Creds {
	link: string;
	name: string;
}

function storedName(): string {
	try {
		return localStorage.getItem(NAME_KEY) ?? "guest";
	} catch {
		return "guest";
	}
}

/** Deep link = everything after the FIRST `#` (legacy links carry a second `#` inside the fragment). */
function hashLink(): string | null {
	const href = window.location.href;
	const i = href.indexOf("#");
	if (i < 0 || i + 1 >= href.length) return null;
	return href.slice(i + 1);
}

export function App(): ReactNode {
	const [client, setClient] = useState<GuestClient | null>(null);
	/**
	 * The client on screen, closed here rather than inside a state updater: closing
	 * notifies the session's store, and updaters run while React renders App.
	 */
	const clientRef = useRef<GuestClient | null>(null);
	const [link, setLink] = useState<string | null>(null);
	const [connectError, setConnectError] = useState<string | null>(null);
	const [rooms, setRooms] = useState<RecentRoom[]>(loadRooms);
	const [pairing, setPairing] = useState<Pairing | null>(loadPairing);
	/** Companion host to open once the companion is live (notification tap). */
	const [pendingOpen, setPendingOpen] = useState<string | null>(null);
	/** The companion process the current link was fetched from, until the session's welcome identifies it. */
	const [opened, setOpened] = useState<{ link: string; instanceId: string } | null>(null);
	const credsRef = useRef<Creds | null>(null);
	/** The current session was reopened from storage, not chosen by the user this launch. */
	const resumedRef = useRef(false);
	const companion = useCompanion(pairing);
	const push = usePush(companion.client, companion.snap.vapidKey);

	const connect = useCallback((link: string, name: string): void => {
		let next: GuestClient;
		try {
			next = new GuestClient(link, name);
		} catch (err) {
			setConnectError(err instanceof Error ? err.message : String(err));
			return;
		}
		next.connect();
		try {
			localStorage.setItem(NAME_KEY, name);
		} catch {
			// storage unavailable (private mode) — non-fatal
		}
		credsRef.current = { link, name };
		setActiveLink(link);
		window.location.hash = link;
		setLink(link);
		setConnectError(null);
		clientRef.current?.close();
		clientRef.current = next;
		setClient(next);
	}, []);

	const leave = useCallback((): void => {
		setActiveLink(null);
		setRooms(loadRooms());
		clientRef.current?.close();
		clientRef.current = null;
		setClient(null);
		history.replaceState(null, "", window.location.pathname + window.location.search);
	}, []);

	const forget = useCallback((roomId: string): void => setRooms(forgetRoom(roomId)), []);

	const rejoin = useCallback((): void => {
		const creds = credsRef.current;
		resumedRef.current = false;
		if (creds) connect(creds.link, creds.name);
	}, [connect]);

	const remember = useCallback((room: Omit<RecentRoom, "lastSeen">): void => setRooms(rememberRoom(room)), []);

	// The host replaced the session's room: follow it, carrying the draft and queued prompts.
	const replaceRoom = useCallback(
		(from: string, next: string, instanceId: string): void => {
			const to = roomIdOf(next);
			if (to !== null) setRooms(moveRoom(from, to));
			resumedRef.current = false;
			connect(next, credsRef.current?.name ?? storedName());
			setOpened({ link: next, instanceId });
		},
		[connect],
	);

	const pair = useCallback((next: Pairing | null): void => {
		savePairing(next);
		setPairing(next);
	}, []);

	const companionClient = companion.client;
	const openHost = useCallback(
		async (instanceId: string): Promise<void> => {
			if (!companionClient) throw new Error("no paired computer");
			const url = await companionClient.requestLink(instanceId);
			const next = extractLink(url);
			if (!next) throw new Error("the computer returned an unreadable link");
			applyOpenIntent(instanceId, next);
			resumedRef.current = false;
			connect(next, credsRef.current?.name ?? storedName());
			setOpened({ link: next, instanceId });
		},
		[companionClient, connect],
	);

	const openLink = useCallback(
		(next: string): void => {
			resumedRef.current = false;
			connect(next, credsRef.current?.name ?? storedName());
		},
		[connect],
	);

	const { phase: companionPhase, hosts } = companion.snap;
	// The app icon shows how many sessions wait on an answer, once the computer's list is known.
	useAppBadge(companionPhase === "live" ? hosts.filter(host => host.inputRequired).length : null);

	/** A notification tap's route: open a session (sending the reply typed in the notification once it is live), or pass it to the component that owns it. */
	const followRoute = useCallback((hash: string): boolean => {
		const route = parseRoute(hash);
		if (route === null) return false;
		if (route.kind === "route") {
			emitRoute(route.route);
			return true;
		}
		if (route.reply !== null) setOpenIntent(route.instanceId, { prompt: route.reply });
		setPendingOpen(route.instanceId);
		return true;
	}, []);

	// A notification tap: open its session as soon as the companion lists hosts.
	useEffect(() => {
		if (pendingOpen === null || companionPhase !== "live") return;
		setPendingOpen(null);
		if (!hosts.some(host => host.instanceId === pendingOpen)) {
			setConnectError("That session is no longer sharing.");
			return;
		}
		openHost(pendingOpen).catch((err: unknown) => setConnectError(err instanceof Error ? err.message : String(err)));
	}, [pendingOpen, companionPhase, hosts, openHost]);

	useEffect(() => {
		if (!("serviceWorker" in navigator)) return;
		const onMessage = (e: MessageEvent): void => {
			const data = e.data as { t?: unknown; instanceId?: unknown; text?: unknown; route?: unknown } | null;
			if (data?.t === "open-session" && typeof data.instanceId === "string") setPendingOpen(data.instanceId);
			else if (
				data?.t === "notification-reply" &&
				typeof data.instanceId === "string" &&
				typeof data.text === "string"
			) {
				if (data.text.trim()) setOpenIntent(data.instanceId, { prompt: data.text });
				setPendingOpen(data.instanceId);
			} else if (data?.t === "open-route" && typeof data.route === "string") followRoute(data.route);
		};
		navigator.serviceWorker.addEventListener("message", onMessage);
		return () => navigator.serviceWorker.removeEventListener("message", onMessage);
	}, [followRoute]);

	// The companion holds pushes for this device while it shows the app.
	const pushEndpoint = push.endpoint;
	useEffect(() => {
		if (!companionClient) return;
		const report = (): void => companionClient.setPresence(pushEndpoint, document.visibilityState === "visible");
		report();
		document.addEventListener("visibilitychange", report);
		return () => document.removeEventListener("visibilitychange", report);
	}, [companionClient, pushEndpoint]);

	// A room reopened from storage that the host has since closed: go straight to the
	// session list instead of parking on an "ended" card the user never asked for.
	const roomGone = useCallback(
		(roomId: string): void => {
			setRooms(forgetRoom(roomId));
			if (resumedRef.current) leave();
		},
		[leave],
	);

	// Visual Viewport: adjust app height to fit screen space when mobile keyboard opens.
	useEffect(() => {
		const vv = window.visualViewport;
		if (!vv) return;

		const updateHeight = () => {
			document.documentElement.style.setProperty("--viewport-height", `${vv.height}px`);
			document.documentElement.toggleAttribute("data-keyboard", window.innerHeight - vv.height > KEYBOARD_MIN_PX);
			window.scrollTo(0, 0);
		};

		updateHeight();
		vv.addEventListener("resize", updateHeight);
		vv.addEventListener("scroll", updateHeight);

		return () => {
			vv.removeEventListener("resize", updateHeight);
			vv.removeEventListener("scroll", updateHeight);
		};
	}, []);

	// Launch: a pairing link opens the session list; otherwise a deep link in the hash
	// wins, then a share-sheet payload, then the session this client was showing when
	// the OS last killed it (home-screen launches open `start_url`, which carries no fragment).
	useEffect(() => {
		registerServiceWorker();
		const hash = hashLink();
		const companionLink = hash ? extractPairing(hash) : null;
		if (companionLink) {
			pair(companionLink);
			history.replaceState(null, "", window.location.pathname + window.location.search);
			return;
		}
		if (hash !== null && followRoute(hash)) {
			history.replaceState(null, "", window.location.pathname + window.location.search);
			return;
		}
		const explicit = hash ?? takeSharedLink();
		const initial = explicit ?? activeLink();
		if (!initial) return;
		connect(initial, storedName());
		resumedRef.current = explicit === null;
	}, [connect, pair, followRoute]);

	// Back from the background, network back, going to the background: see `useClientWake`.
	useClientWake(client);
	const besideName = useCallback((): string => credsRef.current?.name ?? storedName(), []);
	const beside = useBesideSession(client ? link : null, companion.client, besideName, setRooms);

	useEffect(() => {
		if (!client) document.title = "omp collab";
	}, [client]);

	return (
		<>
			<UpdateBar />
			<FixItHost
				client={companionClient}
				live={companionPhase === "live"}
				canFixIt={companion.snap.canFixIt}
				canStart={companion.snap.canStart}
				onOpenHost={openHost}
				onOpenLink={openLink}
			/>
			{!client || !link ? (
				<ConnectScreen
					defaultName={storedName()}
					error={connectError}
					rooms={rooms}
					companion={pairing ? companion : null}
					push={push}
					onConnect={(next, name) => {
						resumedRef.current = false;
						connect(next, name);
					}}
					onForget={forget}
					onPair={pair}
					onUnpair={() => {
						if (window.confirm("Unpair this computer? You will need its pairing code to pair again.")) pair(null);
					}}
				/>
			) : (
				<Session
					key={link}
					client={client}
					link={link}
					openedInstance={opened?.link === link ? opened.instanceId : null}
					companion={pairing ? companion : null}
					push={push}
					rooms={rooms}
					onLeave={leave}
					onRejoin={rejoin}
					onRemember={remember}
					onRoomGone={roomGone}
					onRoomReplaced={replaceRoom}
					onOpenHost={openHost}
					beside={beside}
					onOpenLink={openLink}
				/>
			)}
		</>
	);
}

interface SessionProps {
	client: GuestClient;
	link: string;
	openedInstance: string | null;
	companion: CompanionHandle | null;
	push: PushControl;
	rooms: readonly RecentRoom[];
	onLeave(): void;
	onRejoin(): void;
	onRemember(room: Omit<RecentRoom, "lastSeen">): void;
	onRoomGone(roomId: string): void;
	onRoomReplaced(from: string, link: string, instanceId: string): void;
	onOpenHost(instanceId: string): Promise<void>;
	onOpenLink(link: string): void;
	/** Split view: the second session pane and the controls that open it. */
	beside: BesideControl;
}

function initialChat(): boolean {
	const stored = readJson(CHAT_KEY);
	return typeof stored === "boolean" ? stored : matchMedia(PHONE_QUERY).matches;
}

/** Wide screens restore the docked sidebar; elsewhere it is a drawer and starts closed. */
function initialSidebar(): boolean {
	return matchMedia(SIDEBAR_DOCK_QUERY).matches && readJson(SIDEBAR_KEY) !== false;
}

interface SearchState {
	query: string;
	target: string | null;
}

function Session({
	client,
	link,
	openedInstance,
	companion,
	push,
	rooms,
	onLeave,
	onRejoin,
	onRemember,
	onRoomGone,
	onRoomReplaced,
	onOpenHost,
	onOpenLink,
	beside,
}: SessionProps): ReactNode {
	const snap = useGuestSnapshot(client);
	const [railOpen, setRailOpen] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const autoOpenedRef = useRef(false);

	// Parked and aborted subagents stay in the rail (folded) but do not count on the badge or open the rail.
	const subCount = useMemo(() => snap.agents.filter(a => a.kind === "sub" && !isInactive(a)).length, [snap.agents]);

	// The paired computer's host for this very session. Working tree and file
	// viewing read through it, and are hidden when there is none.
	const sessionId = snap.header?.id ?? null;
	const companionClient = companion?.client ?? null;
	const hosts = companion?.snap.hosts;
	const hostId = useMemo(
		() => hosts?.find(host => host.sessionId === sessionId)?.instanceId ?? null,
		[hosts, sessionId],
	);
	const hostRow = hosts?.find(host => host.instanceId === hostId);
	const [file, setFile] = useState<{ path: string; line?: number } | null>(null);
	const [codemap, setCodemap] = useState<{ file?: string } | null>(null);
	const canCodemap = companionClient !== null && hostId !== null && companion?.snap.canCodemap === true;
	const openCodemap = useCallback(() => setCodemap({}), []);
	// The editor replaces the read-only file viewer once the paired computer can save files.
	const canEdit = companionClient !== null && hostId !== null && companion?.snap.canEdit === true;
	const [editor, setEditor] = useState<{ target: { path: string; line?: number } | null } | null>(null);
	const openEditor = useCallback(() => setEditor(open => open ?? { target: null }), []);
	const openFile = useCallback(
		(path: string, line?: number) => (canEdit ? setEditor({ target: { path, line } }) : setFile({ path, line })),
		[canEdit],
	);
	const [paneOpen, setPaneOpen] = useState(false);
	const openPane = useCallback(() => setPaneOpen(true), []);
	const canPreview =
		companionClient !== null && hostId !== null && sessionId !== null && companion?.snap.canPreview === true;
	// Voice input rides the companion; a reconnect blip (`connecting`) must not discard a recording.
	const companionPhase = companion?.snap.phase;
	const transcribe = companion?.snap.transcribe ?? null;
	const machine = companion?.snap.machine ?? null;
	const voice = useMemo(
		() =>
			companionClient !== null &&
			transcribe !== null &&
			(companionPhase === "live" || companionPhase === "connecting")
				? { client: companionClient, info: transcribe, machine }
				: null,
		[companionClient, transcribe, machine, companionPhase],
	);
	// Attachments the composer cannot inline are saved on the computer, which the agent reads them from.
	const canUpload = companion?.snap.canUpload === true;
	const upload = useMemo(
		() =>
			companionClient !== null &&
			hostId !== null &&
			canUpload &&
			!snap.readOnly &&
			(companionPhase === "live" || companionPhase === "connecting")
				? async (file: File): Promise<string> =>
						companionClient.uploadFile(hostId, file.name, await blobToBase64(file))
				: null,
		[companionClient, hostId, canUpload, snap.readOnly, companionPhase],
	);
	const [previewOpen, setPreviewOpen] = useState(false);
	const openPreview = useCallback(() => setPreviewOpen(true), []);
	const canGithub = companionClient !== null && hostId !== null && companion?.snap.canGithub === true;
	const [githubOpen, setGithubOpen] = useState(false);
	const openGithub = useCallback(() => setGithubOpen(true), []);
	// Running commands needs a session this device may control and that is not confined to file tools.
	const runSandboxed = companion?.snap.hosts.some(host => host.instanceId === hostId && host.sandboxed) ?? false;
	const canRun =
		companionClient !== null && hostId !== null && companion?.snap.canRun === true && !snap.readOnly && !runSandboxed;
	const [runOpen, setRunOpen] = useState(false);
	const openRun = useCallback(() => setRunOpen(true), []);
	const sendRunOutput = useCallback((prompt: string) => {
		setRunOpen(false);
		composerRef.current?.insert(prompt);
	}, []);
	const composerRef = useRef<ComposerHandle>(null);
	const editPrompt = useEditPrompt(client, snap, composerRef);
	const sendToAgent = useCallback((prompt: string) => {
		setGithubOpen(false);
		composerRef.current?.insert(prompt);
	}, []);
	const cwd = snap.state?.cwd ?? snap.header?.cwd ?? null;

	// Task-card agent chips drill into the same drawer the rail uses.
	const agentIds = useMemo(() => new Set(snap.agents.map(a => a.id)), [snap.agents]);
	const hasAgent = useCallback((id: string) => agentIds.has(id), [agentIds]);
	const openAgent = useCallback(
		(id: string) => {
			if (agentIds.has(id)) setSelectedId(id);
		},
		[agentIds],
	);
	const toolHost = useMemo<ToolRenderHost>(
		() => ({
			hasAgent,
			openAgent,
			openFile: hostId !== null ? path => openFile(path) : undefined,
			// Tool cards name paths as the agent wrote them: relative ones are relative to the session's folder.
			showInCodemap: canCodemap
				? path =>
						setCodemap({
							file: path.startsWith("/") || cwd === null ? path : `${cwd}/${path.replace(/^\.\//, "")}`,
						})
				: undefined,
		}),
		[hasAgent, openAgent, hostId, canCodemap, cwd, openFile],
	);

	// Auto-open the rail the first time a subagent appears, only where it docks
	// beside the transcript. On narrow screens it would cover the conversation;
	// the header badge announces subagents there instead.
	useEffect(() => {
		if (subCount > 0 && !autoOpenedRef.current) {
			autoOpenedRef.current = true;
			if (matchMedia(WIDE_QUERY).matches) setRailOpen(true);
		}
	}, [subCount]);

	// The live name first: the header carries the session file's title as of joining, so a rename would not show.
	const title = snap.state?.sessionName ?? snap.header?.title ?? "session";
	useEffect(() => {
		document.title = `${title} · omp collab`;
	}, [title]);

	// Remember every room that welcomed us, so a later launch can offer it again.
	const roomId = useMemo(() => roomIdOf(link), [link]);
	const live = snap.phase === "live";
	// An answer picked in the inbox goes to the ask it was meant for, once this session is live.
	const uiRequest = snap.uiRequest;
	useEffect(() => {
		if (!live || roomId === null || uiRequest === null) return;
		const answer = claimPendingAnswer(roomId, uiRequest);
		if (answer !== null) client.sendUiResponse(uiRequest.reqId, answer);
	}, [client, live, roomId, uiRequest]);
	// A draft for this room (the Fix-it flow) lands in the composer on screen; nothing is sent.
	useEffect(() => {
		if (roomId === null) return;
		return subscribeDraft(roomId, text => {
			const composer = composerRef.current;
			composer?.insert(text);
			return composer !== null;
		});
	}, [roomId]);
	// The computer's process for this room. Matched by session id once welcomed; until
	// then (and after the host switched sessions) the one it was opened from or last seen as.
	const storedInstance = rooms.find(room => room.roomId === roomId)?.instanceId;
	const instanceId = hostId ?? openedInstance ?? storedInstance ?? null;
	useEffect(() => {
		if (live && roomId !== null)
			onRemember({ roomId, link, title, cwd, readOnly: snap.readOnly, instanceId: instanceId ?? undefined });
	}, [live, roomId, link, title, cwd, snap.readOnly, instanceId, onRemember]);

	// A room the host replaced reopens through the paired computer; "ended" and
	// forgetting the room wait until the computer has answered.
	const followRoom = useCallback(
		(next: string): void => {
			if (roomId !== null && instanceId !== null) onRoomReplaced(roomId, next, instanceId);
		},
		[roomId, instanceId, onRoomReplaced],
	);
	const recovery = useHostRecovery(companion, instanceId, snap.phase, roomId, followRoom);
	const ended = snap.phase === "ended" && recovery === "absent";

	// The relay no longer knows this room: the host closed it.
	const gone = ended && snap.endedReason === "no such room";
	useEffect(() => {
		if (gone && roomId !== null) onRoomGone(roomId);
	}, [gone, roomId, onRoomGone]);

	const drawerAgent = selectedId != null ? snap.agents.find(a => a.id === selectedId) : undefined;
	const toggleRail = useCallback(() => setRailOpen(open => !open), []);
	const closeDrawer = useCallback(() => setSelectedId(null), []);

	const [chat, setChat] = useState(initialChat);
	const changeChat = useCallback((next: boolean): void => {
		writeJson(CHAT_KEY, next);
		setChat(next);
	}, []);

	// Keep the latest turns (per device and session); *Show all* reveals the rest until the session changes.
	const [trim, setTrim] = useState(() => ({
		sessionId,
		keep: sessionId === null ? null : loadTrim(sessionId),
		revealed: false,
	}));
	if (trim.sessionId !== sessionId) {
		setTrim({ sessionId, keep: sessionId === null ? null : loadTrim(sessionId), revealed: false });
	}
	const changeKeepTurns = useCallback(
		(keep: number | null): void => {
			if (sessionId === null) return;
			saveTrim(sessionId, keep);
			setTrim({ sessionId, keep, revealed: false });
		},
		[sessionId],
	);
	const showAllTurns = useCallback(() => setTrim(prev => ({ ...prev, revealed: true })), []);
	const trimmed = useMemo(() => {
		if (trim.keep === null || trim.revealed) return undefined;
		const cut = trimEntries(snap.entries, trim.keep);
		return cut.hiddenTurns === 0 ? undefined : { ...cut, onShowAll: showAllTurns };
	}, [trim, snap.entries, showAllTurns]);
	const shownEntries = useMemo(
		() => (trimmed === undefined ? snap.entries : snap.entries.slice(trimmed.from)),
		[snap.entries, trimmed],
	);

	const [search, setSearch] = useState<SearchState | null>(null);
	const toggleSearch = useCallback(() => setSearch(open => (open ? null : { query: "", target: null })), []);
	const closeSearch = useCallback(() => setSearch(null), []);
	const onSearch = useCallback((query: string, target: string | null) => setSearch({ query, target }), []);

	// Jumping from the screens gallery: the transcript scrolls to this entry. A search takes over once open.
	const [jumpTarget, setJumpTarget] = useState<string | null>(null);
	const jumpSearch = useMemo(
		() => (jumpTarget === null ? undefined : { query: "", target: jumpTarget }),
		[jumpTarget],
	);
	// A message found in the all-sessions search: scroll to it once this session is on screen (the search
	// drops its own state, as it would hide the jump).
	useEffect(() => {
		if (sessionId === null) return;
		const apply = (): void => {
			const entryId = takeJumpIntent(sessionId);
			if (entryId === null) return;
			setSearch(null);
			setJumpTarget(entryId);
		};
		apply();
		return onJumpIntent(apply);
	}, [sessionId]);

	const changes = useMemo(() => collectChanges(snap.entries), [snap.entries]);
	// Every completed edit or write adds a call: the preview re-captures when this grows.
	const editCount = useMemo(() => changes.reduce((n, file) => n + file.calls.length, 0), [changes]);
	const screens = useMemo(() => collectScreens(snap.entries), [snap.entries]);
	// From the full entry list: the per-device trim must not hide the agent's task list.
	const todos = useMemo(() => currentTodos(snap.entries, snap.activeTools), [snap.entries, snap.activeTools]);
	const subagents = useMemo(
		() => currentSubagents(snap.progress, snap.lifecycle, snap.agents),
		[snap.progress, snap.lifecycle, snap.agents],
	);
	const [screensOpen, setScreensOpen] = useState(false);
	const openScreens = useCallback(() => {
		setJumpTarget(null);
		setScreensOpen(true);
	}, []);
	const closeScreens = useCallback(() => setScreensOpen(false), []);
	const [changesOpen, setChangesOpen] = useState(false);
	const openChanges = useCallback(() => setChangesOpen(true), []);
	const sendReviewToAgent = useCallback((prompt: string) => {
		setChangesOpen(false);
		composerRef.current?.insert(prompt);
	}, []);

	const [sidebarOpen, setSidebarOpen] = useState(initialSidebar);
	const otherHosts = companion?.snap.hosts.filter(host => host.sessionId !== sessionId) ?? [];
	const canSwitch = otherHosts.length > 0 || rooms.some(room => room.roomId !== roomId);
	// Only the docked sidebar's state is remembered: a drawer reopening on the next
	// launch would cover the transcript.
	const changeSidebar = useCallback((next: boolean): void => {
		if (matchMedia(SIDEBAR_DOCK_QUERY).matches) writeJson(SIDEBAR_KEY, next);
		setSidebarOpen(next);
	}, []);
	const toggleSidebar = useCallback(() => changeSidebar(!sidebarOpen), [changeSidebar, sidebarOpen]);
	const closeSidebar = useCallback(() => changeSidebar(false), [changeSidebar]);
	const [statsSheet, setStatsSheet] = useState<"usage" | "sessions" | null>(null);
	const openUsage = useCallback(() => setStatsSheet("usage"), []);
	const openSessions = useCallback(() => setStatsSheet("sessions"), []);

	const { newSince, seen: newSeen, markSeen, markTail } = useNewSince(client, roomId, snap.entries, live);
	const sessionUsage = useMemo(() => sumUsage(snap.entries), [snap.entries]);
	const sendSessionCommand = useCallback(
		(cmd: SessionCommand, arg?: string) => client.sendSessionCommand(cmd, arg),
		[client],
	);
	const cancelQueued = useCallback((id: string) => client.cancelQueued(id), [client]);
	// Built on click from every entry, not the trimmed view; the ref keeps the callback stable for the memoized header.
	const entriesRef = useRef(snap.entries);
	entriesRef.current = snap.entries;
	const exportMarkdown = useCallback((title: string) => sessionMarkdown(entriesRef.current, { title }), []);

	// Desktop shortcuts. Typing in a field suppresses everything but Esc; an open sheet or
	// drawer owns Esc itself, and the composer aborts a running turn on its own Esc.
	const canShowSidebar = canSwitch || companion !== null;
	const showSidebar = sidebarOpen && canShowSidebar;
	const readOnly = snap.readOnly;
	const working = snap.working;
	const searchOpen = search !== null;
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.isComposing || e.defaultPrevented) return;
			const target = e.target;
			const typing =
				target instanceof HTMLElement &&
				(target.isContentEditable ||
					target.tagName === "INPUT" ||
					target.tagName === "TEXTAREA" ||
					target.tagName === "SELECT");
			const dialogOpen = document.querySelector('[role="dialog"]') !== null;
			if (e.key === "Escape") {
				// A sheet owns Esc, and so does the pane the user last touched when it is not this one.
				if (dialogOpen || focusedPane() !== "main") return;
				if (searchOpen) closeSearch();
				else if (showSidebar && !matchMedia(SIDEBAR_DOCK_QUERY).matches) setSidebarOpen(false);
				else if (live && !readOnly && working) client.sendAbort();
				return;
			}
			if (typing || dialogOpen || e.altKey) return;
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !e.shiftKey) {
				if (!canShowSidebar) return;
				e.preventDefault();
				toggleSidebar();
			} else if (e.key === "/" && !e.metaKey && !e.ctrlKey && !searchOpen && focusedPane() === "main") {
				e.preventDefault();
				setSearch({ query: "", target: null });
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [canShowSidebar, client, closeSearch, live, readOnly, searchOpen, showSidebar, toggleSidebar, working]);

	// Split view: the editor docks beside the transcript where there is room, unless a second
	// session is open and the screen is too narrow for both (the session keeps the room, the editor is a sheet).
	const twoPanes = useMedia(TWO_PANES_QUERY);
	const [ideDockPref, setIdeDockPref] = useState(loadIdeDock);
	const dockOffered = beside.available && (beside.pane === null || twoPanes);
	const ideDock = useMemo(
		() =>
			dockOffered
				? {
						docked: ideDockPref,
						onDockedChange: (next: boolean): void => {
							saveIdeDock(next);
							setIdeDockPref(next);
						},
					}
				: null,
		[dockOffered, ideDockPref],
	);
	const ideSheet =
		editor !== null && canEdit ? (
			<LazyIdeSheet
				client={companionClient}
				instanceId={hostId}
				target={editor.target}
				readOnly={snap.readOnly}
				canDefinition={canCodemap}
				edits={editCount}
				onSendToAgent={snap.readOnly ? null : sendToAgent}
				dock={ideDock}
				onClose={() => setEditor(null)}
			/>
		) : null;
	const ideDocked = ideSheet !== null && ideDock?.docked === true;
	const besideOpen = beside.available && beside.pane !== null;

	return (
		<div className="sh-app">
			<div className="sh-ambient" />
			<HeaderBar
				header={snap.header}
				state={snap.state}
				phase={snap.phase}
				readOnly={snap.readOnly}
				sandboxed={companion?.snap.hosts.some(host => host.sessionId === sessionId && host.sandboxed) ?? false}
				subCount={subCount}
				railOpen={railOpen}
				onToggleRail={toggleRail}
				onLeave={onLeave}
				searchOpen={search !== null}
				onToggleSearch={toggleSearch}
				onToggleSidebar={canShowSidebar ? toggleSidebar : null}
				sidebarOpen={showSidebar}
				sidebarAlert={otherHosts.some(host => host.inputRequired)}
				chat={chat}
				onChatChange={changeChat}
				keepTurns={sessionId === null ? undefined : trim.keep}
				onKeepTurnsChange={changeKeepTurns}
				changeCount={changes.length}
				workingTree={hostId !== null}
				sessionUsage={sessionUsage}
				models={snap.models}
				onSessionCommand={sendSessionCommand}
				exportMarkdown={exportMarkdown}
				onOpenChanges={openChanges}
				onOpenUsage={companion ? openUsage : null}
				onOpenSessions={companion ? openSessions : null}
				onOpenCodemap={canCodemap ? openCodemap : null}
				onOpenPane={companionClient !== null && hostId !== null ? openPane : null}
				onOpenPreview={canPreview ? openPreview : null}
				onOpenGithub={canGithub ? openGithub : null}
				onOpenRun={canRun ? openRun : null}
				onOpenEditor={canEdit ? openEditor : null}
				screenCount={screens.length}
				onOpenScreens={openScreens}
				push={push}
			/>
			<main className="sh-main" data-split={(besideOpen ? 1 : 0) + (ideDocked ? 1 : 0) || undefined}>
				{showSidebar && (
					<>
						<div className="sh-sidebar-backdrop" onClick={() => setSidebarOpen(false)} />
						<aside className="sh-sidebar-dock">
							<SessionsSidebar
								companion={companion}
								rooms={rooms}
								currentSessionId={sessionId}
								currentRoomId={roomId}
								onOpenHost={onOpenHost}
								onOpenLink={onOpenLink}
								onOpenUsage={companion ? openUsage : null}
								onOpenSessions={companion ? openSessions : null}
								onClose={closeSidebar}
								beside={beside.available ? beside : null}
							/>
						</aside>
					</>
				)}
				<section className="sh-panel" data-rail={railOpen ? "true" : "false"}>
					{search && <SearchBar entries={shownEntries} onSearch={onSearch} onClose={closeSearch} />}
					<div className="sh-transcript">
						<Transcript
							entries={snap.entries}
							stream={snap.stream}
							streamDone={snap.streamDone}
							activeTools={snap.activeTools}
							working={snap.working}
							host={toolHost}
							phase={snap.phase}
							chat={chat}
							search={search ?? jumpSearch}
							newSince={newSince ?? undefined}
							newSeen={newSeen}
							onNewSeen={markSeen}
							onTail={markTail}
							queued={snap.queued}
							onCancelQueued={cancelQueued}
							trimmed={trimmed}
							onEditPrompt={editPrompt.onEditPrompt}
						/>
					</div>
					{editPrompt.sheet}
					<TaskProgress todos={todos} subagents={subagents} hasAgent={hasAgent} onOpenAgent={openAgent} />
					<Composer
						ref={composerRef}
						key={roomId}
						client={client}
						phase={snap.phase}
						readOnly={snap.readOnly}
						uiRequest={snap.uiRequest}
						working={snap.working}
						queuedMessageCount={snap.state?.queuedMessageCount ?? 0}
						followUp={Object.hasOwn(snap.features, "follow-up") && !snap.readOnly}
						followUps={snap.followUps}
						upload={upload}
						voice={voice}
						draftKey={roomId}
						models={snap.models}
						model={snap.state?.model}
						thinkingLevel={snap.state?.thinkingLevel}
						thinkingLevels={snap.state?.thinkingLevels}
						onSessionCommand={sendSessionCommand}
					/>
				</section>
				{railOpen && (
					<>
						<div className="sh-rail-backdrop" onClick={() => setRailOpen(false)} />
						<aside className="sh-rail">
							<AgentsPanel
								key={sessionId}
								sessionId={sessionId}
								agents={snap.agents}
								progress={snap.progress}
								lifecycle={snap.lifecycle}
								selectedId={selectedId}
								onSelect={setSelectedId}
							/>
						</aside>
					</>
				)}
				{beside.pane !== null && besideOpen && (
					<SplitPane
						key={beside.pane.link}
						client={beside.pane.client}
						link={beside.pane.link}
						companion={companion}
						chat={chat}
						rooms={rooms}
						onClose={beside.close}
						onRejoin={beside.rejoin}
						onMakeMain={onOpenLink}
						onRemember={onRemember}
						onReplaced={beside.replace}
						onRoomGone={beside.gone}
					/>
				)}
				{ideDocked && ideSheet}
			</main>
			{drawerAgent && (
				<>
					<div className="ag-drawer-backdrop" onClick={closeDrawer} />
					<AgentDrawer
						agent={drawerAgent}
						progress={snap.progress.get(drawerAgent.id)}
						lifecycle={snap.lifecycle.get(drawerAgent.id)}
						client={client}
						readOnly={snap.readOnly}
						host={toolHost}
						onClose={closeDrawer}
					/>
				</>
			)}
			<Banners
				phase={snap.phase === "ended" && !ended ? "reconnecting" : snap.phase}
				endedReason={snap.endedReason}
				loading={snap.loading}
				onRejoin={onRejoin}
				onNewLink={onLeave}
			/>
			<Toasts notices={snap.notices} />
			{companion && <SessionAlert hosts={companion.snap.hosts} currentSessionId={sessionId} onOpen={onOpenHost} />}
			{statsSheet === "usage" && companionClient !== null && (
				<UsageSheet
					client={companionClient}
					canGithub={companion?.snap.canGithub === true}
					onClose={() => setStatsSheet(null)}
				/>
			)}
			{statsSheet === "sessions" && companionClient !== null && companion !== null && (
				<SessionsSheet
					client={companionClient}
					canStart={companion.snap.canStart}
					canSearch={companion.snap.canSearch}
					currentSessionId={sessionId}
					onOpenHost={onOpenHost}
					onOpenLink={onOpenLink}
					onClose={() => setStatsSheet(null)}
				/>
			)}
			{changesOpen && (
				<ChangesSheet
					changes={changes}
					host={toolHost}
					tree={
						companionClient !== null && hostId !== null
							? {
									client: companionClient,
									instanceId: hostId,
									canPr: companion?.snap.canPr ?? false,
									busy: hostRow?.busy ?? null,
									title: hostRow?.sessionName ?? null,
								}
							: null
					}
					sessionId={sessionId}
					onSendToAgent={snap.readOnly ? null : sendReviewToAgent}
					onClose={() => setChangesOpen(false)}
				/>
			)}
			{screensOpen && <ScreensSheet screens={screens} onJump={setJumpTarget} onClose={closeScreens} />}
			{codemap !== null && canCodemap && companion !== null && (
				<LazyCodemapSheet
					key={codemap.file ?? ""}
					client={companionClient}
					instanceId={hostId}
					initialFile={codemap.file}
					canStart={companion.snap.canStart}
					currentSessionId={sessionId}
					onOpenHost={onOpenHost}
					onOpenLink={onOpenLink}
					onOpenFile={openFile}
					onClose={() => setCodemap(null)}
				/>
			)}
			{paneOpen && companionClient !== null && hostId !== null && (
				<PaneSheet client={companionClient} instanceId={hostId} onClose={() => setPaneOpen(false)} />
			)}
			{previewOpen && canPreview && companionClient !== null && hostId !== null && sessionId !== null && (
				<PreviewSheet
					client={companionClient}
					instanceId={hostId}
					sessionId={sessionId}
					edits={editCount}
					onClose={() => setPreviewOpen(false)}
				/>
			)}
			{runOpen && canRun && companionClient !== null && hostId !== null && (
				<RunSheet
					client={companionClient}
					instanceId={hostId}
					machine={machine}
					onSendToAgent={sendRunOutput}
					onClose={() => setRunOpen(false)}
				/>
			)}
			{githubOpen && canGithub && companionClient !== null && hostId !== null && (
				<GithubSheet
					client={companionClient}
					instanceId={hostId}
					onSendToAgent={snap.readOnly ? null : sendToAgent}
					canReview={companion?.snap.canPrReview === true}
					sandboxed={companion?.snap.hosts.some(host => host.instanceId === hostId && host.sandboxed) ?? false}
					canFixIt={companion?.snap.canFixIt === true}
					onClose={() => setGithubOpen(false)}
				/>
			)}
			{!ideDocked && ideSheet}
			{file !== null && companionClient !== null && hostId !== null && (
				<FileSheet
					client={companionClient}
					instanceId={hostId}
					path={file.path}
					line={file.line}
					onClose={() => setFile(null)}
				/>
			)}
		</div>
	);
}
