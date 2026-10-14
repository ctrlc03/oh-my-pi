import { describe, expect, it } from "bun:test";
import { externalUrl, isAppUrl, permissionAllowed, trustedSender } from "../src/main/security";

const ORIGIN = "http://127.0.0.1:7467";

describe("isAppUrl", () => {
	it("accepts only the companion's own origin", () => {
		expect(isAppUrl("http://127.0.0.1:7467/#x", ORIGIN)).toBe(true);
		expect(isAppUrl("http://127.0.0.1:7468/", ORIGIN)).toBe(false);
		expect(isAppUrl("https://127.0.0.1:7467/", ORIGIN)).toBe(false);
		expect(isAppUrl("http://localhost:7467/", ORIGIN)).toBe(false);
		expect(isAppUrl("http://127.0.0.1:7467@evil.example/", ORIGIN)).toBe(false);
		expect(isAppUrl("garbage", ORIGIN)).toBe(false);
		expect(isAppUrl("http://127.0.0.1:7467/", "")).toBe(false);
	});
});

describe("externalUrl", () => {
	it("passes web and mail links and nothing else", () => {
		expect(externalUrl("https://example.com/a?b#c")).toBe("https://example.com/a?b#c");
		expect(externalUrl("http://example.com/")).toBe("http://example.com/");
		expect(externalUrl("mailto:a@b.c")).toBe("mailto:a@b.c");
		for (const url of [
			"file:///etc/passwd",
			"javascript:alert(1)",
			"data:text/html,x",
			"ssh://host",
			"vscode://x",
			"nope",
		]) {
			expect(externalUrl(url)).toBeNull();
		}
	});
});

describe("permissionAllowed", () => {
	it("grants what the app uses to the app", () => {
		for (const permission of ["notifications", "clipboard-read", "clipboard-sanitized-write"]) {
			expect(permissionAllowed(permission, `${ORIGIN}/`, ORIGIN)).toBe(true);
		}
		expect(permissionAllowed("media", `${ORIGIN}/`, ORIGIN, ["audio"])).toBe(true);
		expect(permissionAllowed("media", `${ORIGIN}/`, ORIGIN, ["audio", "video"])).toBe(true);
	});

	it("refuses the screen, unknown media, and everything the app does not use", () => {
		expect(permissionAllowed("media", `${ORIGIN}/`, ORIGIN, ["screen"])).toBe(false);
		expect(permissionAllowed("media", `${ORIGIN}/`, ORIGIN, [])).toBe(false);
		expect(permissionAllowed("media", `${ORIGIN}/`, ORIGIN)).toBe(false);
		for (const permission of [
			"geolocation",
			"midi",
			"hid",
			"usb",
			"openExternal",
			"fullscreen",
			"display-capture",
			"toString",
		]) {
			expect(permissionAllowed(permission, `${ORIGIN}/`, ORIGIN)).toBe(false);
		}
	});

	it("refuses every other origin", () => {
		expect(permissionAllowed("notifications", "https://example.com/", ORIGIN)).toBe(false);
		expect(permissionAllowed("notifications", `${ORIGIN}/`, "")).toBe(false);
	});
});

describe("trustedSender", () => {
	it("needs the app's origin in the top frame", () => {
		expect(trustedSender(`${ORIGIN}/`, true, ORIGIN)).toBe(true);
		expect(trustedSender(`${ORIGIN}/`, false, ORIGIN)).toBe(false);
		expect(trustedSender("https://example.com/", true, ORIGIN)).toBe(false);
		expect(trustedSender("data:text/html,x", true, ORIGIN)).toBe(false);
	});
});
