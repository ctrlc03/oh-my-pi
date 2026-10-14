import { describe, expect, it } from "bun:test";
import {
	closeSettings,
	isSettingsSection,
	openSettings,
	SETTINGS_SECTIONS,
	settingsLabel,
	settingsOpen,
	visibleSettingsSections,
} from "../src/lib/settings-ui";
import { matchCombo, SHORTCUTS } from "../src/lib/shortcuts";

describe("settings sections", () => {
	it("lists every section in the order of the sheet", () => {
		expect(SETTINGS_SECTIONS).toEqual([
			"appearance",
			"messages",
			"notifications",
			"sessions",
			"keyboard",
			"computers",
			"devices",
			"about",
		]);
		for (const section of SETTINGS_SECTIONS) expect(settingsLabel(section).length).toBeGreaterThan(0);
	});

	it("hides the computer's sections until a computer is paired", () => {
		expect(visibleSettingsSections(false)).toEqual([
			"appearance",
			"messages",
			"sessions",
			"keyboard",
			"computers",
			"about",
		]);
		expect(visibleSettingsSections(true)).toEqual(SETTINGS_SECTIONS);
	});

	it("recognises section names and nothing inherited", () => {
		expect(isSettingsSection("sessions")).toBe(true);
		expect(isSettingsSection("toString")).toBe(false);
		expect(isSettingsSection(null)).toBe(false);
	});
});

describe("settings request", () => {
	it("opens, and closes", () => {
		expect(settingsOpen()).toBe(false);
		openSettings("sessions");
		expect(settingsOpen()).toBe(true);
		closeSettings();
		expect(settingsOpen()).toBe(false);
	});
});

describe("settings shortcut", () => {
	it("is Command or Control with a comma, typeable in a field", () => {
		const { keys, typing } = SHORTCUTS.settings;
		expect(typing).toBe("allow");
		expect(matchCombo({ key: ",", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, keys, true)).toBe(
			true,
		);
		expect(matchCombo({ key: ",", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false }, keys, false)).toBe(
			true,
		);
		expect(
			matchCombo({ key: ",", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }, keys, false),
		).toBe(false);
	});
});
