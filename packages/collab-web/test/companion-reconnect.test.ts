import { afterEach, describe, expect, it } from "bun:test";
import {
	OPEN_CONFIRM_MS,
	RECLAIM_WINDOW_MS,
	RECONNECT_MAX_MS,
	RECONNECT_MS,
	ReconnectPlan,
	RoomReconnector,
} from "../scripts/companion-reconnect";
import { RoomHost, type RoomRoute } from "../scripts/companion-room";
import { startLocalRelay } from "../scripts/local-relay";
import { generateRoomKey, importRoomKey } from "../src/lib/codec";
import { HOST_TAKEN_REASON } from "../src/lib/socket";

function plan(): { plan: ReconnectPlan; advance(ms: number): void } {
	let clock = 1_000_000;
	return { plan: new ReconnectPlan(() => clock), advance: ms => (clock += ms) };
}

describe("reconnecting after the relay closed the companion's room for good", () => {
	it("waits the same beat after any other close, and says nothing extra", () => {
		const { plan: p } = plan();
		for (let i = 0; i < 4; i++) {
			expect(p.closed("room closed")).toEqual({ delayMs: RECONNECT_MS, quiet: false, summary: [] });
		}
	});

	it("doubles the delay while another host holds the room, up to the cap", () => {
		const { plan: p } = plan();
		const delays = Array.from({ length: 10 }, () => p.closed(HOST_TAKEN_REASON).delayMs);
		expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000, 300_000]);
		expect(RECONNECT_MAX_MS).toBe(300_000);
	});

	it("reports the first close of a streak and stays quiet for the repeats", () => {
		const { plan: p } = plan();
		expect(p.closed(HOST_TAKEN_REASON).quiet).toBe(false);
		expect(p.closed(HOST_TAKEN_REASON).quiet).toBe(true);
		expect(p.closed(HOST_TAKEN_REASON).quiet).toBe(true);
	});

	it("sums the streak up when the relay accepts the host, and starts over after it", () => {
		const { plan: p, advance } = plan();
		p.closed(HOST_TAKEN_REASON);
		for (let i = 0; i < 22; i++) {
			advance(30_000);
			p.closed(HOST_TAKEN_REASON);
		}
		advance(30_000);
		expect(p.opened()).toEqual(["room was held by another host for 12m, 23 retries"]);
		expect(p.opened()).toEqual([]);
		expect(p.closed(HOST_TAKEN_REASON)).toEqual({ delayMs: RECONNECT_MS, quiet: false, summary: [] });
	});

	it("counts seconds for a short streak and a single retry in the singular", () => {
		const { plan: p, advance } = plan();
		p.closed(HOST_TAKEN_REASON);
		advance(5_000);
		expect(p.opened()).toEqual(["room was held by another host for 5s, 1 retry"]);
	});

	it("ends the streak with its summary when the relay closes for another reason", () => {
		const { plan: p, advance } = plan();
		p.closed(HOST_TAKEN_REASON);
		advance(5_000);
		p.closed(HOST_TAKEN_REASON);
		advance(10_000);
		expect(p.closed("room is full")).toEqual({
			delayMs: RECONNECT_MS,
			quiet: false,
			summary: ["room was held by another host for 15s, 2 retries"],
		});
		expect(p.closed(HOST_TAKEN_REASON).delayMs).toBe(RECONNECT_MS);
	});
});

describe("the relay still holding this companion's own dead socket", () => {
	it("keeps retrying at the base beat for the reclaim window after its own open, then grows", () => {
		const { plan: p, advance } = plan();
		p.opened();
		advance(30_000);
		p.dropped();
		const delays: number[] = [];
		// A retry every 5 s: the window runs 150 s from the drop.
		for (let elapsed = 0; elapsed < RECLAIM_WINDOW_MS; elapsed += RECONNECT_MS) {
			delays.push(p.closed(HOST_TAKEN_REASON).delayMs);
			advance(RECONNECT_MS);
		}
		expect(delays).toEqual(Array.from({ length: RECLAIM_WINDOW_MS / RECONNECT_MS }, () => RECONNECT_MS));
		expect([1, 2, 3, 4].map(() => p.closed(HOST_TAKEN_REASON).delayMs)).toEqual([5_000, 10_000, 20_000, 40_000]);
	});

	it("grows from the first close when this companion never held the room", () => {
		const { plan: p } = plan();
		expect([1, 2, 3].map(() => p.closed(HOST_TAKEN_REASON).delayMs)).toEqual([5_000, 10_000, 20_000]);
	});
});

