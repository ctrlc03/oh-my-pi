import type { SessionCommand } from "@oh-my-pi/pi-wire";
import type { Spar, SparRun } from "@oh-my-pi/pi-wire/spar";
import { Activity, Archive, Eye, PenLine } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentDrawer } from "./components/agents/AgentDrawer";
import { AgentsPanel, isInactive } from "./components/agents/AgentsPanel";
import { LazyArchitectureSheet } from "./components/architecture/LazyArchitectureSheet";
import type { ArchitectureStart } from "./components/architecture/ArchitectureSheet";
import { LazyQuizSheet } from "./components/quiz/LazyQuizSheet";
import type { QuizStart } from "./components/quiz/QuizSheet";
import { LazyBakeoffSheet } from "./components/bakeoff/LazyBakeoffSheet";
import type { BakeoffJoins, BakeoffStart } from "./components/bakeoff/bakeoff-types";
import { LazyCodemapSheet } from "./components/codemap/LazyCodemapSheet";
import { DiagramHost } from "./components/diagram/DiagramHost";
import { LazyIdeSheet } from "./components/ide/LazyIdeSheet";
import { PetHost } from "./components/pet/PetHost";
import { SettingsHost } from "./components/settings/SettingsHost";
import type { SettingsEnv } from "./components/settings/env";
import { defaultChat } from "./lib/chat-view";
import { displayName } from "./lib/display-name";
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
import { useHiddenMessages } from "./components/shell/HiddenMessages";
import type { StakesControl } from "./components/shell/StakesControl";
import { useTurnUndo } from "./components/shell/TurnUndo";
import { useMedia } from "./components/codemap/shared";
import { PaneSheet } from "./components/shell/PaneSheet";
import { PaletteHost, type PaletteActions, type PaletteSessionControl } from "./components/shell/PaletteHost";
import { ZoomHost } from "./components/shell/ZoomHost";
import { GithubSheet } from "./components/shell/GithubSheet";
import { PreviewSheet } from "./components/shell/PreviewSheet";
import { RunSheet } from "./components/shell/RunSheet";
import { ScreensSheet } from "./components/shell/ScreensSheet";
import { SearchBar } from "./components/shell/SearchBar";
import { DesktopBridge } from "./components/shell/DesktopBridge";
import { type DeletedSessions, DeleteHost, useDeleteSessions } from "./components/shell/DeleteSessions";
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
import { UsageSheet } from "./components/shell/UsageSheet";
import { TimelineSheet } from "./components/shell/TimelineSheet";
import { Transcript } from "./components/transcript/Transcript";
import { collectChanges } from "./lib/changes";
import { GuestClient } from "./lib/client";
import { togglePalette, usePaletteEntries } from "./lib/palette";
import { type CompanionHost, extractPairing, type PairingLink } from "./lib/companion";
import { stakesOn, stakesToggleShown } from "./lib/stakes";
import { type ComputerHandle, computerById, planOpen, resolveSessionHome, topicQuizOffered } from "./lib/computers";
import { latestClear } from "./lib/context-clear";
import { subscribeDraft } from "./lib/draft-bus";
import { openDiagramFile, openSketch } from "./lib/diagram-store";
import { diagramFileKind } from "./lib/diagrams";
import { adjacentRoom, IS_MAC, type ShortcutId, shortcutFires } from "./lib/shortcuts";
import { matchesMedia, useUiZoom } from "./lib/zoom";
import { useEdgeGestures } from "./lib/use-edge-gestures";
import { sessionMarkdown } from "./lib/export";
import { withoutHidden } from "./lib/hidden-messages";
import { blobToBase64 } from "./lib/images";
import { useAppBadge } from "./lib/badge";
import { applyOpenIntent, claimPendingAnswer, setOpenIntent } from "./lib/inbox";
import { takePendingReview } from "./lib/fanout";
import { onJumpIntent, takeJumpIntent } from "./lib/jump-intent";
import { useNewSince } from "./lib/new-since";
import { emitRoute, parseRoute } from "./lib/notify-route";
import { usePush } from "./lib/push";
import { usePresence } from "./lib/use-presence";
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
import { PANE_IDS } from "./lib/pane-size";
import { usePaneLayout } from "./lib/use-pane-layout";
import { Splitter } from "./components/shell/Splitter";
import { PersonalRoutes } from "./components/shell/PersonalRoutes";
import { readJson, writeJson } from "./lib/storage";
import { ignoreStaleBuild, importChunk } from "./lib/stale-build";
import { openSettings } from "./lib/settings-ui";
import { currentSubagents } from "./lib/subagents";
import { currentTodos } from "./lib/todos";
import { loadTrim, saveTrim, trimEntries } from "./lib/trim";
import { sumUsage } from "./lib/usage";
import { limitedUntil } from "./lib/usage-limits";
import { useComputers } from "./lib/use-computers";
import { ComputerActionsContext, useForgetFreshComputers, type ComputerActions } from "./lib/use-fresh-computers";
import { PersonalContext, usePersonalProvider } from "./lib/use-personal";
import { useHostRecovery } from "./lib/use-host-recovery";
import { useGuestSnapshot } from "./lib/use-guest";
import { DEVICE_ORG } from "./lib/org-storage";
import { deleteOffered, isDeletableSession } from "./lib/session-delete";
import { type SessionOrgs, useSessionOrgs } from "./lib/use-session-org";
import type { ToolRenderHost } from "./tool-render";
import "./components/shell/shell.css";
import "./components/shell/companion.css";
import "./components/codemap/codemap.css";

