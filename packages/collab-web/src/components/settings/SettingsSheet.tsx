import {
	ArrowLeft,
	Bell,
	ChevronRight,
	Info,
	Keyboard,
	Laptop,
	LayoutList,
	type LucideIcon,
	MessageSquare,
	Palette,
	Smartphone,
	X,
} from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { ComputerHandle } from "../../lib/computers";
import {
	lastSettingsSection,
	rememberSettingsSection,
	type SettingsSection,
	settingsLabel,
	visibleSettingsSections,
} from "../../lib/settings-ui";
import { PHONE_QUERY, useMedia } from "../codemap/shared";
import { Sheet } from "../shell/Sheet";
import { ShortcutsPanel } from "../shell/ShortcutsPanel";
import { AboutSection } from "./AboutSection";
import { AppearanceSection } from "./AppearanceSection";
import { ComputersSection } from "./ComputersSection";
import { DevicesSection } from "./DevicesSection";
import type { SettingsEnv } from "./env";
import { MessagesSection } from "./MessagesSection";
import { NotificationsSection } from "./NotificationsSection";
import { SessionsSection } from "./SessionsSection";
import { Where } from "./SettingsRows";
import "./settings.css";

export const SECTION_ICONS: Record<SettingsSection, LucideIcon> = {
	appearance: Palette,
	messages: MessageSquare,
	notifications: Bell,
	sessions: LayoutList,
	keyboard: Keyboard,
	computers: Laptop,
	devices: Smartphone,
	about: Info,
};

/** The first thing to type into or press in a section. */
const FIRST_CONTROL =
	'.sh-set-body :is(input, select, textarea, button, a[href], [tabindex]:not([tabindex="-1"])):not(:disabled)';

function SectionContent({ section, env }: { section: SettingsSection; env: SettingsEnv }): ReactNode {
	switch (section) {
		case "appearance":
			return <AppearanceSection />;
		case "messages":
			return <MessagesSection />;
		case "notifications":
			return <NotificationsSection env={env} />;
		case "sessions":
			return <SessionsSection env={env} />;
		case "keyboard":
			return <ShortcutsPanel />;
		case "computers":
			return <ComputersSection env={env} />;
		case "devices":
			return <DevicesSection env={env} />;
		case "about":
			return <AboutSection env={env} />;
	}
}

export interface SettingsSheetProps {
	/** The section to open on; null: the one left open last, or the first. On a phone a section drills in, none shows the list. */
	initial: SettingsSection | null;
	env: SettingsEnv;
	onClose(): void;
}

/** `names` as a sentence list: "a", "a and b", "a, b and c". */
function joinNames(names: readonly string[]): string {
	const last = names.at(-1);
	if (last === undefined) return "";
	return names.length === 1 ? last : `${names.slice(0, -1).join(", ")} and ${last}`;
}

/**
 * The computer(s) a section keeps its settings on, or null when it keeps them on this device alone. With one
 * computer its machine name; with several the ones that hold the section's settings ("each computer" when all do).
 */
function whereMachine(section: SettingsSection, env: SettingsEnv): string | null {
	const { computers, orgs } = env;
	const named = (computer: ComputerHandle): string =>
		computers.length === 1 ? (computer.snap.machine ?? "your computer") : computer.name;
	let holders: readonly ComputerHandle[];
	if (section === "devices") holders = computers;
	else if (section === "sessions") holders = computers.filter(computer => orgs.of(computer.id).synced);
	else return null;
	if (holders.length === 0) return null;
	if (holders.length === computers.length && computers.length > 1) return "each computer";
	return joinNames(holders.map(named));
}

/**
 * Every setting in one place: a section list on the left and the section on the right, and on a phone the list
 * with each section drilling in behind a back button. Settings kept on this device and settings kept on the paired
 * computer are marked as such in each section.
 */
