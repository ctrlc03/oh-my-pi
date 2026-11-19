import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type CardsFile,
	createSessionCards,
	loadCardsFile,
	MAX_CARDS,
	parseCardsFile,
	saveCardsFile,
	withCard,
} from "../scripts/companion-sessioncards";

const dirs: string[] = [];

async function tempFile(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-cards-"));
	dirs.push(dir);
	return path.join(dir, "cards.json");
}

afterEach(async () => {
	for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

const empty = (): CardsFile => ({ rev: 0, cards: {} });

describe("parseCardsFile", () => {
	it("keeps good cards and drops damaged ones without throwing", () => {
		const file = parseCardsFile({
			rev: 4,
			cards: {
				good: { status: "blocked", note: "waiting", at: 10 },
				noteOnly: { status: null, note: "just a note", at: 11 },
				badStatus: { status: "shipped", note: "", at: 12 },
				noTime: { status: "todo", note: "" },
				empty: { status: null, note: "", at: 13 },
				"../escape": { status: "todo", note: "", at: 14 },
			},
		});
		expect(file.rev).toBe(4);
		expect(Object.keys(file.cards).sort()).toEqual(["good", "noteOnly"]);
	});

	it("starts from nothing for anything that is not a file", () => {
		expect(parseCardsFile(null)).toEqual(empty());
		expect(parseCardsFile("x")).toEqual(empty());
		expect(parseCardsFile({ rev: -2, cards: [] })).toEqual(empty());
	});
});

describe("withCard", () => {
	it("removes the card when it says nothing", () => {
		const cards = withCard({}, "s-1", { status: "todo", note: "" }, 1);
		expect(withCard(cards, "s-1", { status: null, note: "" }, 2)).toEqual({});
	});

	it("keeps the newest cards once past the cap", () => {
		let cards = {};
		for (let n = 0; n <= MAX_CARDS; n++) cards = withCard(cards, `s-${n}`, { status: "todo", note: "" }, n);
		expect(Object.keys(cards)).toHaveLength(MAX_CARDS);
		expect(Object.hasOwn(cards, "s-0")).toBe(false);
		expect(Object.hasOwn(cards, `s-${MAX_CARDS}`)).toBe(true);
	});
});

describe("createSessionCards", () => {
	function store(initial: CardsFile = empty()) {
		const saved: CardsFile[] = [];
		let changes = 0;
		const cards = createSessionCards({
			now: () => 100,
			initial,
			save: async file => {
				saved.push(file);
			},
			onChange: () => {
				changes++;
			},
		});
		return { cards, saved, changes: () => changes };
	}

	it("sets a card, bumps the revision, saves and tells the devices", async () => {
		const { cards, saved, changes } = store();
		await cards.set("s-1", "in-review", "  needs eyes ");
		expect(cards.file().rev).toBe(1);
		expect(saved).toHaveLength(1);
		expect(changes()).toBe(1);
		expect(cards.markRows([{ sessionId: "s-1" }, { sessionId: "s-2" }])).toEqual([
			{ sessionId: "s-1", card: { status: "in-review", note: "needs eyes" } },
			{ sessionId: "s-2" },
		]);
	});

	it("does nothing when the card is already as asked", async () => {
		const { cards, saved, changes } = store();
		await cards.set("s-1", "blocked", "x");
		await cards.set("s-1", "blocked", "x");
		expect(cards.file().rev).toBe(1);
		expect(saved).toHaveLength(1);
		expect(changes()).toBe(1);
	});

	it("clears a card set to no status and no note", async () => {
		const { cards } = store();
		await cards.set("s-1", "done", "");
		await cards.set("s-1", null, "");
		expect(cards.markRows([{ sessionId: "s-1" }])).toEqual([{ sessionId: "s-1" }]);
	});

	it("refuses an id that is not a session id and a status it cannot show, changing nothing", async () => {
		const { cards, saved } = store();
		await expect(cards.set("../x", "todo", "")).rejects.toThrow("invalid session id");
		await expect(cards.set(7, "todo", "")).rejects.toThrow("invalid session id");
		await expect(cards.set("s-1", "shipped", "")).rejects.toThrow("unknown card status");
		expect(cards.file().rev).toBe(0);
		expect(saved).toHaveLength(0);
	});
});

describe("the cards file", () => {
	it("round-trips through disk, private to the user", async () => {
		const file = await tempFile();
		const contents = withCard({}, "s-1", { status: "blocked", note: "waiting" }, 5);
		await saveCardsFile(file, { rev: 3, cards: contents });
		expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
		expect(await loadCardsFile(file)).toEqual({ rev: 3, cards: contents });
	});

	it("is empty when missing or unreadable", async () => {
		const file = await tempFile();
		expect(await loadCardsFile(file)).toEqual(empty());
		await Bun.write(file, "not json");
		expect(await loadCardsFile(file)).toEqual(empty());
	});
});
