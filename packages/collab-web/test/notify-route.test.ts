import { describe, expect, test } from "bun:test";
import { applyBadge, type BadgeTarget } from "../src/lib/badge";
import { emitRoute, parseRoute, subscribeRoute } from "../src/lib/notify-route";

describe("parseRoute", () => {
	test("plain open", () => {
		expect(parseRoute("open:abc123")).toEqual({ kind: "open", instanceId: "abc123", reply: null });
	});

	test("open with a reply decodes the text, including characters that would end the route", () => {
		const text = "yes & go #1, 100% sure?";
		expect(parseRoute(`open:abc&reply=${encodeURIComponent(text)}`)).toEqual({
			kind: "open",
			instanceId: "abc",
			reply: text,
		});
	});

	test("a blank or malformed reply is dropped but the session still opens", () => {
		expect(parseRoute("open:abc&reply=%20%20")).toEqual({ kind: "open", instanceId: "abc", reply: null });
		expect(parseRoute("open:abc&reply=%E0%A4%A")).toEqual({ kind: "open", instanceId: "abc", reply: null });
	});

	test("open without an instance id is nothing", () => {
		expect(parseRoute("open:")).toBeNull();
		expect(parseRoute("open:&reply=hi")).toBeNull();
	});

	test("other named routes pass through", () => {
		expect(parseRoute("fix:acme%2Fapp/12")).toEqual({ kind: "route", route: "fix:acme%2Fapp/12" });
	});

	test("collab links are not routes, whatever they look like", () => {
		expect(parseRoute("localhost:8787/r/not-a-valid-key")).toEqual({
			kind: "route",
			route: "localhost:8787/r/not-a-valid-key",
		});
		const key = "A".repeat(43);
		expect(parseRoute(`localhost:8787/r/roomroomroom.${key}`)).toBeNull();
		expect(parseRoute("")).toBeNull();
		expect(parseRoute("no route here")).toBeNull();
	});
});

describe("route dispatch", () => {
	test("a route emitted before anyone listens reaches the first subscriber once", () => {
		emitRoute("fix:early");
		const seen: string[] = [];
		const off = subscribeRoute(route => seen.push(route));
		const second: string[] = [];
		const off2 = subscribeRoute(route => second.push(route));
		expect(seen).toEqual(["fix:early"]);
		expect(second).toEqual([]);
		emitRoute("fix:later");
		expect(seen).toEqual(["fix:early", "fix:later"]);
		expect(second).toEqual(["fix:later"]);
		off();
		emitRoute("fix:last");
		expect(seen).toEqual(["fix:early", "fix:later"]);
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
