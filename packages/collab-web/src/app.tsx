import type { SessionCommand } from "@oh-my-pi/pi-wire";
import { Activity, Archive, Eye, PenLine } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentDrawer } from "./components/agents/AgentDrawer";
import { AgentsPanel, isInactive } from "./components/agents/AgentsPanel";
import { LazyCodemapSheet } from "./components/codemap/LazyCodemapSheet";
import { DiagramHost } from "./components/diagram/DiagramHost";
import { LazyIdeSheet } from "./components/ide/LazyIdeSheet";
import { Banners } from "./components/shell/Banners";
import { ChangesSheet } from "./components/shell/ChangesSheet";
import { Composer, type ComposerHandle } from "./components/shell/Composer";
import { useComposerExtras } from "./components/shell/composer-extras";
import type { FanoutTarget } from "./components/shell/FanoutSheet";
import { ConnectScreen } from "./components/shell/ConnectScreen";
import { useEditPrompt } from "./components/shell/EditPromptSheet";
import { useTurnChanges } from "./components/shell/TurnChangesSheet";
import { FileRestoreBar } from "./components/shell/FileRestoreBar";
import { FileSheet } from "./components/shell/FileSheet";
import { FixItHost } from "./components/shell/FixItHost";
import { HeaderBar } from "./components/shell/HeaderBar";
import { useTurnUndo } from "./components/shell/TurnUndo";
import { useMedia } from "./components/codemap/shared";
import { PaneSheet } from "./components/shell/PaneSheet";
import { PaletteHost, type PaletteActions, type PaletteSessionControl } from "./components/shell/PaletteHost";
import { GithubSheet } from "./components/shell/GithubSheet";
import { PreviewSheet } from "./components/shell/PreviewSheet";
import { RunSheet } from "./components/shell/RunSheet";
import { ScreensSheet } from "./components/shell/ScreensSheet";
import { SearchBar } from "./components/shell/SearchBar";
import { SessionAlert } from "./components/shell/SessionAlert";
import { SessionsSheet } from "./components/shell/SessionsSheet";
import { SessionsSidebar } from "./components/shell/SessionsSidebar";
import { SplitPane } from "./components/shell/SplitPane";
import { LimitBar } from "./components/shell/LimitBar";
import { SpendCapBar } from "./components/shell/SpendCapBar";
import { CacheStrip } from "./components/shell/CacheStrip";
import { TaskProgress } from "./components/shell/TaskProgress";
import { Toasts } from "./components/shell/Toasts";
import { UpdateBar } from "./components/shell/UpdateBar";
import { Tooltip } from "./components/shell/Tooltip";
import { ShortcutsSheet } from "./components/shell/ShortcutsSheet";
import { UsageSheet } from "./components/shell/UsageSheet";
import { TimelineSheet } from "./components/shell/TimelineSheet";
import { Transcript } from "./components/transcript/Transcript";
import { collectChanges } from "./lib/changes";
import { GuestClient } from "./lib/client";
import { togglePalette, usePaletteEntries } from "./lib/palette";
import { extractPairing, loadPairing, type Pairing, savePairing } from "./lib/companion";
import { subscribeDraft } from "./lib/draft-bus";
import { openDiagramFile, openSketch } from "./lib/diagram-store";
import { diagramFileKind } from "./lib/diagrams";
import { adjacentRoom, IS_MAC, type ShortcutId, shortcutFires } from "./lib/shortcuts";
import { useEdgeGestures } from "./lib/use-edge-gestures";
import { sessionMarkdown } from "./lib/export";
import { blobToBase64 } from "./lib/images";
import { useAppBadge } from "./lib/badge";
import { applyOpenIntent, claimPendingAnswer, setOpenIntent } from "./lib/inbox";
import { takePendingReview } from "./lib/fanout";
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
import { limitedUntil } from "./lib/usage-limits";
import { type CompanionHandle, useCompanion } from "./lib/use-companion";
import { useHostRecovery } from "./lib/use-host-recovery";
import { useGuestSnapshot } from "./lib/use-guest";
import { useSessionOrg } from "./lib/use-session-org";
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
			<Tooltip />
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
	const org = useSessionOrg(
		{
			client: companionClient,
			live: companion?.snap.phase === "live",
			orgRev: companion?.snap.sessionOrgRev ?? null,
			orderSessions: companion?.snap.canOrderSessions === true,
		},
		rooms,
	);
	const [file, setFile] = useState<{ path: string; line?: number } | null>(null);
	const [codemap, setCodemap] = useState<{ file?: string } | null>(null);
	const canCodemap = companionClient !== null && hostId !== null && companion?.snap.canCodemap === true;
	const openCodemap = useCallback(() => setCodemap({}), []);
	// The editor replaces the read-only file viewer once the paired computer can save files.
	const canEdit = companionClient !== null && hostId !== null && companion?.snap.canEdit === true;
	const [editor, setEditor] = useState<{ target: { path: string; line?: number } | null } | null>(null);
	const openEditor = useCallback(() => setEditor(open => open ?? { target: null }), []);
	const openFile = useCallback(
		(path: string, line?: number) => {
			// Diagram files (.excalidraw, .mmd) open in the canvas, wherever a file path is shown.
			if (diagramFileKind(path) !== null && companionClient !== null && hostId !== null) openDiagramFile(path);
			else if (canEdit) setEditor({ target: { path, line } });
			else setFile({ path, line });
		},
		[canEdit, companionClient, hostId],
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
	const composerExtras = useComposerExtras(snap, companionClient, hostId, canGithub);
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
	const turnChanges = useTurnChanges(client, snap, sessionId, composerRef, true);
	const turnUndo = useTurnUndo(client, snap, composerRef);
	const canStashDraft = !snap.readOnly && snap.phase !== "ended";
	usePaletteEntries(
		useMemo(
			() =>
				canStashDraft
					? [
							{
								id: "composer:stash",
								title: "Stash the draft",
								section: "Session",
								keywords: ["draft", "save", "set aside", "message box"],
								icon: Archive,
								shortcut: "stashDraft" as const,
								run: () => composerRef.current?.stash(),
							},
						]
					: [],
			[canStashDraft],
		),
	);
	const sendToAgent = useCallback((prompt: string) => {
		setGithubOpen(false);
		composerRef.current?.insert(prompt);
	}, []);
	// Diagrams: a drawing from the canvas lands in the message box as attachments; repository diagram files go through the paired computer.
	const attachDrawing = useCallback((attached: File[], note: string) => {
		void composerRef.current?.attach(attached, note);
	}, []);
	const diagramFiles = useMemo(
		() =>
			companionClient !== null && hostId !== null
				? { client: companionClient, instanceId: hostId, canWrite: canEdit && !snap.readOnly }
				: null,
		[companionClient, hostId, canEdit, snap.readOnly],
	);
	usePaletteEntries(
		useMemo(
			() =>
				snap.readOnly
					? []
					: [
							{
								id: "diagram:sketch",
								title: "Sketch a drawing",
								section: "Actions",
								keywords: ["draw", "canvas", "excalidraw", "whiteboard", "diagram", "attach"],
								icon: PenLine,
								run: openSketch,
							},
						],
			[snap.readOnly],
		),
	);
	const cwd = snap.state?.cwd ?? snap.header?.cwd ?? null;
	// "Try on several models": the composer's draft starts in worktrees of this session's repository on the paired computer.
	const fanoutTarget = useMemo<FanoutTarget | null>(
		() =>
			companionClient !== null &&
			hostId !== null &&
			cwd !== null &&
			companion?.snap.canFanout === true &&
			!snap.readOnly &&
			!runSandboxed
				? { client: companionClient, cwd, canSandbox: companion.snap.canSandbox, onOpen: onOpenHost }
				: null,
		[
			companionClient,
			hostId,
			cwd,
			companion?.snap.canFanout,
			companion?.snap.canSandbox,
			snap.readOnly,
			runSandboxed,
			onOpenHost,
		],
	);

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
	// A kept model-comparison winner opens on its branch review, where the pull request is made.
	const [changesTab, setChangesTab] = useState<"branch" | undefined>(undefined);
	const openChanges = useCallback(() => {
		setChangesTab(undefined);
		setChangesOpen(true);
	}, []);
	useEffect(() => {
		if (hostId === null || !takePendingReview(hostId)) return;
		setChangesTab("branch");
		setChangesOpen(true);
	}, [hostId]);
	// The per-request timeline asks the host to read its session, so it is for writers on a live host that advertises it.
	const canTimeline = Object.hasOwn(snap.features, "inspect") && !snap.readOnly && live;
	const [timelineOpen, setTimelineOpen] = useState(false);
	const openTimeline = useCallback(() => setTimelineOpen(true), []);
	const closeTimeline = useCallback(() => setTimelineOpen(false), []);
	usePaletteEntries(
		useMemo(
			() =>
				canTimeline
					? [
							{
								id: "inspect:timeline",
								title: "Open the request timeline",
								section: "View",
								keywords: ["inspect", "requests", "latency", "ttft", "cache", "cost", "trajectory"],
								icon: Activity,
								run: openTimeline,
							},
						]
					: [],
			[canTimeline, openTimeline],
		),
	);
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
	// The palette hands a search to the all-sessions sheet when a result needs a choice (resume, share) before it opens.
	const [sessionsSearch, setSessionsSearch] = useState<{ mode: "sessions" | "messages"; query: string } | null>(null);
	const openSessions = useCallback(() => {
		setSessionsSearch(null);
		setStatsSheet("sessions");
	}, []);
	const openSessionsSearch = useCallback((initial: { mode: "sessions" | "messages"; query: string }) => {
		setSessionsSearch(initial);
		setStatsSheet("sessions");
	}, []);

	const { newSince, seen: newSeen, markSeen, markTail } = useNewSince(client, roomId, snap.entries, live);
	const sessionUsage = useMemo(() => sumUsage(snap.entries), [snap.entries]);
	const sendSessionCommand = useCallback(
		(cmd: SessionCommand, arg?: string) => client.sendSessionCommand(cmd, arg),
		[client],
	);
	const canWatchPr = Object.hasOwn(snap.features, "pr-watch") && !snap.readOnly && live;
	usePaletteEntries(
		useMemo(
			() =>
				canWatchPr
					? [
							{
								id: "pr-watch:watch",
								title: "Watch this branch's pull request",
								section: "Git",
								keywords: ["pr", "pull request", "ci", "checks", "review", "wake"],
								icon: Eye,
								run: () => sendSessionCommand("pr-watch", ""),
							},
						]
					: [],
			[canWatchPr, sendSessionCommand],
		),
	);
	const limitsOn = Object.hasOwn(snap.features, "usage-limits");
	const cancelQueued = useCallback((id: string) => client.cancelQueued(id), [client]);
	// Built on click from every entry, not the trimmed view; the ref keeps the callback stable for the memoized header.
	const entriesRef = useRef(snap.entries);
	entriesRef.current = snap.entries;
	const exportMarkdown = useCallback((title: string) => sessionMarkdown(entriesRef.current, { title }), []);

	// Desktop shortcuts (the keymap lives in lib/shortcuts.ts, which the help sheet lists too). Typing in a
	// field suppresses everything but Esc; an open sheet or drawer owns Esc itself, and the composer aborts a
	// running turn on its own Esc. The transcript handles its own keys (blocks, jump, copy, edit).
	const canShowSidebar = canSwitch || companion !== null;
	const showSidebar = sidebarOpen && canShowSidebar;
	const readOnly = snap.readOnly;
	const working = snap.working;
	const searchOpen = search !== null;
	const [sessionSheetOpen, setSessionSheetOpen] = useState(false);
	const [helpOpen, setHelpOpen] = useState(false);
	const closeHelp = useCallback(() => setHelpOpen(false), []);
	const openHelp = useCallback(() => setHelpOpen(true), []);
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.isComposing || e.defaultPrevented) return;
			const target = e.target instanceof HTMLElement ? e.target : null;
			const fires = (id: ShortcutId): boolean => shortcutFires(id, e, target, IS_MAC);
			const dialogOpen = document.querySelector('[role="dialog"]') !== null;
			if (fires("escape")) {
				// A sheet owns Esc, and so does the pane the user last touched when it is not this one.
				if (dialogOpen || focusedPane() !== "main") return;
				if (searchOpen) closeSearch();
				else if (showSidebar && !matchMedia(SIDEBAR_DOCK_QUERY).matches) setSidebarOpen(false);
				else if (live && !readOnly && working) client.sendAbort();
				return;
			}
			if (dialogOpen) return;
			if (fires("palette")) {
				e.preventDefault();
				togglePalette();
			} else if (fires("sidebar")) {
				if (!canShowSidebar) return;
				e.preventDefault();
				toggleSidebar();
			} else if (fires("help")) {
				e.preventDefault();
				setHelpOpen(true);
			} else if (focusedPane() !== "main") {
				return;
			} else if (fires("stashDraft")) {
				// Outside the message box the browser would save the page.
				e.preventDefault();
				if (canStashDraft) composerRef.current?.stash();
			} else if (fires("find")) {
				if (searchOpen) return;
				e.preventDefault();
				setSearch({ query: "", target: null });
			} else if (fires("focusComposer")) {
				e.preventDefault();
				composerRef.current?.focus();
			} else if (fires("toggleChat")) {
				e.preventDefault();
				changeChat(!chat);
			} else if (fires("sessionSheet")) {
				e.preventDefault();
				setSessionSheetOpen(true);
			} else if (fires("prevSession") || fires("nextSession")) {
				const room = adjacentRoom(rooms, roomId, fires("nextSession") ? 1 : -1);
				if (room === null) return;
				e.preventDefault();
				onOpenLink(room.link);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [
		canShowSidebar,
		canStashDraft,
		chat,
		changeChat,
		client,
		closeSearch,
		live,
		onOpenLink,
		readOnly,
		roomId,
		rooms,
		searchOpen,
		showSidebar,
		toggleSidebar,
		working,
	]);

	// Touch: edge swipes open and close the sessions sidebar and the agents rail; a swipe down on the composer hides the keyboard.
	useEdgeGestures({
		canOpenSidebar: canShowSidebar,
		sidebarDrawerOpen: showSidebar && !matchMedia(SIDEBAR_DOCK_QUERY).matches,
		railOpen,
		setSidebar: changeSidebar,
		setRail: setRailOpen,
	});

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

	// ⌘K: the app's own actions for the palette (others register theirs where they are available), its model and
	// thinking switches, and the draft hook slash commands use.
	const hasChanges = changes.length > 0 || hostId !== null;
	const paletteActions = useMemo<PaletteActions>(
		() => ({
			openSessionSheet: () => setSessionSheetOpen(true),
			openFind: () => setSearch(open => open ?? { query: "", target: null }),
			chat,
			onChatChange: changeChat,
			toggleSidebar: canShowSidebar ? toggleSidebar : null,
			sidebarOpen: showSidebar,
			toggleRail,
			railOpen,
			focusComposer: () => composerRef.current?.focus(),
			adjacentSession:
				adjacentRoom(rooms, roomId, 1) === null
					? null
					: delta => {
							const room = adjacentRoom(rooms, roomId, delta);
							if (room !== null) onOpenLink(room.link);
						},
			openChanges: hasChanges ? openChanges : null,
			openScreens,
			openShortcuts: openHelp,
			openUsage: companion ? openUsage : null,
			openSessions: companion ? openSessions : null,
			openCodemap: canCodemap ? openCodemap : null,
			openPane: companionClient !== null && hostId !== null ? openPane : null,
			openPreview: canPreview ? openPreview : null,
			openGithub: canGithub ? openGithub : null,
			openRun: canRun ? openRun : null,
			openEditor: canEdit ? openEditor : null,
			turnUndo: turnUndo.control,
			onLeave,
		}),
		[
			canCodemap,
			canEdit,
			canGithub,
			canPreview,
			canRun,
			canShowSidebar,
			changeChat,
			chat,
			companion,
			companionClient,
			hasChanges,
			hostId,
			onLeave,
			onOpenLink,
			openChanges,
			openCodemap,
			openEditor,
			openGithub,
			openHelp,
			openPane,
			openPreview,
			openRun,
			openScreens,
			openSessions,
			openUsage,
			railOpen,
			roomId,
			rooms,
			showSidebar,
			toggleRail,
			toggleSidebar,
			turnUndo.control,
		],
	);
	const models = snap.models;
	const modelId = snap.state?.model?.id;
	const thinkingLevels = snap.state?.thinkingLevels;
	const thinkingLevel = snap.state?.thinkingLevel;
	const paletteControl = useMemo<PaletteSessionControl | null>(
		() =>
			models !== null && !snap.readOnly && live
				? { models, modelId, thinkingLevels: thinkingLevels ?? [], thinkingLevel, send: sendSessionCommand }
				: null,
		[models, modelId, thinkingLevels, thinkingLevel, snap.readOnly, live, sendSessionCommand],
	);
	const insertDraft = useCallback((text: string) => composerRef.current?.insert(text), []);

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
				sheetOpen={sessionSheetOpen}
				setSheetOpen={setSessionSheetOpen}
				keepTurns={sessionId === null ? undefined : trim.keep}
				onKeepTurnsChange={changeKeepTurns}
				changeCount={changes.length}
				workingTree={hostId !== null}
				sessionUsage={sessionUsage}
				models={snap.models}
				onSessionCommand={sendSessionCommand}
				turnUndo={turnUndo.control}
				contextItems={Object.hasOwn(snap.features, "context-items") ? snap.contextItems : undefined}
				canWatchPr={Object.hasOwn(snap.features, "pr-watch")}
				exportMarkdown={exportMarkdown}
				onOpenChanges={openChanges}
				onOpenShortcuts={openHelp}
				onOpenUsage={companion ? openUsage : null}
				onOpenSessions={companion ? openSessions : null}
				onOpenCodemap={canCodemap ? openCodemap : null}
				onOpenPane={companionClient !== null && hostId !== null ? openPane : null}
				onOpenPreview={canPreview ? openPreview : null}
				onOpenGithub={canGithub ? openGithub : null}
				onOpenRun={canRun ? openRun : null}
				onOpenEditor={canEdit ? openEditor : null}
				onOpenTimeline={canTimeline ? openTimeline : null}
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
								org={org}
								limitResetAt={limitedUntil(snap.state ?? undefined, Date.now())}
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
							onTurnChanges={turnChanges.onTurnChanges}
							onSendToAgent={snap.readOnly ? undefined : sendToAgent}
							sessionModel={snap.state?.model?.id}
						/>
					</div>
					{editPrompt.sheet}
					{turnChanges.sheet}
					{limitsOn && (
						<LimitBar
							limited={snap.state?.limited}
							info={snap.usageLimits}
							models={snap.models}
							model={snap.state?.model}
							readOnly={snap.readOnly}
							onSessionCommand={sendSessionCommand}
							onSnooze={sessionId === null ? undefined : until => org.act(sessionId, { type: "snooze", until })}
						/>
					)}
					<TaskProgress todos={todos} subagents={subagents} hasAgent={hasAgent} onOpenAgent={openAgent} />
					<CacheStrip cache={Object.hasOwn(snap.features, "cache-stats") ? snap.state?.cache : undefined} />
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
						approvalGrants={Object.hasOwn(snap.features, "approval-grants")}
						followUps={snap.followUps}
						followUpIds={composerExtras.followUpIds}
						queueEdit={composerExtras.queueEdit}
						mentions={composerExtras.mentions}
						upload={upload}
						voice={voice}
						draftKey={roomId}
						models={snap.models}
						model={snap.state?.model}
						thinkingLevel={snap.state?.thinkingLevel}
						thinkingLevels={snap.state?.thinkingLevels}
						profiles={Object.hasOwn(snap.features, "profiles") ? snap.profiles : null}
						profile={snap.state?.profile}
						followsRoom={companionClient !== null && instanceId !== null}
						promptModel={Object.hasOwn(snap.features, "prompt-model") && !snap.readOnly && snap.models !== null}
						fanout={fanoutTarget}
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
			<FileRestoreBar
				restore={snap.fileRestore}
				working={snap.working}
				readOnly={snap.readOnly}
				onUndo={() => client.sendSessionCommand("redo-files")}
			/>
			{turnUndo.bar}
			<SpendCapBar spend={Object.hasOwn(snap.features, "spend-cap") ? snap.state?.spend : undefined} />
			<Toasts notices={snap.notices} />
			{companion && <SessionAlert hosts={companion.snap.hosts} currentSessionId={sessionId} onOpen={onOpenHost} />}
			{statsSheet === "usage" && companionClient !== null && (
				<UsageSheet
					client={companionClient}
					canGithub={companion?.snap.canGithub === true}
					limits={
						limitsOn
							? {
									info: snap.usageLimits,
									activeProvider: snap.state?.model?.provider,
									onRefresh: () => sendSessionCommand("usage-limits", "refresh"),
								}
							: undefined
					}
					onClose={() => setStatsSheet(null)}
				/>
			)}
			{statsSheet === "sessions" && companionClient !== null && companion !== null && (
				<SessionsSheet
					client={companionClient}
					canStart={companion.snap.canStart}
					canSearch={companion.snap.canSearch}
					initial={sessionsSearch ?? undefined}
					canGitFlow={companion.snap.canGitFlow}
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
									canGitFlow: companion?.snap.canGitFlow ?? false,
									busy: hostRow?.busy ?? null,
									title: hostRow?.sessionName ?? null,
								}
							: null
					}
					sessionId={sessionId}
					onSendToAgent={snap.readOnly ? null : sendReviewToAgent}
					onClose={() => setChangesOpen(false)}
					initialTab={changesTab}
				/>
			)}
			{screensOpen && <ScreensSheet screens={screens} onJump={setJumpTarget} onClose={closeScreens} />}
			{timelineOpen && canTimeline && (
				<TimelineSheet
					info={snap.inspect}
					preview={snap.requestPreview}
					noticeId={snap.notices.at(-1)?.id ?? 0}
					onSessionCommand={sendSessionCommand}
					onClose={closeTimeline}
				/>
			)}
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
			{helpOpen && <ShortcutsSheet onClose={closeHelp} />}
			<PaletteHost
				actions={paletteActions}
				control={paletteControl}
				title={title}
				exportMarkdown={exportMarkdown}
				commands={snap.commands}
				followsRoom={companionClient !== null && instanceId !== null}
				entries={snap.entries}
				sessionId={sessionId}
				companion={companion}
				rooms={rooms}
				currentRoomId={roomId}
				insertDraft={insertDraft}
				onOpenHost={onOpenHost}
				onOpenLink={onOpenLink}
				onOpenAllSessions={openSessionsSearch}
			/>
			{!ideDocked && ideSheet}
			<DiagramHost onAttach={snap.readOnly ? null : attachDrawing} files={diagramFiles} />
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
