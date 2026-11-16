import { describe, expect, it } from "bun:test";
import { parseEnginePref, parseThemePref } from "../src/lib/editor-prefs";
import {
	contrastRatio,
	EDITOR_THEME_GROUPS,
	EDITOR_THEME_IDS,
	EDITOR_THEME_VARS,
	editorThemeScheme,
	editorThemeVars,
} from "../src/lib/editor-themes";

const THEMES = EDITOR_THEME_IDS.filter(id => id !== "app");

describe("editor theme preference", () => {
	it("defaults to matching the app and falls back to it for anything that is not a theme", () => {
		for (const junk of [null, undefined, "nord", 3, [], {}, { theme: "vim" }, { theme: 7 }, { engine: "monaco" }])
			expect(parseThemePref(junk)).toBe("app");
		expect(parseThemePref({ theme: "app" })).toBe("app");
	});

	it("reads every theme, next to the engine", () => {
		for (const id of THEMES) expect(parseThemePref({ engine: "monaco", theme: id })).toBe(id);
		expect(parseEnginePref({ engine: "codemirror", theme: "dracula" })).toBe("codemirror");
	});

	it("keeps values stored before the theme existed, and a junk theme does not hide the engine", () => {
		expect(parseEnginePref({ engine: "monaco" })).toBe("monaco");
		expect(parseThemePref({ engine: "monaco" })).toBe("app");
		expect(parseEnginePref({ engine: "codemirror", theme: "vim" })).toBe("codemirror");
	});
});

describe("editor themes", () => {
	it("lists Match app, then every theme once, light before dark", () => {
		expect(EDITOR_THEME_IDS[0]).toBe("app");
		expect(THEMES.length).toBe(10);
		expect(EDITOR_THEME_GROUPS.map(group => group.label)).toEqual(["Light", "Dark"]);
		expect(EDITOR_THEME_GROUPS.flatMap(group => group.themes.map(theme => theme.id))).toEqual(THEMES);
		expect(editorThemeScheme("app")).toBeNull();
		expect(editorThemeVars("app")).toBeNull();
	});

	for (const id of THEMES) {
		describe(id, () => {
			const vars = editorThemeVars(id)!;

			it("defines every variable, and nothing else", () => {
				expect(Object.keys(vars).sort()).toEqual([...EDITOR_THEME_VARS].sort());
				for (const name of EDITOR_THEME_VARS) expect(vars[name]).toMatch(/\S/);
			});

			it("is light or dark, and its colours agree", () => {
				const scheme = vars["color-scheme"];
				expect(["light", "dark"]).toContain(scheme);
				expect<string | null>(editorThemeScheme(id)).toBe(scheme);
				const bg = vars["--bg-inset"];
				// A dark theme's text is lighter than its editor, a light theme's darker.
				expect(contrastRatio(vars["--fg"], bg)).toBeGreaterThan(1);
				const lighterText = contrastRatio(vars["--fg"], "#000000") > contrastRatio(bg, "#000000");
				expect(lighterText).toBe(scheme === "dark");
			});

			it("keeps text legible on the editor and the sidebar", () => {
				for (const surface of [vars["--bg-inset"], vars["--bg-raised"]]) {
					expect(contrastRatio(vars["--fg"], surface)).toBeGreaterThanOrEqual(4);
					expect(contrastRatio(vars["--fg-muted"], surface)).toBeGreaterThanOrEqual(3);
					expect(contrastRatio(vars["--fg-faint"], surface)).toBeGreaterThanOrEqual(2);
				}
				expect(contrastRatio(vars["--accent-fg"], vars["--accent-strong"])).toBeGreaterThanOrEqual(3.5);
			});

			it("colours code legibly against the editor", () => {
				// The published palettes mute comments on purpose (Solarized's sit near 2.5:1, as do its accents), so they get a lower floor.
				for (const name of EDITOR_THEME_VARS.filter(name => name.startsWith("--syn-"))) {
					const floor = name === "--syn-comment" ? 2.2 : 2.5;
					expect(contrastRatio(vars[name], vars["--bg-inset"])).toBeGreaterThanOrEqual(floor);
				}
			});
		});
	}
});
