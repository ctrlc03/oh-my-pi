import { describe, expect, it } from "bun:test";
import {
	activate,
	activeOf,
	besideOf,
	canBeside,
	effectivePlacement,
	emptyWorkspace,
	mountPane,
	type PaneEntry,
	type PaneKind,
	type PlacementEnv,
	type Placements,
	parsePlacements,
	placementOf,
	placePane,
	setEnv,
	tabKeyTarget,
	tabsOf,
	tabTitle,
	unmountPane,
	type WorkspaceState,
} from "../src/lib/workspace";

/** A wide desktop window with the main area on screen and no second session. */
const DESKTOP: PlacementEnv = { hosted: true, placeable: true, split: true, besideSession: false, twoPanes: false };

function entry(kind: PaneKind): PaneEntry {
	return { kind, label: kind, close: () => {} };
}

function open(state: WorkspaceState, ...kinds: PaneKind[]): WorkspaceState {
	return kinds.reduce((next, kind) => mountPane(next, entry(kind)), state);
}

function desktop(placements: Placements = {}): WorkspaceState {
	return emptyWorkspace(placements, DESKTOP);
}

const tabKinds = (state: WorkspaceState): PaneKind[] => tabsOf(state).map(tab => tab.kind);

describe("parsePlacements", () => {
	it("keeps known kinds with a known placement", () => {
		expect(parsePlacements({ editor: "tab", codemap: "beside" })).toEqual({ editor: "tab", codemap: "beside" });
	});

	it("drops entries that are not a kind, or not a placement", () => {
		expect(parsePlacements({ editor: "docked", bogus: "tab", codemap: 3, quiz: null, github: "tab" })).toEqual({
			github: "tab",
		});
	});

	it("drops float, the default", () => {
		expect(parsePlacements({ editor: "float", quiz: "tab" })).toEqual({ quiz: "tab" });
	});

	it("takes anything that is not a record as no choices", () => {
		for (const raw of [null, undefined, "tab", 7, true, ["tab"]]) expect(parsePlacements(raw)).toEqual({});
	});
});

describe("effectivePlacement", () => {
	it("floats where panes cannot be placed: phones and touch screens", () => {
		const phone = { ...DESKTOP, placeable: false };
		for (const chosen of ["float", "tab", "beside"] as const) {
			expect(effectivePlacement(chosen, phone, true)).toBe("float");
		}
	});

	it("floats outside the main area", () => {
		expect(effectivePlacement("tab", { ...DESKTOP, hosted: false }, true)).toBe("float");
	});

	it("keeps a tab a tab and a float a float", () => {
		expect(effectivePlacement("tab", DESKTOP, false)).toBe("tab");
		expect(effectivePlacement("float", DESKTOP, true)).toBe("float");
	});

	it("goes beside only with room for the side pane", () => {
		expect(effectivePlacement("beside", DESKTOP, true)).toBe("beside");
		expect(effectivePlacement("beside", { ...DESKTOP, split: false }, true)).toBe("tab");
	});

	it("leaves the side to the second session unless the screen has room for both", () => {
		const withSession = { ...DESKTOP, besideSession: true };
		expect(canBeside(withSession)).toBe(false);
		expect(effectivePlacement("beside", withSession, true)).toBe("tab");
		expect(effectivePlacement("beside", { ...withSession, twoPanes: true }, true)).toBe("beside");
	});

	it("shows a pane that does not hold the side pane as a tab", () => {
		expect(effectivePlacement("beside", DESKTOP, false)).toBe("tab");
	});
});

describe("the side pane", () => {
	it("is held by one pane: the later one takes it, the earlier shows as a tab", () => {
		const state = open(desktop({ editor: "beside", codemap: "beside" }), "editor", "codemap");
		expect(placementOf(state, "codemap")).toBe("beside");
		expect(placementOf(state, "editor")).toBe("tab");
		expect(besideOf(state)?.kind).toBe("codemap");
	});

	it("keeps the choice of the pane that lost it", () => {
		const state = open(desktop({ editor: "beside" }), "editor");
		const moved = placePane(state, "codemap", "beside");
		expect(moved.placements.editor).toBe("beside");
		expect(moved.beside).toBe("codemap");
	});

	it("takes the side pane when a pane is placed beside", () => {
		let state = open(desktop(), "editor", "codemap");
		state = placePane(state, "editor", "beside");
		state = placePane(state, "codemap", "beside");
		expect(besideOf(state)?.kind).toBe("codemap");
		expect(tabKinds(state)).toEqual(["editor"]);
		// The first one is a tab for this page life: it does not take the side pane back when the second leaves.
		state = unmountPane(state, "codemap");
		expect(besideOf(state)).toBeNull();
		expect(tabKinds(state)).toEqual(["editor"]);
	});

	it("is given up when the pane goes elsewhere", () => {
		let state = open(desktop({ editor: "beside" }), "editor");
		state = placePane(state, "editor", "tab");
		expect(state.beside).toBeNull();
		expect(besideOf(state)).toBeNull();
		expect(tabKinds(state)).toEqual(["editor"]);
	});

	it("is a tab where there is no room, and beside again when there is", () => {
		const narrow = { ...DESKTOP, split: false };
		let state = open(emptyWorkspace({ editor: "beside" }, narrow), "editor");
		expect(placementOf(state, "editor")).toBe("tab");
		state = setEnv(state, DESKTOP);
		expect(placementOf(state, "editor")).toBe("beside");
	});
});

