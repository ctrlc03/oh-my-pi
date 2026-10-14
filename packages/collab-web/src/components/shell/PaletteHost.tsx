import type { CollabCommand, SessionCommand, SessionEntry, WireModel } from "@oh-my-pi/pi-wire";
import {
	Activity,
	Bot,
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
	Boxes,
	GitCompare,
	GraduationCap,
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
import { type ComputerHandle, unavailableReason } from "../../lib/computers";
import { usableCommands } from "../../lib/slash-menu";
import { CommandPalette } from "./CommandPalette";
import { AgentsSheet } from "./AgentsSheet";
import { openSettings } from "../../lib/settings-ui";
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
	openArchitecture: (() => void) | null;
	mapChanges: (() => void) | null;
	quizChanges: (() => void) | null;
	openQuizzes: (() => void) | null;
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
	/** Every paired computer: sessions, search and the computer tools span all of them. */
	computers: readonly ComputerHandle[];
	/** The computer of the session on screen; null when none is open. */
	currentComputerId: string | null;
	rooms: readonly RecentRoom[];
	currentRoomId: string | null;
	/** Put text in the message box (nothing is sent). */
	insertDraft(text: string): void;
	onOpenHost(computerId: string, instanceId: string): Promise<void>;
	onOpenLink(link: string): void;
	onOpenAllSessions(initial: { mode: "sessions" | "messages"; query: string }): void;
}

type CompanionTool = "start" | "inbox" | "schedules" | "agents";

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
	const { actions, control, title, exportMarkdown, computers, currentComputerId, commands, followsRoom, insertDraft } =
		props;
	const open = usePaletteOpen();
	const { preference } = useThemePreference();
	const [tool, setTool] = useState<CompanionTool | null>(null);
	const closeTool = useCallback(() => setTool(null), []);

	// What the computer entries depend on, as booleans: a snapshot change that flips none of them leaves the list alone.
	const anyLive = computers.some(computer => computer.snap.phase === "live");
	const canStart = computers.some(computer => unavailableReason(computer, "start") === null);
	const canSchedule = computers.some(computer => unavailableReason(computer, "schedule") === null);
	const canForeign = computers.some(computer => unavailableReason(computer, "foreign") === null);

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
			[
				"app:architecture",
				"Architecture map",
				"Computer",
				["diagram", "system", "design", "overview"],
				Boxes,
				actions.openArchitecture,
			],
			[
				"app:architecture-changes",
				"Map this session's changes",
				"Review",
				["diagram", "diff", "architecture", "what changed"],
				GitCompare,
				actions.mapChanges,
			],
			[
				"app:quiz-changes",
				"Quiz me on this session's changes",
				"Review",
				["quiz", "test", "understand", "questions", "learn", "what changed"],
				GraduationCap,
				actions.quizChanges,
			],
			[
				"app:quizzes",
				"Quizzes of this repository",
				"Review",
				["quiz", "test", "understand", "questions", "learn"],
				GraduationCap,
				actions.openQuizzes,
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
		if (anyLive) {
			if (canStart)
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
					run: () => openSettings("about"),
				},
				{
					id: "app:devices",
					title: "Paired devices",
					section: "Computer",
					keywords: ["phone", "unpair", "pairing"],
					icon: Smartphone,
					run: () => openSettings("devices"),
				},
			);
			if (canSchedule)
				list.push({
					id: "app:schedules",
					title: "Scheduled runs",
					section: "Computer",
					keywords: ["cron", "timer", "later"],
					icon: CalendarClock,
					run: () => setTool("schedules"),
				});
			if (canForeign)
				list.push({
					id: "app:agents",
					title: "Agents: Claude Code, Codex, Cursor and more",
					section: "Computer",
					keywords: ["claude", "codex", "cursor", "grok", "opencode", "acp", "vendor", "install", "login"],
					icon: Bot,
					run: () => setTool("agents"),
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
	}, [actions, control, exportMarkdown, preference, anyLive, canStart, canSchedule, canForeign, title]);
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
					computers={computers}
					currentComputerId={currentComputerId}
					rooms={props.rooms}
					currentRoomId={props.currentRoomId}
					onCommand={insertDraft}
					onOpenHost={props.onOpenHost}
					onOpenLink={props.onOpenLink}
					onOpenAllSessions={props.onOpenAllSessions}
				/>
			)}
			{tool === "start" && (
				<StartSessionSheet
					computers={computers}
					currentComputerId={currentComputerId}
					onOpen={props.onOpenHost}
					onClose={closeTool}
				/>
			)}
			{tool === "inbox" && <InboxSheet computers={computers} onOpenHost={props.onOpenHost} onClose={closeTool} />}
			{tool === "schedules" && (
				<SchedulesSheet computers={computers} onOpenHost={props.onOpenHost} onClose={closeTool} />
			)}
			{tool === "agents" && <AgentsSheet computers={computers} onClose={closeTool} />}
		</>
	);
}
