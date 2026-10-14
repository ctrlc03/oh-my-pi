import type { LucideIcon } from "lucide-react";
import {
	Activity,
	Boxes,
	ChartColumn,
	Eye,
	FileDiff,
	GitCompare,
	GitPullRequest,
	GraduationCap,
	LayoutList,
	LogOut,
	PanelRight,
	Play,
	Search,
	Settings,
	SquareCode,
	SquareTerminal,
	Waypoints,
} from "lucide-react";
import type { TopBarId } from "../../lib/top-bar";

/** The icon of each optional top-bar button (the command palette's, where it has one): the bar draws it and Settings → Appearance lists it. */
export const TOP_BAR_ICONS: Record<TopBarId, LucideIcon> = {
	settings: Settings,
	find: Search,
	editor: SquareCode,
	codemap: Waypoints,
	quizzes: GraduationCap,
	github: GitPullRequest,
	agents: PanelRight,
	leave: LogOut,
	changes: FileDiff,
	architecture: Boxes,
	mapchanges: GitCompare,
	terminal: SquareTerminal,
	preview: Eye,
	run: Play,
	timeline: Activity,
	usage: ChartColumn,
	sessions: LayoutList,
};
