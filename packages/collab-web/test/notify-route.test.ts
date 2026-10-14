import { describe, expect, test } from "bun:test";
import { applyBadge, type BadgeTarget } from "../src/lib/badge";
import { emitRoute, parseRoute, subscribeRoute } from "../src/lib/notify-route";

describe("parseRoute", () => {
	test("plain open", () => {
		expect(parseRoute("open:abc123")).toEqual({ kind: "open", instanceId: "abc123", computerId: null, reply: null });
	});

	test("open names the computer the push came from, so equal instance ids on two computers stay apart", () => {
		expect(parseRoute("open:abc123&computer=laptopRoom")).toEqual({
			kind: "open",
			instanceId: "abc123",
			computerId: "laptopRoom",
			reply: null,
		});
		expect(parseRoute("open:abc123&computer=moonstoneRoom")).toEqual({
			kind: "open",
			instanceId: "abc123",
			computerId: "moonstoneRoom",
			reply: null,
		});
	});

	test("open with a reply decodes the text, including characters that would end the route", () => {
		const text = "yes & go #1, 100% sure?";
		expect(parseRoute(`open:abc&computer=room1&reply=${encodeURIComponent(text)}`)).toEqual({
			kind: "open",
			instanceId: "abc",
			computerId: "room1",
			reply: text,
		});
		expect(parseRoute(`open:abc&reply=${encodeURIComponent(text)}`)).toEqual({
			kind: "open",
			instanceId: "abc",
			computerId: null,
			reply: text,
		});
	});

	test("a blank or malformed reply is dropped but the session still opens", () => {
		expect(parseRoute("open:abc&computer=r&reply=%20%20")).toEqual({
			kind: "open",
			instanceId: "abc",
			computerId: "r",
			reply: null,
		});
		expect(parseRoute("open:abc&reply=%E0%A4%A")).toEqual({
			kind: "open",
			instanceId: "abc",
			computerId: null,
			reply: null,
		});
	});

	test("open without an instance id is nothing", () => {
		expect(parseRoute("open:")).toBeNull();
		expect(parseRoute("open:&reply=hi")).toBeNull();
		expect(parseRoute("open:&computer=r")).toBeNull();
	});

	test("other named routes pass through, with the computer they came from", () => {
		expect(parseRoute("fix:acme%2Fapp/12")).toEqual({ kind: "route", route: "fix:acme%2Fapp/12", computerId: null });
		expect(parseRoute("fix:acme%2Fapp/12&computer=r")).toEqual({
			kind: "route",
			route: "fix:acme%2Fapp/12",
			computerId: "r",
		});
	});

	test("collab links are not routes, whatever they look like", () => {
		expect(parseRoute("localhost:8787/r/not-a-valid-key")).toEqual({
			kind: "route",
			route: "localhost:8787/r/not-a-valid-key",
			computerId: null,
		});
		const key = "A".repeat(43);
		expect(parseRoute(`localhost:8787/r/roomroomroom.${key}`)).toBeNull();
		expect(parseRoute("")).toBeNull();
		expect(parseRoute("no route here")).toBeNull();
	});
});

describe("route dispatch", () => {
	test("a route emitted before anyone listens reaches the first subscriber once", () => {
		emitRoute("fix:early", "r1");
		const seen: string[] = [];
		const off = subscribeRoute((route, computerId) => seen.push(`${route}@${computerId}`));
		const second: string[] = [];
		const off2 = subscribeRoute(route => second.push(route));
		expect(seen).toEqual(["fix:early@r1"]);
		expect(second).toEqual([]);
		emitRoute("fix:later");
		expect(seen).toEqual(["fix:early@r1", "fix:later@null"]);
		expect(second).toEqual(["fix:later"]);
		off();
		emitRoute("fix:last");
		expect(seen).toEqual(["fix:early@r1", "fix:later@null"]);
		expect(second).toEqual(["fix:later", "fix:last"]);
		off2();
	});
});

describe("applyBadge", () => {
	function target(): { calls: string[]; api: BadgeTarget } {
		const calls: string[] = [];
		return {
			calls,
			api: {
				setAppBadge: async count => {
					calls.push(`set ${count}`);
				},
				clearAppBadge: async () => {
					calls.push("clear");
				},
			},
		};
	}

	test("sets a positive count and clears at zero", () => {
		const { calls, api } = target();
		applyBadge(api, 3);
		applyBadge(api, 0);
		expect(calls).toEqual(["set 3", "clear"]);
	});

	test("is silent where the API is missing or refuses", () => {
		expect(() => applyBadge({}, 2)).not.toThrow();
		expect(() => applyBadge({}, 0)).not.toThrow();
		const refusing: BadgeTarget = { setAppBadge: () => Promise.reject(new Error("denied")) };
		expect(() => applyBadge(refusing, 1)).not.toThrow();
	});
});
