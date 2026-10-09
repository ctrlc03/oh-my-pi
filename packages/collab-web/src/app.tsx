import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentDrawer } from "./components/agents/AgentDrawer";
import { AgentsPanel } from "./components/agents/AgentsPanel";
import { Banners } from "./components/shell/Banners";
import { Composer } from "./components/shell/Composer";
import { ConnectScreen } from "./components/shell/ConnectScreen";
import { HeaderBar } from "./components/shell/HeaderBar";
import { Toasts } from "./components/shell/Toasts";
import { Transcript } from "./components/transcript/Transcript";
import { GuestClient } from "./lib/client";
import { registerServiceWorker, takeSharedLink } from "./lib/pwa";
import { activeLink, forgetRoom, loadRooms, type RecentRoom, rememberRoom, roomIdOf, setActiveLink } from "./lib/rooms";
import { useGuestSnapshot } from "./lib/use-guest";
import type { ToolRenderHost } from "./tool-render";
import "./components/shell/shell.css";

const NAME_KEY = "omp.collab.name";
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
	const credsRef = useRef<Creds | null>(null);
	/** The current session was reopened from storage, not chosen by the user this launch. */
	const resumedRef = useRef(false);

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

	// Launch: a deep link in the hash wins, then a share-sheet payload, then the
	// session this client was showing when the OS last killed it (home-screen launches
	// open `start_url`, which carries no fragment).
	useEffect(() => {
		registerServiceWorker();
		const explicit = hashLink() ?? takeSharedLink();
		const initial = explicit ?? activeLink();
		if (!initial) return;
		connect(initial, storedName());
		resumedRef.current = explicit === null;
	}, [connect]);

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
				onConnect={(next, name) => {
					resumedRef.current = false;
					connect(next, name);
				}}
				onForget={forget}
			/>
		);
	}
	return (
		<Session
			client={client}
			link={link}
			onLeave={leave}
			onRejoin={rejoin}
			onRemember={remember}
			onRoomGone={roomGone}
		/>
	);
}

interface SessionProps {
	client: GuestClient;
	link: string;
	onLeave(): void;
	onRejoin(): void;
	onRemember(room: Omit<RecentRoom, "lastSeen">): void;
	onRoomGone(roomId: string): void;
}

function Session({ client, link, onLeave, onRejoin, onRemember, onRoomGone }: SessionProps): ReactNode {
	const snap = useGuestSnapshot(client);
	const [railOpen, setRailOpen] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const autoOpenedRef = useRef(false);

	const subCount = useMemo(() => snap.agents.filter(a => a.kind === "sub").length, [snap.agents]);

	// Task-card agent chips drill into the same drawer the rail uses.
	const agentIds = useMemo(() => new Set(snap.agents.map(a => a.id)), [snap.agents]);
	const toolHost = useMemo<ToolRenderHost>(
		() => ({
			hasAgent: id => agentIds.has(id),
			openAgent: id => {
				if (agentIds.has(id)) setSelectedId(id);
			},
		}),
		[agentIds],
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

	return (
		<div className="sh-app">
			<div className="sh-ambient" />
			<HeaderBar
				header={snap.header}
				state={snap.state}
				phase={snap.phase}
				readOnly={snap.readOnly}
				subCount={subCount}
				railOpen={railOpen}
				onToggleRail={toggleRail}
				onLeave={onLeave}
			/>
			<main className="sh-main">
				<section className="sh-panel" data-rail={railOpen ? "true" : "false"}>
					<div className="sh-transcript">
						<Transcript
							entries={snap.entries}
							stream={snap.stream}
							streamDone={snap.streamDone}
							activeTools={snap.activeTools}
							working={snap.working}
							host={toolHost}
							phase={snap.phase}
						/>
					</div>
					<Composer
						client={client}
						phase={snap.phase}
						readOnly={snap.readOnly}
						uiRequest={snap.uiRequest}
						working={snap.working}
						queuedMessageCount={snap.state?.queuedMessageCount ?? 0}
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
		</div>
	);
}
