import type { SessionCommand } from "@oh-my-pi/pi-wire";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentDrawer } from "./components/agents/AgentDrawer";
import { AgentsPanel } from "./components/agents/AgentsPanel";
import { CodemapSheet } from "./components/codemap/CodemapSheet";
import { Banners } from "./components/shell/Banners";
import { ChangesSheet } from "./components/shell/ChangesSheet";
import { Composer } from "./components/shell/Composer";
import { ConnectScreen } from "./components/shell/ConnectScreen";
import { FileSheet } from "./components/shell/FileSheet";
import { HeaderBar } from "./components/shell/HeaderBar";
import { SearchBar } from "./components/shell/SearchBar";
import { SessionAlert } from "./components/shell/SessionAlert";
import { SessionsSheet } from "./components/shell/SessionsSheet";
import { SessionsSidebar } from "./components/shell/SessionsSidebar";
import { Toasts } from "./components/shell/Toasts";
import { UsageSheet } from "./components/shell/UsageSheet";
import { Transcript } from "./components/transcript/Transcript";
import { collectChanges } from "./lib/changes";
import { GuestClient } from "./lib/client";
import { extractPairing, loadPairing, savePairing } from "./lib/companion";
import { useNewSince } from "./lib/new-since";
import { type PushControl, usePush } from "./lib/push";
import { registerServiceWorker, takeSharedLink } from "./lib/pwa";
import {
	activeLink,
	extractLink,
	forgetRoom,
	loadRooms,
	type RecentRoom,
	rememberRoom,
	roomIdOf,
	setActiveLink,
} from "./lib/rooms";
import { readJson, writeJson } from "./lib/storage";
import { sumUsage } from "./lib/usage";
import { type CompanionHandle, useCompanion } from "./lib/use-companion";
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
/** Hash a notification tap launches the app with (see scripts/build-sw.ts): `#open:<instanceId>`. */
const OPEN_PREFIX = "open:";
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
	const [link, setLink] = useState<string | null>(null);
	const [connectError, setConnectError] = useState<string | null>(null);
	const [rooms, setRooms] = useState<RecentRoom[]>(loadRooms);
	const [pairing, setPairing] = useState<string | null>(loadPairing);
	/** Companion host to open once the companion is live (notification tap). */
	const [pendingOpen, setPendingOpen] = useState<string | null>(null);
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
		setClient(prev => {
			prev?.close();
			return next;
		});
	}, []);

	const leave = useCallback((): void => {
		setActiveLink(null);
		setRooms(loadRooms());
		setClient(prev => {
			prev?.close();
			return null;
		});
		history.replaceState(null, "", window.location.pathname + window.location.search);
	}, []);

	const forget = useCallback((roomId: string): void => setRooms(forgetRoom(roomId)), []);

	const rejoin = useCallback((): void => {
		const creds = credsRef.current;
		resumedRef.current = false;
		if (creds) connect(creds.link, creds.name);
	}, [connect]);

	const remember = useCallback((room: Omit<RecentRoom, "lastSeen">): void => setRooms(rememberRoom(room)), []);

	const pair = useCallback((link: string | null): void => {
		savePairing(link);
		setPairing(link);
	}, []);

	const companionClient = companion.client;
	const openHost = useCallback(
		async (instanceId: string): Promise<void> => {
			if (!companionClient) throw new Error("no paired computer");
			const url = await companionClient.requestLink(instanceId);
			const next = extractLink(url);
			if (!next) throw new Error("the computer returned an unreadable link");
			resumedRef.current = false;
			connect(next, credsRef.current?.name ?? storedName());
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

	// A notification tap: open its session as soon as the companion lists hosts.
	const { phase: companionPhase, hosts } = companion.snap;
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
			const data = e.data as { t?: unknown; instanceId?: unknown } | null;
			if (data?.t === "open-session" && typeof data.instanceId === "string") setPendingOpen(data.instanceId);
		};
		navigator.serviceWorker.addEventListener("message", onMessage);
		return () => navigator.serviceWorker.removeEventListener("message", onMessage);
	}, []);

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
		if (hash?.startsWith(OPEN_PREFIX)) {
			setPendingOpen(hash.slice(OPEN_PREFIX.length));
			history.replaceState(null, "", window.location.pathname + window.location.search);
			return;
		}
		const explicit = hash ?? takeSharedLink();
		const initial = explicit ?? activeLink();
		if (!initial) return;
		connect(initial, storedName());
		resumedRef.current = explicit === null;
	}, [connect, pair]);

	// Back from the background or offline: reconnect now, not when the backoff expires.
	useEffect(() => {
		if (!client) return;
		const wake = (): void => {
			if (document.visibilityState === "visible") client.resume();
		};
		document.addEventListener("visibilitychange", wake);
		window.addEventListener("online", wake);
		window.addEventListener("pageshow", wake);
		return () => {
			document.removeEventListener("visibilitychange", wake);
			window.removeEventListener("online", wake);
			window.removeEventListener("pageshow", wake);
		};
	}, [client]);

	useEffect(() => {
		if (!client) document.title = "omp collab";
	}, [client]);

	if (!client || !link) {
		return (
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
		);
	}
	return (
		<Session
			key={link}
			client={client}
			link={link}
			companion={pairing ? companion : null}
			push={push}
			rooms={rooms}
			onLeave={leave}
			onRejoin={rejoin}
			onRemember={remember}
			onRoomGone={roomGone}
			onOpenHost={openHost}
			onOpenLink={openLink}
		/>
	);
}