export function SettingsSheet({ initial, env, onClose }: SettingsSheetProps): ReactNode {
	const phone = useMedia(PHONE_QUERY);
	const sections = visibleSettingsSections(env.computers.length > 0);
	const [selected, setSelected] = useState<SettingsSection>(initial ?? lastSettingsSection() ?? "appearance");
	// A section that went away (the computer was unpaired) gives way to the first.
	const section = sections.includes(selected) ? selected : (sections[0] ?? "appearance");
	/** Phone only: the list, or the section drilled into. A deep link opens the section. */
	const [drilled, setDrilled] = useState(initial !== null);
	const root = useRef<HTMLDivElement>(null);
	/** Where focus goes after the next render: the list, or the section's first control. Bumped by each choice. */
	const [focus, setFocus] = useState<{ token: number; target: "nav" | "main" }>(() => ({
		token: 0,
		target: phone && initial === null ? "nav" : "main",
	}));

	const inList = phone && !drilled;
	useEffect(() => {
		if (!inList) rememberSettingsSection(section);
	}, [section, inList]);

	// Runs once per choice (and on open): the list and the section are read at that moment.
	useEffect(() => {
		const scope = root.current;
		if (scope === null) return;
		const target =
			focus.target === "nav"
				? scope.querySelector<HTMLElement>('.sh-set-list [tabindex="0"]')
				: scope.querySelector<HTMLElement>(FIRST_CONTROL);
		target?.focus({ preventScroll: true });
	}, [focus.token]);

	const choose = (next: SettingsSection): void => {
		setSelected(next);
		setDrilled(true);
		setFocus(f => ({ token: f.token + 1, target: "main" }));
	};

	const back = (): void => {
		setDrilled(false);
		setFocus(f => ({ token: f.token + 1, target: "nav" }));
	};

	/** Arrow keys, Home and End move through the list; on a wide screen the section follows the focus. */
	const onListKey = (e: KeyboardEvent<HTMLUListElement>): void => {
		const last = sections.length - 1;
		const at = sections.indexOf(section);
		let to: number;
		if (e.key === "ArrowDown") to = at === last ? 0 : at + 1;
		else if (e.key === "ArrowUp") to = at === 0 ? last : at - 1;
		else if (e.key === "Home") to = 0;
		else if (e.key === "End") to = last;
		else return;
		e.preventDefault();
		const next = sections[to];
		if (next === undefined) return;
		setSelected(next);
		root.current?.querySelector<HTMLElement>(`.sh-set-list [data-section="${next}"]`)?.focus();
	};

	// Notifications and About mark the location per group: they mix this device and the computers.
	const whereLine =
		section === "notifications" || section === "about" ? null : <Where machine={whereMachine(section, env)} />;

	return (
		<Sheet label="Settings" size="settings" onClose={onClose}>
			<div ref={root} className="sh-set" data-view={inList ? "list" : "section"}>
				<nav className="sh-set-nav" aria-label="Settings sections">
					<div className="sh-set-nav-head">
						<h2 className="sh-sheet-title">Settings</h2>
						<button
							type="button"
							className="sh-btn sh-btn-icon sh-set-close-nav"
							onClick={onClose}
							aria-label="Close settings"
						>
							<X size={16} />
						</button>
					</div>
					<ul className="sh-set-list" onKeyDown={onListKey}>
						{sections.map(id => {
							const Icon = SECTION_ICONS[id];
							return (
								<li key={id}>
									<button
										type="button"
										className={id === section ? "sh-set-item sh-set-item-on" : "sh-set-item"}
										data-section={id}
										tabIndex={id === section ? 0 : -1}
										aria-current={id === section ? "page" : undefined}
										onClick={() => choose(id)}
									>
										<Icon size={16} aria-hidden="true" />
										<span className="sh-set-item-label">{settingsLabel(id)}</span>
										<ChevronRight size={14} className="sh-set-item-go" aria-hidden="true" />
									</button>
								</li>
							);
						})}
					</ul>
				</nav>
				<div className="sh-set-main">
					<header className="sh-set-head">
						<button
							type="button"
							className="sh-btn sh-btn-icon sh-set-back"
							onClick={back}
							aria-label="Back to settings"
						>
							<ArrowLeft size={16} />
						</button>
						<h2 className="sh-sheet-title">{settingsLabel(section)}</h2>
						<button
							type="button"
							className="sh-btn sh-btn-icon sh-set-close-main"
							onClick={onClose}
							aria-label="Close settings"
						>
							<X size={16} />
						</button>
					</header>
					<div className="sh-set-body" key={section}>
						{whereLine}
						<SectionContent section={section} env={env} />
					</div>
				</div>
			</div>
		</Sheet>
	);
}