/** Docked sessions sidebar preference (boolean, docked widths only); absent: open. */
const SIDEBAR_KEY = "omp.collab.sidebar";
/** Matches the shell.css breakpoint where the sessions sidebar stops docking beside the panel. */
const SIDEBAR_DOCK_QUERY = "(min-width: 1101px)";
/** Matches the shell.css breakpoint where the rail stops docking beside the transcript. */
const WIDE_QUERY = "(min-width: 901px)";
/** Visual viewport this much shorter than the layout viewport means an on-screen keyboard is up. */
const KEYBOARD_MIN_PX = 120;

/** How the open session was reached, until its welcome identifies the computer it runs on. */
interface Opened {
	link: string;
	computerId: string;
	instanceId: string;
}

/** A notification tap waiting for its computer to answer: open `instanceId`, sending `reply` once the session is live. */
interface PendingOpen {
	instanceId: string;
	computerId: string | null;
	reply: string | null;
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
	/** Session to open once its computer is live (notification tap). */
	const [pendingOpen, setPendingOpen] = useState<PendingOpen | null>(null);
	/** The computer process the current link was fetched from, until the session's welcome identifies it. */
	const [opened, setOpened] = useState<Opened | null>(null);
	/** The link of the session on screen, to rejoin it. */
	const lastLinkRef = useRef<string | null>(null);
	/** The current session was reopened from storage, not chosen by the user this launch. */
	const resumedRef = useRef(false);
	const { computers, pair: pairComputer, remove } = useComputers();
	const personal = usePersonalProvider(computers);
	const pushes = usePush(computers);
	usePresence(computers, pushes);
	const orgs = useSessionOrgs(computers, rooms);

	const pair = useCallback((next: PairingLink): void => void pairComputer(next), [pairComputer]);
	const removeComputer = useCallback(async (id: string): Promise<void> => setRooms(await remove(id)), [remove]);
	useForgetFreshComputers(computers, removeComputer);
	const computersRef = useRef(computers);
	computersRef.current = computers;
	const computerActions = useMemo<ComputerActions>(
		() => ({
			pair: pairComputer,
			remove: removeComputer,
			find: id => computersRef.current.find(entry => entry.id === id),
		}),
		[pairComputer, removeComputer],
	);
	const settingsEnv = useMemo<SettingsEnv>(
		() => ({ computers, pushes, orgs, onPair: pair, onRemoveComputer: removeComputer }),
		[computers, pushes, orgs, pair, removeComputer],
	);