describe("tabs", () => {
	it("opens a tab last and brings it forward", () => {
		const state = open(desktop({ editor: "tab", codemap: "tab" }), "editor", "codemap");
		expect(tabKinds(state)).toEqual(["editor", "codemap"]);
		expect(activeOf(state)).toBe("codemap");
	});

	it("leaves the front alone for a pane that floats", () => {
		const state = open(desktop({ editor: "tab" }), "editor", "codemap");
		expect(tabKinds(state)).toEqual(["editor"]);
		expect(activeOf(state)).toBe("editor");
	});

	it("brings an open pane forward when it is opened again, keeping its place", () => {
		let state = open(desktop({ editor: "tab", codemap: "tab" }), "editor", "codemap");
		state = activate(state, "editor");
		state = mountPane(state, { kind: "editor", label: "the editor", close: () => {} });
		expect(tabKinds(state)).toEqual(["editor", "codemap"]);
		expect(activeOf(state)).toBe("editor");
		expect(state.entries[0]?.label).toBe("the editor");
	});

	it("gives the front to the tab on the left when the one in front closes", () => {
		let state = open(desktop({ editor: "tab", codemap: "tab", quiz: "tab" }), "editor", "codemap", "quiz");
		state = activate(state, "codemap");
		state = unmountPane(state, "codemap");
		expect(activeOf(state)).toBe("editor");
		expect(tabKinds(state)).toEqual(["editor", "quiz"]);
	});

	it("falls back to the conversation when the first tab closes", () => {
		let state = open(desktop({ editor: "tab", codemap: "tab" }), "editor", "codemap");
		state = activate(state, "editor");
		state = unmountPane(state, "editor");
		expect(activeOf(state)).toBe("conversation");
		expect(tabKinds(state)).toEqual(["codemap"]);
	});

	it("keeps the front when another tab closes", () => {
		let state = open(desktop({ editor: "tab", codemap: "tab" }), "editor", "codemap");
		state = unmountPane(state, "editor");
		expect(activeOf(state)).toBe("codemap");
	});

	it("ignores closing a pane that is not open", () => {
		const state = open(desktop({ editor: "tab" }), "editor");
		expect(unmountPane(state, "codemap")).toBe(state);
	});

	it("brings a tab forward by hand, the conversation too; a pane that is not a tab is ignored", () => {
		let state = open(desktop({ editor: "tab" }), "editor", "codemap");
		state = activate(state, "conversation");
		expect(activeOf(state)).toBe("conversation");
		expect(activate(state, "codemap")).toBe(state);
		expect(activeOf(activate(state, "editor"))).toBe("editor");
	});

	it("moves a pane to a tab, bringing it forward", () => {
		let state = open(desktop(), "editor", "codemap");
		expect(tabKinds(state)).toEqual([]);
		state = placePane(state, "codemap", "tab");
		expect(tabKinds(state)).toEqual(["codemap"]);
		expect(activeOf(state)).toBe("codemap");
		expect(state.placements).toEqual({ codemap: "tab" });
	});

	it("moves the front tab away: the tab on its left comes forward", () => {
		let state = open(desktop({ editor: "tab", codemap: "tab" }), "editor", "codemap");
		state = placePane(state, "codemap", "float");
		expect(tabKinds(state)).toEqual(["editor"]);
		expect(activeOf(state)).toBe("editor");
		expect(state.placements).toEqual({ editor: "tab" });
		state = placePane(state, "editor", "beside");
		expect(activeOf(state)).toBe("conversation");
	});

	it("remembers the choice of a pane that is not open", () => {
		const state = placePane(desktop(), "quiz", "tab");
		expect(state.placements).toEqual({ quiz: "tab" });
		expect(state.entries).toEqual([]);
		expect(activeOf(open(state, "quiz"))).toBe("quiz");
	});

	it("shows no tabs on a phone, and the tabs are back with the room", () => {
		let state = open(desktop({ editor: "tab" }), "editor");
		state = setEnv(state, { ...DESKTOP, placeable: false });
		expect(tabKinds(state)).toEqual([]);
		expect(activeOf(state)).toBe("conversation");
		state = setEnv(state, DESKTOP);
		expect(tabKinds(state)).toEqual(["editor"]);
		expect(activeOf(state)).toBe("editor");
	});

	it("brings the last tab forward when the main area appears over panes that were open", () => {
		let state = open(emptyWorkspace({ editor: "tab", codemap: "tab" }), "editor", "codemap");
		expect(tabKinds(state)).toEqual([]);
		state = setEnv(state, DESKTOP);
		expect(tabKinds(state)).toEqual(["editor", "codemap"]);
		expect(activeOf(state)).toBe("codemap");
	});
});

describe("tabKeyTarget", () => {
	it("moves with the arrows and wraps", () => {
		expect(tabKeyTarget("ArrowRight", 0, 3)).toBe(1);
		expect(tabKeyTarget("ArrowRight", 2, 3)).toBe(0);
		expect(tabKeyTarget("ArrowLeft", 0, 3)).toBe(2);
		expect(tabKeyTarget("ArrowLeft", 2, 3)).toBe(1);
	});

	it("jumps with Home and End and ignores other keys", () => {
		expect(tabKeyTarget("Home", 2, 3)).toBe(0);
		expect(tabKeyTarget("End", 0, 3)).toBe(2);
		expect(tabKeyTarget("a", 0, 3)).toBeNull();
		expect(tabKeyTarget("ArrowRight", 0, 0)).toBeNull();
	});
});

describe("tabTitle", () => {
	it("capitalises the sheet's label", () => {
		expect(tabTitle("code map")).toBe("Code map");
		expect(tabTitle("Settings")).toBe("Settings");
		expect(tabTitle("")).toBe("");
	});
});
