import { Settings } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo } from "react";
import { type PaletteEntry, usePaletteEntries } from "../../lib/palette";
import {
	closeSettings,
	openSettings,
	settingsLabel,
	settingsOpen,
	useSettingsRequest,
	visibleSettingsSections,
} from "../../lib/settings-ui";
import { IS_MAC, shortcutFires } from "../../lib/shortcuts";
import type { SettingsEnv } from "./env";
import { SECTION_ICONS, SettingsSheet } from "./SettingsSheet";

/**
 * Settings, mounted once at the app's top: the sheet while it is open, the shortcut that toggles it, and its palette
 * entries ("Settings", and "Settings: Appearance" and so on for each section the app offers).
 */
export function SettingsHost({ env }: { env: SettingsEnv }): ReactNode {
	const request = useSettingsRequest();
	const computer = env.companion !== null;

	const entries = useMemo<readonly PaletteEntry[]>(
		() => [
			{
				id: "settings:open",
				title: "Settings",
				section: "Settings",
				keywords: ["preferences", "options", "configure"],
				icon: Settings,
				shortcut: "settings",
				run: () => openSettings(),
			},
			...visibleSettingsSections(computer).map((section): PaletteEntry => ({
				id: `settings:${section}`,
				title: `Settings: ${settingsLabel(section)}`,
				section: "Settings",
				keywords: ["preferences", "options"],
				icon: SECTION_ICONS[section],
				run: () => openSettings(section),
			})),
		],
		[computer],
	);
	usePaletteEntries(entries);

	// The key closes Settings when it is open, and opens it unless another sheet has the keyboard.
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.isComposing || e.defaultPrevented) return;
			if (!shortcutFires("settings", e, e.target instanceof HTMLElement ? e.target : null, IS_MAC)) return;
			if (settingsOpen()) {
				e.preventDefault();
				closeSettings();
			} else if (document.querySelector('[role="dialog"]') === null) {
				e.preventDefault();
				openSettings();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	return request === null ? null : (
		<SettingsSheet key={request.id} initial={request.section} env={env} onClose={closeSettings} />
	);
}