	const connect = useCallback((link: string): void => {
		let next: GuestClient;
		try {
			next = new GuestClient(link, displayName());
		} catch (err) {
			setConnectError(err instanceof Error ? err.message : String(err));
			return;
		}
		next.connect();
		lastLinkRef.current = link;
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

	// Sessions were deleted: forget the rooms they were remembered by, and leave the one on screen if it was among them.
	const sessionsDeleted = useCallback(
		(done: DeletedSessions): void => {
			for (const roomId of done.roomIds) forgetRoom(roomId);
			if (done.closeOpen) leave();
			else setRooms(loadRooms());
		},
		[leave],
	);

	const rejoin = useCallback((): void => {
		const last = lastLinkRef.current;
		resumedRef.current = false;
		if (last) connect(last);
	}, [connect]);

	const remember = useCallback((room: Omit<RecentRoom, "lastSeen">): void => setRooms(rememberRoom(room)), []);

	// The host replaced the session's room: follow it, carrying the draft and queued prompts.
	const replaceRoom = useCallback(
		(from: string, next: string, computerId: string, instanceId: string): void => {
			const to = roomIdOf(next);
			if (to !== null) setRooms(moveRoom(from, to));
			resumedRef.current = false;
			connect(next);
			setOpened({ link: next, computerId, instanceId });
		},
		[connect],
	);

	const openHost = useCallback(
		async (computerId: string, instanceId: string): Promise<void> => {
			const computerClient = computerById(computers, computerId)?.client ?? null;
			if (!computerClient) throw new Error("that computer is not paired");
			const url = await computerClient.requestLink(instanceId);
			const next = extractLink(url);
			if (!next) throw new Error("the computer returned an unreadable link");
			applyOpenIntent(computerId, instanceId, next);
			resumedRef.current = false;
			connect(next);
			setOpened({ link: next, computerId, instanceId });
		},
		[computers, connect],
	);

	// The desktop shell's menu-bar icon or a native notification names a session: open it like a tapped push notification does.
	const openDesktopSession = useCallback((computerId: string, instanceId: string): void => {
		setPendingOpen({ instanceId, computerId, reply: null });
	}, []);

	const openLink = useCallback(
		(next: string): void => {
			resumedRef.current = false;
			connect(next);
		},
		[connect],
	);

	// The app icon shows how many sessions wait on an answer, summed over the computers whose lists are known.
	const answering = computers.filter(computer => computer.snap.phase === "live");
	useAppBadge(
		answering.length > 0
			? answering.reduce((sum, computer) => sum + computer.snap.hosts.filter(host => host.inputRequired).length, 0)
			: null,
	);

	/** A notification tap's route: open a session (sending the reply typed in the notification once it is live), or pass it to the component that owns it. */
	const followRoute = useCallback((hash: string): boolean => {
		const route = parseRoute(hash);
		if (route === null) return false;
		if (route.kind === "route") {
			emitRoute(route.route, route.computerId);
			return true;
		}
		setPendingOpen({ instanceId: route.instanceId, computerId: route.computerId, reply: route.reply });
		return true;
	}, []);

	// A notification tap: open its session on the computer it came from as soon as that computer lists hosts.
	useEffect(() => {
		if (pendingOpen === null) return;
		const plan = planOpen(computers, pendingOpen.instanceId, pendingOpen.computerId);
		if (plan.kind === "wait") return;
		setPendingOpen(null);
		if (plan.kind === "error") {
			setConnectError(plan.message);
			return;
		}
		if (pendingOpen.reply !== null) {
			setOpenIntent(plan.computer.id, pendingOpen.instanceId, { prompt: pendingOpen.reply });
		}
		openHost(plan.computer.id, pendingOpen.instanceId).catch((err: unknown) =>
			setConnectError(err instanceof Error ? err.message : String(err)),
		);
	}, [pendingOpen, computers, openHost]);

	useEffect(() => {
		if (!("serviceWorker" in navigator)) return;
		const onMessage = (e: MessageEvent): void => {
			const data = e.data as {
				t?: unknown;
				instanceId?: unknown;
				computer?: unknown;
				text?: unknown;
				route?: unknown;
			} | null;
			const computerId = typeof data?.computer === "string" ? data.computer : null;
			if (data?.t === "open-session" && typeof data.instanceId === "string") {
				setPendingOpen({ instanceId: data.instanceId, computerId, reply: null });
			} else if (
				data?.t === "notification-reply" &&
				typeof data.instanceId === "string" &&
				typeof data.text === "string"
			) {
				setPendingOpen({
					instanceId: data.instanceId,
					computerId,
					reply: data.text.trim() ? data.text : null,
				});
			} else if (data?.t === "open-route" && typeof data.route === "string") emitRoute(data.route, computerId);
		};
		navigator.serviceWorker.addEventListener("message", onMessage);
		return () => navigator.serviceWorker.removeEventListener("message", onMessage);
	}, []);

	// A room reopened from storage that the host has since closed: go straight to the
	// session list instead of parking on an "ended" card the user never asked for.
	const roomGone = useCallback(
		(roomId: string): void => {
			setRooms(forgetRoom(roomId));
			if (resumedRef.current) leave();
		},
		[leave],
	);

	// Visual Viewport: adjust app height to fit screen space when mobile keyboard opens. The visual viewport shrinks
	// by its own scale when the page is pinch-zoomed, which is not a keyboard: `height * scale` is what the keyboard
	// leaves of the window whatever the pinch. The height is a CSS length, so it is in layout px (the UI zoom divides).
	const zoom = useUiZoom();
	useEffect(() => {
		const vv = window.visualViewport;
		if (!vv) return;

		const updateHeight = () => {
			const visible = vv.height * vv.scale;
			document.documentElement.style.setProperty("--viewport-height", `${visible / zoom}px`);
			document.documentElement.toggleAttribute("data-keyboard", window.innerHeight - visible > KEYBOARD_MIN_PX);
			window.scrollTo(0, 0);
		};

		updateHeight();
		vv.addEventListener("resize", updateHeight);
		vv.addEventListener("scroll", updateHeight);

		return () => {
			vv.removeEventListener("resize", updateHeight);
			vv.removeEventListener("scroll", updateHeight);
		};
	}, [zoom]);

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
		connect(initial);
		resumedRef.current = explicit === null;
	}, [connect, pair, followRoute]);

	// Back from the background, network back, going to the background: see `useClientWake`.
	useClientWake(client);
	const beside = useBesideSession(client ? link : null, computers, displayName, setRooms);
	// The pet's view of every computer's sessions on the home screen.
	const allHosts = useMemo<readonly CompanionHost[]>(
		() => computers.flatMap(computer => computer.snap.hosts),
		[computers],
	);
	const anyLive = computers.some(computer => computer.snap.phase === "live");

	useEffect(() => {
		if (!client) document.title = "omp collab";
	}, [client]);

