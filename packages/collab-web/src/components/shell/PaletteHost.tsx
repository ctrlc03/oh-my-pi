import type { CollabCommand, SessionCommand, SessionEntry, WireModel } from "@oh-my-pi/pi-wire";
import {
	Activity,
	Brain,
	CalendarClock,
	Copy,
	Cpu,
	Download,
	FileDiff,
	Images,
	Inbox,
	Info,
	Keyboard,
	LogOut,
	type LucideIcon,
	Monitor,
	MessageSquare,
	Moon,
	PanelLeft,
	PanelRight,
	Plus,
	Redo2,
	Rows3,
	Search,
	SquareCode,
	SquareTerminal,
	Smartphone,
	Sun,
	TextCursorInput,
	Undo2,
	Waypoints,
	ChartColumn,
	Eye,
	GitPullRequest,
	LayoutList,
	Play,
	ChevronsRight,
	ChevronsLeft,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";
import { exportFilename } from "../../lib/export";
import { type PaletteEntry, usePaletteEntries, usePaletteOpen } from "../../lib/palette";
import type { RecentRoom } from "../../lib/rooms";
import { setThemePreference, type ThemePreference, useThemePreference } from "../../lib/theme";
import type { CompanionHandle } from "../../lib/use-companion";
import { usableCommands } from "../../lib/slash-menu";
import { CommandPalette } from "./CommandPalette";
import { DevicesSheet } from "./DevicesSheet";
import { DiagnosticsSheet } from "./DiagnosticsSheet";
import { InboxSheet } from "./InboxSheet";
import { SchedulesSheet } from "./SchedulesSheet";
import { StartSessionSheet } from "./StartSessionSheet";
import type { TurnUndoControl } from "./TurnUndo";

/** What the palette can do beyond the sheets it opens itself; null where the app does not offer it. */
export interface PaletteActions {
	openSessionSheet(): void;
	openFind(): void;
	chat: boolean;
	onChatChange(chat: boolean): void;
	/** Null when there is no other session to list. */
	toggleSidebar: (() => void) | null;
	sidebarOpen: boolean;
	toggleRail(): void;
	railOpen: boolean;
	focusComposer(): void;
	/** Open the previous / next session in the recent list; null when there is no other. */
	adjacentSession: ((delta: -1 | 1) => void) | null;
	/** Null when there is neither a changed file nor a working tree to show. */
	openChanges: (() => void) | null;
	openScreens(): void;
	openShortcuts(): void;
	openUsage: (() => void) | null;
	openSessions: (() => void) | null;
	openCodemap: (() => void) | null;
	openPane: (() => void) | null;
	openPreview: (() => void) | null;
	openGithub: (() => void) | null;
	openRun: (() => void) | null;
	openEditor: (() => void) | null;
	/** Undo and redo of the last turn; undefined unless the app offers them. */
	turnUndo: TurnUndoControl | undefined;
	onLeave(): void;
}

/** The session's model and thinking controls; null unless this writer may switch them. */
export interface PaletteSessionControl {
	models: readonly WireModel[];
	modelId: string | undefined;
	thinkingLevels: readonly string[];
	thinkingLevel: string | undefined;
	send(cmd: SessionCommand, arg?: string): void;
}

export interface PaletteHostProps {
	actions: PaletteActions;
	control: PaletteSessionControl | null;
	/** The session's name, for the exported file. */
	title: string;
	/** The session as Markdown, built on demand from every entry. */
	exportMarkdown(title: string): string;
	commands: readonly CollabCommand[];
	/** A paired computer can follow this session to its next room, so commands that replace the session are offered. */
	followsRoom: boolean;
	entries: readonly SessionEntry[];
	sessionId: string | null;
	companion: CompanionHandle | null;
	rooms: readonly RecentRoom[];
	currentRoomId: string | null;
	/** Put text in the message box (nothing is sent). */
	insertDraft(text: string): void;
	onOpenHost(instanceId: string): Promise<void>;
	onOpenLink(link: string): void;
	onOpenAllSessions(initial: { mode: "sessions" | "messages"; query: string }): void;
}

type CompanionTool = "start" | "inbox" | "schedules" | "diagnostics" | "devices";

const THEMES: readonly { value: ThemePreference; label: string; Icon: LucideIcon }[] = [
	{ value: "system", label: "Follow the system theme", Icon: Monitor },
	{ value: "light", label: "Use the light theme", Icon: Sun },
	{ value: "dark", label: "Use the dark theme", Icon: Moon },
];

function download(filename: string, text: string): void {
	const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	link.click();
	URL.revokeObjectURL(url);
}

/**
 * Registers the app's own actions with the palette, owns the paired-computer sheets that only the sessions
 * sidebar used to open (so the palette reaches them with the sidebar closed), and shows the palette while it is open.
 */
export function PaletteHost(props: PaletteHostProps): ReactNode {
	const { actions, control, title, exportMarkdown, companion, commands, followsRoom, insertDraft } = props;
	const open = usePaletteOpen();
	const { preference } = useThemePreference();
	const [tool, setTool] = useState<CompanionTool | null>(null);
	const closeTool = useCallback(() => setTool(null), []);

	const snap = companion?.snap;
	const toolClient = snap?.phase === "live" ? (companion?.client ?? null) : null;

	const entries = useMemo<PaletteEntry[]>(() => {
		const list: PaletteEntry[] = [
			{
				id: "app:session",
				title: "Session details",
				section: "Session",
				keywords: ["rename", "context", "people", "model"],
				icon: Info,
				shortcut: "sessionSheet",
				run: actions.openSessionSheet,
			},
			{
				id: "app:find",
				title: "Find in the session",
				section: "Session",
				keywords: ["search"],
				icon: Search,
				shortcut: "find",
				run: actions.openFind,
			},
			{
				id: "app:composer",
				title: "Focus the message box",
				section: "Session",
				keywords: ["type", "write", "prompt"],
				icon: TextCursorInput,
				shortcut: "focusComposer",
				run: actions.focusComposer,
			},
			{
				id: "app:chat",
				title: actions.chat ? "Show the full transcript" : "Show the chat view",
				section: "View",
				keywords: ["tools", "fold", "chat", "full"],
				icon: actions.chat ? Rows3 : MessageSquare,
				shortcut: "toggleChat",
				run: () => actions.onChatChange(!actions.chat),
			},
			{
				id: "app:rail",
				title: actions.railOpen ? "Hide the agents panel" : "Show the agents panel",
				section: "View",
				keywords: ["subagents", "tasks"],
				icon: PanelRight,
				run: actions.toggleRail,
			},
			{
				id: "app:screens",
				title: "Images from tools",
				section: "View",
				keywords: ["screenshots", "gallery"],
				icon: Images,
				run: actions.openScreens,
			},
			{
				id: "app:shortcuts",
				title: "Keyboard shortcuts and remapping",
				section: "Help",
				keywords: ["keys", "keybindings", "gestures"],
				icon: Keyboard,
				shortcut: "help",
				run: actions.openShortcuts,
			},
			{
				id: "app:export-copy",
				title: "Copy the session as Markdown",
				section: "Session",
				keywords: ["export", "clipboard"],
				icon: Copy,
				run: () => void navigator.clipboard.writeText(exportMarkdown(title)).catch(() => undefined),
			},
			{
				id: "app:export-download",
				title: "Download the session as Markdown",
				section: "Session",
				keywords: ["export", "save", "file"],
				icon: Download,
				run: () => download(exportFilename(title), exportMarkdown(title)),
			},
			{
				id: "app:leave",
				title: "Leave the session",
				section: "Session",
				keywords: ["close", "disconnect", "exit"],
				icon: LogOut,
				run: actions.onLeave,
			},
		];
		if (actions.toggleSidebar !== null) {
			list.push({
				id: "app:sidebar",
				title: actions.sidebarOpen ? "Hide the sessions sidebar" : "Show the sessions sidebar",
				section: "View",
				keywords: ["switch", "list"],
				icon: PanelLeft,
				shortcut: "sidebar",
				run: actions.toggleSidebar,
			});
		}
		const { adjacentSession } = actions;
		if (adjacentSession !== null) {
			list.push(
				{
					id: "app:session-prev",
					title: "Previous session in the recent list",
					section: "Session",
					icon: ChevronsLeft,
					shortcut: "prevSession",
					run: () => adjacentSession(-1),
				},
				{
					id: "app:session-next",
					title: "Next session in the recent list",
					section: "Session",
					icon: ChevronsRight,
					shortcut: "nextSession",
					run: () => adjacentSession(1),
				},
			);
		}
		const sheets: [string, string, string, string[], LucideIcon, (() => void) | null][] = [
			[
				"app:changes",
				"Changed files and working tree",
				"Review",
				["diff", "git", "files"],
				FileDiff,
				actions.openChanges,
			],
			["app:editor", "Browse and edit files", "Computer", ["editor", "code"], SquareCode, actions.openEditor],
			[
				"app:codemap",
				"Code map of the repository",
				"Computer",
				["browse", "symbols"],
				Waypoints,
				actions.openCodemap,
			],
			["app:pane", "Watch the terminal", "Computer", ["tmux", "screen", "pane"], SquareTerminal, actions.openPane],
			["app:preview", "Preview the running app", "Computer", ["screenshot", "dev server"], Eye, actions.openPreview],
			[
				"app:run",
				"Scripts and build targets",
				"Computer",
				["run", "test", "build", "package.json"],
				Play,
				actions.openRun,
			],
			[
				"app:github",
				"GitHub issues and pull requests",
				"Computer",
				["gh", "pr", "review"],
				GitPullRequest,
				actions.openGithub,
			],
			[
				"app:usage",
				"Usage: spend and tokens",
				"Computer",
				["cost", "money", "budget"],
				ChartColumn,
				actions.openUsage,
			],
			[
				"app:sessions",
				"All sessions across projects",
				"Computer",
				["history", "resume", "search"],
				LayoutList,
				actions.openSessions,
			],
		];
		for (const [id, name, section, keywords, icon, run] of sheets) {
			if (run !== null) list.push({ id, title: name, section, keywords, icon, run });
		}
		const { turnUndo } = actions;
		if (turnUndo !== undefined) {
			if (turnUndo.canUndo)
				list.push({
					id: "app:undo",
					title: "Undo the last turn",
					section: "Session",
					keywords: ["rewind", "revert"],
					icon: Undo2,
					run: turnUndo.onUndo,
				});
			if (turnUndo.canRedo)
				list.push({
					id: "app:redo",
					title: "Redo the undone turn",
					section: "Session",
					icon: Redo2,
					run: turnUndo.onRedo,
				});
		}
		for (const theme of THEMES) {
			if (theme.value === preference) continue;
			list.push({
				id: `app:theme-${theme.value}`,
				title: theme.label,
				section: "Appearance",
				keywords: ["theme", "dark", "light", "mode"],
				icon: theme.Icon,
				run: () => setThemePreference(theme.value),
			});
		}
		if (toolClient !== null && snap !== undefined) {
			if (snap.canStart)
				list.push({
					id: "app:start",
					title: "Start a session",
					section: "Computer",
					keywords: ["new", "resume", "folder"],
					icon: Plus,
					run: () => setTool("start"),
				});
			list.push(
				{
					id: "app:inbox",
					title: "Inbox: sessions waiting for you",
					section: "Computer",
					keywords: ["input", "waiting", "notifications"],
					icon: Inbox,
					run: () => setTool("inbox"),
				},
				{
					id: "app:diagnostics",
					title: "Diagnostics of the paired computer",
					section: "Computer",
					keywords: ["health", "status", "logs"],
					icon: Activity,
					run: () => setTool("diagnostics"),
				},
				{
					id: "app:devices",
					title: "Paired devices",
					section: "Computer",
					keywords: ["phone", "unpair", "pairing"],
					icon: Smartphone,
					run: () => setTool("devices"),
				},
			);
			if (snap.canSchedule)
				list.push({
					id: "app:schedules",
					title: "Scheduled runs",
					section: "Computer",
					keywords: ["cron", "timer", "later"],
					icon: CalendarClock,
					run: () => setTool("schedules"),
				});
		}
		if (control !== null) {
			for (const model of control.models) {
				if (model.id === control.modelId) continue;
				list.push({
					id: `app:model:${model.provider}/${model.id}`,
					title: `Switch the model to ${model.name}`,
					section: "Model",
					keywords: [model.provider, model.id],
					icon: Cpu,
					searchOnly: true,
					run: () => control.send("model", `${model.provider}/${model.id}`),
				});
			}
			for (const level of control.thinkingLevels) {
				if (level === control.thinkingLevel) continue;
				list.push({
					id: `app:thinking:${level}`,
					title: `Set thinking to ${level}`,
					section: "Model",
					keywords: ["effort", "reasoning"],
					icon: Brain,
					searchOnly: true,
					run: () => control.send("thinking", level),
				});
			}
		}
		return list;
	}, [actions, control, exportMarkdown, preference, snap, title, toolClient]);
	usePaletteEntries(entries);

	const usable = useMemo(() => usableCommands(commands, followsRoom), [commands, followsRoom]);

	return (
		<>
			{open !== null && (
				<CommandPalette
					initial={open}
					commands={usable}
					entries={props.entries}
					sessionId={props.sessionId}
					companion={companion}
					rooms={props.rooms}
					currentRoomId={props.currentRoomId}
					onCommand={insertDraft}
					onOpenHost={props.onOpenHost}
					onOpenLink={props.onOpenLink}
					onOpenAllSessions={props.onOpenAllSessions}
				/>
			)}
			{tool === "start" && toolClient !== null && snap !== undefined && (
				<StartSessionSheet
					client={toolClient}
					canSandbox={snap.canSandbox}
					canFanout={snap.canFanout}
					onOpen={props.onOpenHost}
					onClose={closeTool}
				/>
			)}
			{tool === "inbox" && toolClient !== null && (
				<InboxSheet client={toolClient} onOpenHost={props.onOpenHost} onClose={closeTool} />
			)}
			{tool === "schedules" && toolClient !== null && snap !== undefined && (
				<SchedulesSheet
					client={toolClient}
					canSandbox={snap.canSandbox}
					canCron={snap.canScheduleCron}
					onOpenHost={props.onOpenHost}
					onClose={closeTool}
				/>
			)}
			{tool === "diagnostics" && toolClient !== null && <DiagnosticsSheet client={toolClient} onClose={closeTool} />}
			{tool === "devices" && toolClient !== null && <DevicesSheet client={toolClient} onClose={closeTool} />}
		</>
	);
}