describe("a companion's room against a relay another host already holds", () => {
	interface Scheduled {
		fn: () => void;
		ms: number;
		live: boolean;
	}
	const stops: Array<() => void> = [];
	afterEach(() => {
		for (const stop of stops.splice(0)) stop();
	});

	/** A scheduler that runs nothing until the test says so, and a clock the test moves. */
	function fakeTime() {
		const scheduled: Scheduled[] = [];
		let clock = 1_000_000;
		return {
			now: () => clock,
			advance: (ms: number) => (clock += ms),
			schedule: (fn: () => void, ms: number) => {
				const entry: Scheduled = { fn, ms, live: true };
				scheduled.push(entry);
				return () => {
					entry.live = false;
				};
			},
			/** The timer still waiting, with this delay. */
			pending: (ms: number) => scheduled.filter(entry => entry.live && entry.ms === ms),
			/** Drop every timer still waiting. */
			clear() {
				for (const entry of scheduled) entry.live = false;
			},
			fire(entry: Scheduled) {
				entry.live = false;
				entry.fn();
			},
		};
	}

	it("grows the delay and stays quiet through open-then-4009 cycles, and sums them up when the room is won", async () => {
		const relay = startLocalRelay(0);
		stops.push(() => relay.stop());
		const key = importRoomKey(generateRoomKey());
		const url = `${relay.url}/r/BackoffRoom_12345678`;
		const time = fakeTime();

		const holder = new RoomHost<object, object>({ publicUrl: url, key });
		stops.push(() => holder.close());
		await new Promise<void>(resolve => {
			holder.onOpen = () => resolve();
			holder.connect();
		});

		const reports: string[] = [];
		const confirmed: RoomRoute[] = [];
		const reconnector = new RoomReconnector({
			connect: route => challenger.connect(route),
			schedule: time.schedule,
			now: time.now,
			confirmed: route => confirmed.push(route),
			report: (_route, _kind, line) => reports.push(line),
		});
		stops.push(() => reconnector.stop());
		const challenger = new RoomHost<object, object>({ publicUrl: url, key });
		stops.push(() => challenger.close());
		/** The next thing the challenger's socket does, as the reconnector is told it. */
		let next: (what: "open" | "close") => void = () => {};
		challenger.onOpen = route => {
			reconnector.opened(route);
			next("open");
		};
		challenger.onClose = (route, reason, willReconnect) => {
			reconnector.closed(route, reason, willReconnect);
			next("close");
		};
		const step = (): Promise<"open" | "close"> =>
			new Promise(resolve => {
				next = resolve;
			});

		const delays: number[] = [];
		const attempt = async (): Promise<"open" | "close"> => {
			const outcome = step();
			challenger.connect();
			return await outcome;
		};
		for (let cycle = 0; cycle < 4; cycle++) {
			// The relay accepts the socket and only then refuses the host, so an open comes first.
			expect(await attempt()).toBe("open");
			expect(await step()).toBe("close");
			const [retry] = time.pending(RECONNECT_MS * 2 ** cycle);
			expect(retry).toBeDefined();
			delays.push(retry!.ms);
			time.advance(retry!.ms);
			// The close came before the open lasted: it was never confirmed.
			expect(time.pending(OPEN_CONFIRM_MS)).toEqual([]);
			retry!.live = false;
		}
		expect(delays).toEqual([5_000, 10_000, 20_000, 40_000]);
		expect(confirmed).toEqual([]);
		// One line for the whole streak.
		expect(reports).toEqual(["public relay closed (a host is already connected for this room), retrying"]);

		holder.close();
		let won = false;
		while (!won) {
			const opened = await attempt();
			if (opened === "open" && time.pending(OPEN_CONFIRM_MS).length > 0) {
				// It lasted: the relay kept this host.
				time.fire(time.pending(OPEN_CONFIRM_MS)[0]!);
				won = true;
			} else {
				// The relay had not freed the room yet: one more refusal, one more retry.
				time.advance(1_000);
				time.clear();
			}
		}
		expect(confirmed).toEqual(["public"]);
		expect(reports).toHaveLength(2);
		expect(reports[1]).toMatch(/^public relay: room was held by another host for \d+[sm], \d+ retries$/);
	});

	it("keeps the base beat for the reclaim window after its own drop, through the reconnector", () => {
		const time = fakeTime();
		const connects: RoomRoute[] = [];
		const reconnector = new RoomReconnector({
			connect: route => connects.push(route),
			schedule: time.schedule,
			now: time.now,
			confirmed: () => {},
			report: () => {},
		});
		reconnector.opened("public");
		time.fire(time.pending(OPEN_CONFIRM_MS)[0]!);
		time.advance(60_000);
		reconnector.closed("public", "connection lost (code 1006)", true);
		reconnector.closed("public", HOST_TAKEN_REASON, false);
		expect(time.pending(RECONNECT_MS)).toHaveLength(1);
		time.fire(time.pending(RECONNECT_MS)[0]!);
		expect(connects).toEqual(["public"]);
		time.advance(RECLAIM_WINDOW_MS);
		reconnector.closed("public", HOST_TAKEN_REASON, false);
		expect(time.pending(RECONNECT_MS)).toHaveLength(1);
		time.fire(time.pending(RECONNECT_MS)[0]!);
		reconnector.closed("public", HOST_TAKEN_REASON, false);
		expect(time.pending(RECONNECT_MS * 2)).toHaveLength(1);
	});

	it("counts an open as accepted when the relay sends something before the confirm period ends", () => {
		const time = fakeTime();
		const confirmed: RoomRoute[] = [];
		const reconnector = new RoomReconnector({
			connect: () => {},
			schedule: time.schedule,
			now: time.now,
			confirmed: route => confirmed.push(route),
			report: () => {},
		});
		reconnector.opened("local");
		reconnector.activity("local");
		reconnector.activity("local");
		expect(confirmed).toEqual(["local"]);
		expect(time.pending(OPEN_CONFIRM_MS)).toEqual([]);
	});

	it("schedules nothing after stop", () => {
		const time = fakeTime();
		const reconnector = new RoomReconnector({
			connect: () => {},
			schedule: time.schedule,
			now: time.now,
			confirmed: () => {},
			report: () => {},
		});
		reconnector.stop();
		reconnector.closed("public", "closed", false);
		expect(time.pending(RECONNECT_MS)).toEqual([]);
	});
});