	return (
		<ComputerActionsContext.Provider value={computerActions}>
			<PersonalContext.Provider value={personal}>
				<DeleteHost computers={computers} orgs={orgs} onDeleted={sessionsDeleted}>
					<UpdateBar />
					<Tooltip />
					<FixItHost computers={computers} onOpenHost={openHost} onOpenLink={openLink} />
					{!client || !link ? (
						<ConnectScreen
							error={connectError}
							rooms={rooms}
							computers={computers}
							onConnect={next => {
								resumedRef.current = false;
								connect(next);
							}}
							onForget={forget}
							onPair={pair}
							onOpenHost={openHost}
							onRemoveComputer={removeComputer}
						/>
					) : (
						<Session
							key={link}
							client={client}
							link={link}
							openedHint={opened?.link === link ? opened : null}
							computers={computers}
							orgs={orgs}
							onPair={pair}
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
					<PetHost client={client} hosts={allHosts} hostsLive={anyLive} />
					<DesktopBridge computers={computers} onOpen={openDesktopSession} />
					<SettingsHost env={settingsEnv} />
					<ZoomHost />
					<PersonalRoutes computers={computers} onOpenHost={openHost} />
				</DeleteHost>
			</PersonalContext.Provider>
		</ComputerActionsContext.Provider>
	);
}

interface SessionProps {
	client: GuestClient;
	link: string;
	/** How this session was opened this launch (the computer and process its link came from), until the welcome identifies them. */
	openedHint: Opened | null;
	computers: readonly ComputerHandle[];
	orgs: SessionOrgs;
	onPair(link: PairingLink): void;
	rooms: readonly RecentRoom[];
	onLeave(): void;
	onRejoin(): void;
	onRemember(room: Omit<RecentRoom, "lastSeen">): void;
	onRoomGone(roomId: string): void;
	onRoomReplaced(from: string, link: string, computerId: string, instanceId: string): void;
	onOpenHost(computerId: string, instanceId: string): Promise<void>;
	onOpenLink(link: string): void;
	/** Split view: the second session pane and the controls that open it. */
	beside: BesideControl;
}

/** `?`, and the palette's Keyboard shortcuts: the Settings section that lists and remaps them. */
function openKeyboardSettings(): void {
	openSettings("keyboard");
}

/** Wide screens restore the docked sidebar; elsewhere it is a drawer and starts closed. */
function initialSidebar(): boolean {
	return matchesMedia(SIDEBAR_DOCK_QUERY) && readJson(SIDEBAR_KEY) !== false;
}

interface SearchState {
	query: string;
	target: string | null;
}

function Session({
	client,
	link,
	openedHint,
	computers,
	orgs,
	onPair,
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

	// Parked and aborted subagents stay in the rail (folded) but do not count on the badge.
	const subCount = useMemo(() => snap.agents.filter(a => a.kind === "sub" && !isInactive(a)).length, [snap.agents]);

	// The computer that runs this very session, and its host row. Working tree and file
	// viewing read through it, and are hidden when there is none.
	const sessionId = snap.header?.id ?? null;
	const roomId = useMemo(() => roomIdOf(link), [link]);
	const stored = useMemo(() => rooms.find(room => room.roomId === roomId) ?? null, [rooms, roomId]);
	const home = useMemo(
		() => resolveSessionHome(computers, sessionId, openedHint, stored),
		[computers, sessionId, openedHint, stored],
	);
	const { computer, hostId, instanceId } = home;
	const companionClient = computer?.client ?? null;
	const hosts = computer?.snap.hosts;
	const hostRow = hosts?.find(host => host.instanceId === hostId);
	/** This session's computer's id as a `onOpenHost` target for the sheets that only know instance ids. */
	const openHere = useCallback(
		(id: string): Promise<void> => {
			if (computer === null) return Promise.reject(new Error("that computer is not paired"));
			return onOpenHost(computer.id, id);
		},
		[computer, onOpenHost],
	);
	const [file, setFile] = useState<{ path: string; line?: number } | null>(null);
	const [codemap, setCodemap] = useState<{ file?: string } | null>(null);
	const canCodemap = companionClient !== null && hostId !== null && computer?.snap.canCodemap === true;
	const openCodemap = useCallback(() => setCodemap({}), []);
	const [architecture, setArchitecture] = useState<ArchitectureStart | null>(null);
	// Maps are listed across the computers; making one of this session's changes needs the computer that runs it.
	const canArchitecture = computers.some(candidate => candidate.client !== null && candidate.snap.canBlueprint);
	const canMapHere = companionClient !== null && hostId !== null && computer?.snap.canBlueprint === true;
	const openArchitecture = useCallback(() => setArchitecture({ view: "home" }), []);
	const mapChanges = useCallback(
		() => setArchitecture({ view: "new", preset: { mode: "worktree", base: "@default" } }),
		[],
	);
	const mapPr = useCallback((pr: { number: number; title: string }) => {
		setGithubOpen(false);
		setArchitecture({ view: "new", preset: { mode: "pr", pr } });
	}, []);
	const [quiz, setQuiz] = useState<QuizStart | null>(null);
	// Quizzes are listed across the computers; quizzing this session's changes needs the computer that runs it.
	const canQuiz = computers.some(candidate => candidate.client !== null && candidate.snap.canQuiz);
	const canQuizHere = companionClient !== null && hostId !== null && computer?.snap.canQuiz === true;
	const canQuizTopicHere = canQuizHere && computer !== null && topicQuizOffered(computer.snap, sessionId);
	const quizPr = useCallback((pr: { number: number; title: string }) => {
		setGithubOpen(false);
		setQuiz({ view: "new", subject: { kind: "pr", ...pr } });
	}, []);
	// Sparring is listed across the computers too; sparring on this session's changes needs the computer that runs it.
	const canSpar = computers.some(candidate => candidate.client !== null && candidate.snap.canSpar);
	const canSparHere = companionClient !== null && hostId !== null && computer?.snap.canSpar === true;
	const sparPr = useCallback((pr: { number: number; title: string }) => {
		setGithubOpen(false);
		setQuiz({ view: "spar-new", subject: { kind: "pr", ...pr } });
	}, []);
	// Bake-offs are listed across the computers too; bake-off of this session's changes needs the computer that runs it.
	const [bakeoff, setBakeoff] = useState<BakeoffStart | null>(null);
	const canBakeoff = computers.some(candidate => candidate.client !== null && candidate.snap.canBakeoff);
	const canBakeoffHere = companionClient !== null && hostId !== null && computer?.snap.canBakeoff === true;
	const bakeoffSpar = useCallback((computerId: string, spar: Spar, run: SparRun) => {
		void importChunk(() => import("./components/bakeoff/bakeoff-spar"))
			.then(({ bakeoffFromSpar }) => {
				setQuiz(null);
				setBakeoff(bakeoffFromSpar(computerId, spar, run));
			})
			.catch(ignoreStaleBuild);
	}, []);
	// The editor replaces the read-only file viewer once the paired computer can save files.
	const canEdit = companionClient !== null && hostId !== null && computer?.snap.canEdit === true;
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
	// A vendor agent's host process has no terminal worth watching: the transcript is the session.
	const canPane = companionClient !== null && hostId !== null && snap.agent === null;
	const canPreview =
		companionClient !== null && hostId !== null && sessionId !== null && computer?.snap.canPreview === true;
	// Voice input rides the companion; a reconnect blip (`connecting`) must not discard a recording.
	const companionPhase = computer?.snap.phase;
	const transcribe = computer?.snap.transcribe ?? null;
	const machine = computer?.snap.machine ?? null;
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
	const canUpload = computer?.snap.canUpload === true;
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
	const canGithub = companionClient !== null && hostId !== null && computer?.snap.canGithub === true;
	const composerExtras = useComposerExtras(snap, companionClient, hostId, canGithub);
	const [githubOpen, setGithubOpen] = useState(false);
	const openGithub = useCallback(() => setGithubOpen(true), []);
	// Running commands needs a session this device may control and that is not confined to file tools.
	const runSandboxed = computer?.snap.hosts.some(host => host.instanceId === hostId && host.sandboxed) ?? false;
	const canRun =
		companionClient !== null && hostId !== null && computer?.snap.canRun === true && !snap.readOnly && !runSandboxed;
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
	const hidden = useHiddenMessages(sessionId, computer);
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
	// "Try on several models": the composer's draft starts in worktrees of this session's repository on the computer that runs it.
	const canFanout = computer?.snap.canFanout === true;
	const canSandbox = computer?.snap.canSandbox === true;
	const fanoutTarget = useMemo<FanoutTarget | null>(
		() =>
			companionClient !== null && hostId !== null && cwd !== null && canFanout && !snap.readOnly && !runSandboxed
				? { client: companionClient, cwd, canSandbox, onOpen: openHere }
				: null,
		[companionClient, hostId, cwd, canFanout, canSandbox, snap.readOnly, runSandboxed, openHere],
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

	// The live name first: the header carries the session file's title as of joining, so a rename would not show.
	const title = snap.state?.sessionName ?? snap.header?.title ?? "session";
	// Deleting the open session needs its computer to delete sessions, and an omp session that is not the Personal agent's.
	const requestDelete = useDeleteSessions()?.request ?? null;
	const deleteComputerId = computer !== null && deleteOffered(computer.snap) ? computer.id : null;
	const isOmpSession = isDeletableSession({ agent: snap.agent ?? undefined, personal: hostRow?.personal });
	const deleteSession = useMemo(() => {
		if (requestDelete === null || deleteComputerId === null || sessionId === null || !isOmpSession) return null;
		return () =>
			requestDelete({
				computerId: deleteComputerId,
				sessions: [{ sessionId, title, roomIds: roomId === null ? [] : [roomId] }],
				openSessionId: sessionId,
			});
	}, [requestDelete, deleteComputerId, sessionId, isOmpSession, title, roomId]);
	useEffect(() => {
		document.title = `${title} · omp collab`;
	}, [title]);

	// Remember every room that welcomed us, so a later launch can offer it again.
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
	// `instanceId` is the computer's process for this room: matched by session id once welcomed; until
	// then (and after the host switched sessions) the one it was opened from or last seen as.
	const computerId = computer?.id ?? null;
	useEffect(() => {
		if (live && roomId !== null) {
			onRemember({
				roomId,
				link,
				title,
				cwd,
				readOnly: snap.readOnly,
				computerId: computerId ?? undefined,
				instanceId: instanceId ?? undefined,
			});
		}
	}, [live, roomId, link, title, cwd, snap.readOnly, computerId, instanceId, onRemember]);

	// A room the host replaced reopens through the computer that runs it; "ended" and
	// forgetting the room wait until the computer has answered.
	const followRoom = useCallback(
		(next: string): void => {
			if (roomId !== null && computerId !== null && instanceId !== null) {
				onRoomReplaced(roomId, next, computerId, instanceId);
			}
		},
		[roomId, computerId, instanceId, onRoomReplaced],
	);
	const recovery = useHostRecovery(computer, instanceId, snap.phase, roomId, followRoom);
	const ended = snap.phase === "ended" && recovery === "absent";

	// The relay no longer knows this room: the host closed it.
	const gone = ended && snap.endedReason === "no such room";
	useEffect(() => {
		if (gone && roomId !== null) onRoomGone(roomId);
	}, [gone, roomId, onRoomGone]);

	const drawerAgent = selectedId != null ? snap.agents.find(a => a.id === selectedId) : undefined;
	const toggleRail = useCallback(() => setRailOpen(open => !open), []);
	const closeDrawer = useCallback(() => setSelectedId(null), []);

	const [chat, changeChat] = useState(defaultChat);

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
	// Entries before the latest `/clear` fold behind a one-line expander; expanding is per boundary,
	// so a newer `/clear` folds the page again.
	const [openedClear, setOpenedClear] = useState<string | null>(null);
	const clear = useMemo(() => latestClear(snap.entries), [snap.entries]);
	const clearBoundary = clear?.boundaryId;
	const showCleared = useCallback(() => setOpenedClear(clearBoundary ?? null), [clearBoundary]);
	const cleared = useMemo(
		() =>
			clear === null || clear.boundaryId === openedClear
				? undefined
				: { from: clear.from, hiddenMessages: clear.hiddenMessages, onShow: showCleared },
		[clear, openedClear, showCleared],
	);
	const shownEntries = useMemo(() => {
		const from = Math.max(trimmed?.from ?? 0, cleared?.from ?? 0);
		return from === 0 ? snap.entries : snap.entries.slice(from);
	}, [snap.entries, trimmed, cleared]);

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
	// Showing a quiz's citation of the conversation: the quiz gives way to the transcript, scrolled to that message.
	// Opening a quiz clears the jump, so showing the same message again scrolls again.
	const showQuizEntry = useCallback((entryId: string) => {
		setQuiz(null);
		setSearch(null);
		setJumpTarget(entryId);
	}, []);
	const quizOpen = quiz !== null;
	useEffect(() => {
		if (quizOpen) setJumpTarget(null);
	}, [quizOpen]);
	const [changesOpen, setChangesOpen] = useState(false);
	// A kept model-comparison winner opens on its branch review, where the pull request is made.
	const [changesTab, setChangesTab] = useState<"branch" | undefined>(undefined);
	const openChanges = useCallback(() => {
		setChangesTab(undefined);
		setChangesOpen(true);
	}, []);
	useEffect(() => {
		if (computerId === null || hostId === null || !takePendingReview(computerId, hostId)) return;
		setChangesTab("branch");
		setChangesOpen(true);
	}, [computerId, hostId]);
	const quizChanges = useCallback(() => {
		setChangesOpen(false);
		setQuiz({ view: "new", subject: { kind: "changes" } });
	}, []);
	const openQuizzes = useCallback(() => setQuiz({ view: "home" }), []);
	const quizTopic = useCallback(() => setQuiz({ view: "new", subject: { kind: "topic" } }), []);
	// The quiz a blocked push needs, opened on its own: the Changes and GitHub sheets give way to it.
	const openStakesQuiz = useCallback(
		(id: string) => {
			if (computerId === null) return;
			setChangesOpen(false);
			setGithubOpen(false);
			setQuiz({ view: "quiz", computerId, id });
		},
		[computerId],
	);
	const canStakes = computer?.snap.canHighStakes === true;
	const listed = hostRow !== undefined;
	const stakesIsOn = listed && stakesOn({ canHighStakes: canStakes }, hostRow);
	const stakesShown = stakesToggleShown({ canHighStakes: canStakes }, snap.agent);
	const highStakes = useMemo<StakesControl | null>(
		() =>
			stakesShown && listed && companionClient !== null && hostId !== null
				? { client: companionClient, instanceId: hostId, on: stakesIsOn }
				: null,
		[stakesShown, listed, stakesIsOn, companionClient, hostId],
	);
	const sparChanges = useCallback(() => {
		setChangesOpen(false);
		setQuiz({ view: "spar-new", subject: { kind: "changes" } });
	}, []);
	const openSparring = useCallback(() => setQuiz({ view: "spar-home" }), []);
	const sparDesign = useCallback((path: string) => {
		setEditor(null);
		setQuiz({ view: "spar-new", subject: { kind: "doc" }, doc: { source: "file", path } });
	}, []);
	const bakeoffChanges = useCallback(() => {
		setChangesOpen(false);
		setBakeoff({ view: "new", subject: { kind: "changes" } });
	}, []);
	const openBakeoffs = useCallback(() => setBakeoff({ view: "home" }), []);
	const bakeoffJoins = useMemo<BakeoffJoins>(
		() => ({
			mapEntry: canMapHere
				? (_computerId, _bakeoff, entry) => {
						if (entry.path === undefined) return;
						setBakeoff(null);
						setArchitecture({ view: "new", preset: { mode: "worktree", cwd: entry.path, base: "@default" } });
					}
				: undefined,
			sparEntry: canSparHere
				? (_computerId, source, entry) => {
						// An entry with a branch is a change to argue with; one without (a design, the original) is its write-up.
						if (entry.branch !== undefined) {
							setBakeoff(null);
							setQuiz({ view: "spar-new", subject: { kind: "branch", name: entry.branch } });
							return;
						}
						void importChunk(() => import("./components/bakeoff/bakeoff-result-flow"))
							.then(({ designMarkdown }) => {
								setBakeoff(null);
								setQuiz({
									view: "spar-new",
									subject: { kind: "doc" },
									doc: {
										source: "paste",
										name: `${source.title} (entry ${entry.label})`,
										text: designMarkdown(source, entry),
									},
								});
							})
							.catch(ignoreStaleBuild);
					}
				: undefined,
		}),
		[canMapHere, canSparHere],
	);
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
	const otherHosts = computers.flatMap(candidate => candidate.snap.hosts.filter(host => host.sessionId !== sessionId));
	const canSwitch = otherHosts.length > 0 || rooms.some(room => room.roomId !== roomId);
	// Only the docked sidebar's state is remembered: a drawer reopening on the next
	// launch would cover the transcript.
	const changeSidebar = useCallback((next: boolean): void => {
		if (matchesMedia(SIDEBAR_DOCK_QUERY)) writeJson(SIDEBAR_KEY, next);
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
	// Copy, Export and Share of the conversation leave out the messages hidden from the chat, unless they are being shown.
	const hiddenRef = useRef(hidden.control);
	hiddenRef.current = hidden.control;
	const exportMarkdown = useCallback((title: string) => {
		const hide = hiddenRef.current;
		const entries =
			hide === undefined || hide.showing ? entriesRef.current : withoutHidden(entriesRef.current, hide.hidden);
		return sessionMarkdown(entries, { title });
	}, []);

	// Desktop shortcuts (the keymap lives in lib/shortcuts.ts, which the help sheet lists too). Typing in a
	// field suppresses everything but Esc; an open sheet or drawer owns Esc itself, and the composer aborts a
	// running turn on its own Esc. The transcript handles its own keys (blocks, jump, copy, edit).
	const paired = computers.length > 0;
	const canShowSidebar = canSwitch || paired;
	const showSidebar = sidebarOpen && canShowSidebar;
	const readOnly = snap.readOnly;
	const working = snap.working;
	const searchOpen = search !== null;
	const [sessionSheetOpen, setSessionSheetOpen] = useState(false);
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
				else if (showSidebar && !matchesMedia(SIDEBAR_DOCK_QUERY)) setSidebarOpen(false);
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
				openKeyboardSettings();
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
		sidebarDrawerOpen: showSidebar && !matchesMedia(SIDEBAR_DOCK_QUERY),
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
				onSparDesign={canSparHere ? sparDesign : null}
				onClose={() => setEditor(null)}
			/>
		) : null;
	const ideDocked = ideSheet !== null && ideDock?.docked === true;
	const besideOpen = beside.available && beside.pane !== null;

	// Resizable panes: only the ones docked in the row (the sidebar and rail are overlays on narrow screens) get a divider.
	const mainRef = useRef<HTMLElement>(null);
	const sidebarDocked = useMedia(SIDEBAR_DOCK_QUERY) && showSidebar;
	const railDocked = useMedia(WIDE_QUERY) && railOpen;
	const dockedPanes = useMemo(
		() =>
			PANE_IDS.filter(
				id => ({ sidebar: sidebarDocked, rail: railDocked, beside: besideOpen, editor: ideDocked })[id],
			),
		[sidebarDocked, railDocked, besideOpen, ideDocked],
	);
	const paneLayout = usePaneLayout(mainRef, dockedPanes);

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
			openShortcuts: openKeyboardSettings,
			openUsage: paired ? openUsage : null,
			openSessions: paired ? openSessions : null,
			openCodemap: canCodemap ? openCodemap : null,
			openArchitecture: canArchitecture ? openArchitecture : null,
			mapChanges: canMapHere && changes.length > 0 ? mapChanges : null,
			quizChanges: canQuizHere && changes.length > 0 ? quizChanges : null,
			openQuizzes: canQuizHere ? openQuizzes : null,
			sparChanges: canSparHere && changes.length > 0 ? sparChanges : null,
			openSparring: canSparHere ? openSparring : null,
			bakeoffChanges: canBakeoffHere && changes.length > 0 ? bakeoffChanges : null,
			openBakeoffs: canBakeoffHere ? openBakeoffs : null,
			openPane: canPane ? openPane : null,
			openPreview: canPreview ? openPreview : null,
			openGithub: canGithub ? openGithub : null,
			openRun: canRun ? openRun : null,
			openEditor: canEdit ? openEditor : null,
			turnUndo: turnUndo.control,
			onLeave,
		}),
		[
			canCodemap,
			canArchitecture,
			canMapHere,
			canQuizHere,
			canSparHere,
			canBakeoffHere,
			canEdit,
			canGithub,
			canPane,
			canPreview,
			canRun,
			canShowSidebar,
			changeChat,
			changes.length,
			chat,
			paired,
			hasChanges,
			hostId,
			onLeave,
			onOpenLink,
			openChanges,
			openCodemap,
			mapChanges,
			quizChanges,
			openQuizzes,
			sparChanges,
			openSparring,
			bakeoffChanges,
			openBakeoffs,
			openArchitecture,
			openEditor,
			openGithub,
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
				sandboxed={computer?.snap.hosts.some(host => host.sessionId === sessionId && host.sandboxed) ?? false}
				highStakes={highStakes}
				agent={snap.agent}
				canPermission={Object.hasOwn(snap.features, "permission-mode")}
				subCount={subCount}
				railOpen={railOpen}
				onToggleRail={toggleRail}
				onLeave={onLeave}
				onDeleteSession={deleteSession}
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
				hiddenMessages={hidden.control}
				contextItems={Object.hasOwn(snap.features, "context-items") ? snap.contextItems : undefined}
				canWatchPr={Object.hasOwn(snap.features, "pr-watch")}
				exportMarkdown={exportMarkdown}
				onOpenChanges={openChanges}
				onOpenUsage={paired ? openUsage : null}
				onOpenSessions={paired ? openSessions : null}
				onOpenCodemap={canCodemap ? openCodemap : null}
				onOpenArchitecture={canArchitecture ? openArchitecture : null}
				onMapChanges={canMapHere && changes.length > 0 ? mapChanges : null}
				onOpenQuizzes={canQuizHere ? openQuizzes : null}
				onOpenSparring={canSparHere ? openSparring : null}
				onOpenBakeoff={canBakeoffHere ? openBakeoffs : null}
				onOpenPane={canPane ? openPane : null}
				onQuizTopic={canQuizTopicHere ? quizTopic : null}
				onOpenPreview={canPreview ? openPreview : null}
				onOpenGithub={canGithub ? openGithub : null}
				onOpenRun={canRun ? openRun : null}
				onOpenEditor={canEdit ? openEditor : null}
				onOpenTimeline={canTimeline ? openTimeline : null}
				screenCount={screens.length}
				onOpenScreens={openScreens}
			/>
			<main ref={mainRef} className="sh-main" data-split={(besideOpen ? 1 : 0) + (ideDocked ? 1 : 0) || undefined}>
				{showSidebar && (
					<>
						<div className="sh-sidebar-backdrop" onClick={() => setSidebarOpen(false)} />
						<aside className="sh-sidebar-dock">
							<SessionsSidebar
								computers={computers}
								rooms={rooms}
								currentSessionId={sessionId}
								currentRoomId={roomId}
								onOpenHost={onOpenHost}
								onOpenLink={onOpenLink}
								onOpenUsage={paired ? openUsage : null}
								onOpenSessions={paired ? openSessions : null}
								onClose={closeSidebar}
								beside={beside.available ? beside : null}
								orgs={orgs}
								onPair={onPair}
								limitResetAt={limitedUntil(snap.state ?? undefined, Date.now())}
							/>
						</aside>
					</>
				)}
				{sidebarDocked && <Splitter pane="sidebar" layout={paneLayout} />}
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
							cleared={cleared}
							onEditPrompt={editPrompt.onEditPrompt}
							onTurnChanges={turnChanges.onTurnChanges}
							onSendToAgent={snap.readOnly ? undefined : sendToAgent}
							sessionModel={snap.state?.model?.id}
							hide={hidden.control}
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
							onSnooze={
								sessionId === null
									? undefined
									: until => orgs.of(computer?.id ?? DEVICE_ORG).act(sessionId, { type: "snooze", until })
							}
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
				{railDocked && <Splitter pane="rail" layout={paneLayout} />}
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
				{besideOpen && <Splitter pane="beside" layout={paneLayout} />}
				{beside.pane !== null && besideOpen && (
					<SplitPane
						key={beside.pane.link}
						client={beside.pane.client}
						link={beside.pane.link}
						computers={computers}
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
				{ideDocked && <Splitter pane="editor" layout={paneLayout} />}
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
			{hidden.bar}
			<SpendCapBar spend={Object.hasOwn(snap.features, "spend-cap") ? snap.state?.spend : undefined} />
			<Toasts notices={snap.notices} />
			<SessionAlert computers={computers} currentSessionId={sessionId} onOpen={onOpenHost} />
			{statsSheet === "usage" && paired && (
				<UsageSheet
					computers={computers}
					limitsComputerId={computer?.id}
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
			{statsSheet === "sessions" && paired && (
				<SessionsSheet
					computers={computers}
					initial={sessionsSearch ?? undefined}
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
									canPr: computer?.snap.canPr ?? false,
									canGitFlow: computer?.snap.canGitFlow ?? false,
									busy: hostRow?.busy ?? null,
									title: hostRow?.sessionName ?? null,
								}
							: null
					}
					sessionId={sessionId}
					onSendToAgent={snap.readOnly ? null : sendReviewToAgent}
					onQuiz={canQuizHere ? quizChanges : null}
					onOpenQuiz={canQuizHere ? openStakesQuiz : null}
					onSpar={canSparHere ? sparChanges : null}
					onBakeoff={canBakeoffHere ? bakeoffChanges : null}
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
			{codemap !== null && canCodemap && computer !== null && (
				<LazyCodemapSheet
					key={codemap.file ?? ""}
					client={companionClient}
					instanceId={hostId}
					initialFile={codemap.file}
					canStart={computer.snap.canStart}
					currentSessionId={sessionId}
					onOpenHost={openHere}
					onOpenLink={onOpenLink}
					onOpenFile={openFile}
					onClose={() => setCodemap(null)}
				/>
			)}
			{architecture !== null && canArchitecture && (
				<LazyArchitectureSheet
					computers={computers}
					computerId={computer?.id ?? null}
					cwd={hostId !== null ? cwd : null}
					instanceId={hostId}
					start={architecture}
					onOpenHost={onOpenHost}
					onOpenFile={canEdit ? openFile : undefined}
					onClose={() => setArchitecture(null)}
				/>
			)}
			{quiz !== null && (canQuiz || canSpar) && (
				<LazyQuizSheet
					computers={computers}
					computerId={computer?.id ?? null}
					cwd={hostId !== null ? cwd : null}
					instanceId={hostId}
					sessionId={hostId !== null ? sessionId : null}
					start={quiz}
					onOpenHost={onOpenHost}
					onOpenFile={canEdit ? openFile : undefined}
					onBakeoff={canBakeoff ? bakeoffSpar : undefined}
					onShowEntry={hostId !== null && sessionId !== null ? showQuizEntry : undefined}
					onClose={() => setQuiz(null)}
				/>
			)}
			{bakeoff !== null && canBakeoff && (
				<LazyBakeoffSheet
					computers={computers}
					computerId={computer?.id ?? null}
					cwd={hostId !== null ? cwd : null}
					instanceId={hostId}
					sessionId={hostId !== null ? sessionId : null}
					start={bakeoff}
					joins={bakeoffJoins}
					onOpenHost={onOpenHost}
					onOpenFile={canEdit ? openFile : undefined}
					onClose={() => setBakeoff(null)}
				/>
			)}
			{paneOpen && canPane && companionClient !== null && hostId !== null && (
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
					canReview={computer?.snap.canPrReview === true}
					sandboxed={computer?.snap.hosts.some(host => host.instanceId === hostId && host.sandboxed) ?? false}
					canFixIt={computer?.snap.canFixIt === true}
					onMapPr={canMapHere ? mapPr : null}
					onQuizPr={canQuizHere ? quizPr : null}
					onOpenQuiz={canQuizHere ? openStakesQuiz : null}
					onSparPr={canSparHere ? sparPr : null}
					onClose={() => setGithubOpen(false)}
				/>
			)}
			<PaletteHost
				actions={paletteActions}
				control={paletteControl}
				title={title}
				exportMarkdown={exportMarkdown}
				commands={snap.commands}
				followsRoom={companionClient !== null && instanceId !== null}
				entries={snap.entries}
				sessionId={sessionId}
				computers={computers}
				currentComputerId={computer?.id ?? null}
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
