import { describe, expect, it } from "bun:test";
import { checkPreviewUrl, parseCwds, parseListeners } from "../scripts/companion-preview";

describe("checkPreviewUrl", () => {
	it("accepts http(s) pages on the loopback interface", () => {
		expect(checkPreviewUrl("http://localhost:3000")).toBe("http://localhost:3000/");
		expect(checkPreviewUrl("  https://localhost/app?x=1#top ")).toBe("https://localhost/app?x=1#top");
		expect(checkPreviewUrl("http://127.0.0.1:5173/")).toBe("http://127.0.0.1:5173/");
		expect(checkPreviewUrl("http://127.8.9.10:80/")).toBe("http://127.8.9.10/");
		expect(checkPreviewUrl("http://[::1]:3000")).toBe("http://[::1]:3000/");
		expect(checkPreviewUrl("http://app.localhost:8080/")).toBe("http://app.localhost:8080/");
		expect(checkPreviewUrl("HTTP://LOCALHOST:3000")).toBe("http://localhost:3000/");
		// The URL parser rewrites numeric spellings of the loopback address.
		expect(checkPreviewUrl("http://127.1:3000")).toBe("http://127.0.0.1:3000/");
		expect(checkPreviewUrl("http://2130706433:3000")).toBe("http://127.0.0.1:3000/");
	});

	it("refuses hosts that only look like loopback", () => {
		for (const url of [
			"http://localhost.evil.com",
			"http://127.0.0.1.nip.io",
			"http://evil.com/localhost",
			"http://evil.com#@localhost",
			"http://localhost@evil.com",
			"http://localhost:3000@evil.com",
			"http://127.0.0.1@evil.com:3000",
			"http://notlocalhost",
			"http://128.0.0.1",
			"http://0.0.0.0:3000",
			"http://[::2]:3000",
			"http://[::ffff:8.8.8.8]",
			"http://192.168.1.10:3000",
			"https://example.com",
		]) {
			expect(() => checkPreviewUrl(url), url).toThrow();
		}
	});

	it("refuses other schemes, credentials and non-URLs", () => {
		for (const url of [
			"file:///etc/passwd",
			"ftp://localhost/",
			"javascript:alert(1)",
			"data:text/html,hi",
			"http://user:pw@localhost:3000",
			"localhost:3000",
			"",
			"not a url",
			42,
			null,
		]) {
			expect(() => checkPreviewUrl(url), String(url)).toThrow();
		}
		expect(() => checkPreviewUrl(`http://localhost/${"a".repeat(3000)}`)).toThrow();
	});
});

describe("parseListeners", () => {
	const out = [
		"p101",
		"cnode",
		"n*:3000",
		"p202",
		"cMy\\x20App",
		"n127.0.0.1:5173",
		"n[::1]:5173",
		"p303",
		"crapportd",
		"n192.168.1.5:49152",
		"p404",
		"cbun",
		"n[::]:8080",
		"n*:8081",
		"",
	].join("\n");

	it("keeps loopback and wildcard listeners with their pid, command and port", () => {
		expect(parseListeners(out)).toEqual([
			{ pid: 101, command: "node", port: 3000 },
			{ pid: 202, command: "My App", port: 5173 },
			{ pid: 202, command: "My App", port: 5173 },
			{ pid: 404, command: "bun", port: 8080 },
			{ pid: 404, command: "bun", port: 8081 },
		]);
	});

	it("ignores address lines without a process and malformed ones", () => {
		expect(parseListeners("n*:3000\np5\ncx\nn*:notaport\n")).toEqual([]);
		expect(parseListeners("")).toEqual([]);
	});
});

describe("parseCwds", () => {
	it("maps each pid to its working directory", () => {
		expect(parseCwds(["p101", "n/Users/me/app", "p202", "n/tmp/My\\x20Proj", ""].join("\n"))).toEqual(
			new Map([
				[101, "/Users/me/app"],
				[202, "/tmp/My Proj"],
			]),
		);
	});
});