interface SessionProps {
	client: GuestClient;
	link: string;
	companion: CompanionHandle | null;
	push: PushControl;
	rooms: readonly RecentRoom[];
	onLeave(): void;
	onRejoin(): void;
	onRemember(room: Omit<RecentRoom, "lastSeen">): void;
	onRoomGone(roomId: string): void;
	onOpenHost(instanceId: string): Promise<void>;
	onOpenLink(link: string): void;
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
	companion,
	push,
	rooms,
	onLeave,
	onRejoin,
	onRemember,
	onRoomGone,
	onOpenHost,
	onOpenLink,
}: SessionProps): ReactNode {
	const snap = useGuestSnapshot(client);
	const [railOpen, setRailOpen] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const autoOpenedRef = useRef(false);

	const subCount = useMemo(() => snap.agents.filter(a => a.kind === "sub").length, [snap.agents]);

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
	const [codemapOpen, setCodemapOpen] = useState(false);
	const canCodemap = companionClient !== null && hostId !== null && companion?.snap.canCodemap === true;
	const openCodemap = useCallback(() => setCodemapOpen(true), []);

	// Task-card agent chips drill into the same drawer the rail uses.
	const agentIds = useMemo(() => new Set(snap.agents.map(a => a.id)), [snap.agents]);
	const toolHost = useMemo<ToolRenderHost>(
		() => ({
			hasAgent: id => agentIds.has(id),
			openAgent: id => {
				if (agentIds.has(id)) setSelectedId(id);
			},
			openFile: hostId !== null ? path => setFile({ path }) : undefined,
		}),
		[agentIds, hostId],
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

	const title = snap.header?.title ?? snap.state?.sessionName ?? "session";
	useEffect(() => {
		document.title = `${title} · omp collab`;
	}, [title]);

	// Remember every room that welcomed us, so a later launch can offer it again.
	const roomId = useMemo(() => roomIdOf(link), [link]);
	const live = snap.phase === "live";
	const cwd = snap.state?.cwd ?? snap.header?.cwd ?? null;
	useEffect(() => {
		if (live && roomId !== null) onRemember({ roomId, link, title, cwd, readOnly: snap.readOnly });
	}, [live, roomId, link, title, cwd, snap.readOnly, onRemember]);

	// The relay no longer knows this room: the host closed it.
	const gone = snap.phase === "ended" && snap.endedReason === "no such room";
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

	const [search, setSearch] = useState<SearchState | null>(null);
	const toggleSearch = useCallback(() => setSearch(open => (open ? null : { query: "", target: null })), []);
	const closeSearch = useCallback(() => setSearch(null), []);
	const onSearch = useCallback((query: string, target: string | null) => setSearch({ query, target }), []);

	const changes = useMemo(() => collectChanges(snap.entries), [snap.entries]);
	const [changesOpen, setChangesOpen] = useState(false);
	const openChanges = useCallback(() => setChangesOpen(true), []);

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
				if (dialogOpen) return;
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
			} else if (e.key === "/" && !e.metaKey && !e.ctrlKey && !searchOpen) {
				e.preventDefault();
				setSearch({ query: "", target: null });
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [canShowSidebar, client, closeSearch, live, readOnly, searchOpen, showSidebar, toggleSidebar, working]);

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
				changeCount={changes.length}
				workingTree={hostId !== null}
				sessionUsage={sessionUsage}
				models={snap.models}
				onSessionCommand={sendSessionCommand}
				onOpenChanges={openChanges}
				onOpenUsage={companion ? openUsage : null}
				onOpenSessions={companion ? openSessions : null}
				onOpenCodemap={canCodemap ? openCodemap : null}
				push={push}
			/>
			<main className="sh-main">
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
							/>
						</aside>
					</>
				)}
				<section className="sh-panel" data-rail={railOpen ? "true" : "false"}>
					{search && <SearchBar entries={snap.entries} onSearch={onSearch} onClose={closeSearch} />}
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
							search={search ?? undefined}
							newSince={newSince ?? undefined}
							newSeen={newSeen}
							onNewSeen={markSeen}
							onTail={markTail}
							queued={snap.queued}
							onCancelQueued={cancelQueued}
						/>
					</div>
					<Composer
						key={roomId}
						client={client}
						phase={snap.phase}
						readOnly={snap.readOnly}
						uiRequest={snap.uiRequest}
						working={snap.working}
						queuedMessageCount={snap.state?.queuedMessageCount ?? 0}
						draftKey={roomId}
					/>
				</section>
				{railOpen && (
					<>
						<div className="sh-rail-backdrop" onClick={() => setRailOpen(false)} />
						<aside className="sh-rail">
							<AgentsPanel
								agents={snap.agents}
								progress={snap.progress}
								lifecycle={snap.lifecycle}
								selectedId={selectedId}
								onSelect={setSelectedId}
							/>
						</aside>
					</>
				)}
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
				phase={snap.phase}
				endedReason={snap.endedReason}
				loading={snap.loading}
				onRejoin={onRejoin}
				onNewLink={onLeave}
			/>
			<Toasts notices={snap.notices} />
			{companion && <SessionAlert hosts={companion.snap.hosts} currentSessionId={sessionId} onOpen={onOpenHost} />}
			{statsSheet === "usage" && companionClient !== null && (
				<UsageSheet client={companionClient} onClose={() => setStatsSheet(null)} />
			)}
			{statsSheet === "sessions" && companionClient !== null && companion !== null && (
				<SessionsSheet
					client={companionClient}
					canStart={companion.snap.canStart}
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
					onClose={() => setChangesOpen(false)}
				/>
			)}
			{codemapOpen && canCodemap && (
				<CodemapSheet
					client={companionClient}
					instanceId={hostId}
					onOpenFile={(path, line) => setFile({ path, line })}
					onClose={() => setCodemapOpen(false)}
				/>
			)}
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
