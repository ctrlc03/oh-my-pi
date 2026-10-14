import { afterEach, describe, expect, it } from "bun:test";
import {
	ignoreStaleBuild,
	importChunk,
	isChunkLoadError,
	isStaleBuildError,
	STALE_BUILD_MESSAGE,
	StaleBuildError,
} from "../src/lib/stale-build";

const CHROMIUM = new TypeError("Failed to fetch dynamically imported module: http://127.0.0.1:7467/bmw2hda2.js");
const WEBKIT = new TypeError("Importing a module script failed.");
const GECKO = new TypeError("error loading dynamically imported module: http://127.0.0.1:7467/bmw2hda2.js");

describe("isChunkLoadError", () => {
	it("recognises the message each browser gives a lazy chunk that could not be fetched", () => {
		expect(isChunkLoadError(CHROMIUM)).toBe(true);
		expect(isChunkLoadError(WEBKIT)).toBe(true);
		expect(isChunkLoadError(GECKO)).toBe(true);
		expect(isChunkLoadError(new TypeError("error loading dynamically imported module"))).toBe(true);
	});

	it("does not match other errors or things that are not errors", () => {
		expect(isChunkLoadError(new TypeError("Failed to fetch"))).toBe(false);
		expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe(false);
		expect(isChunkLoadError(new Error("the diagram could not be rendered"))).toBe(false);
		expect(isChunkLoadError(new SyntaxError("Unexpected token '<'"))).toBe(false);
		expect(isChunkLoadError("Failed to fetch dynamically imported module")).toBe(false);
		expect(isChunkLoadError(null)).toBe(false);
		expect(isChunkLoadError(undefined)).toBe(false);
	});
});

describe("importChunk", () => {
	const online = Object.getOwnPropertyDescriptor(navigator, "onLine");
	afterEach(() => {
		if (online) Object.defineProperty(navigator, "onLine", online);
		else Reflect.deleteProperty(navigator, "onLine");
	});

	it("returns the module without retrying when the first load works", async () => {
		let calls = 0;
		const module = await importChunk(async () => {
			calls++;
			return { value: 1 };
		});
		expect(module).toEqual({ value: 1 });
		expect(calls).toBe(1);
	});

	it("retries a failed chunk fetch once", async () => {
		let calls = 0;
		const module = await importChunk(async () => {
			calls++;
			if (calls === 1) throw CHROMIUM;
			return "loaded";
		});
		expect(module).toBe("loaded");
		expect(calls).toBe(2);
	});

	it("rejects with the update notice, not the browser's message, when the retry fails too", async () => {
		let calls = 0;
		const failure = await importChunk(async () => {
			calls++;
			throw WEBKIT;
		}).catch((error: unknown) => error);
		expect(calls).toBe(2);
		expect(failure).toBeInstanceOf(StaleBuildError);
		expect(isStaleBuildError(failure)).toBe(true);
		expect((failure as StaleBuildError).message).toBe(STALE_BUILD_MESSAGE);
		expect((failure as StaleBuildError).message).toBe("The app was updated. Reload to continue.");
		expect((failure as StaleBuildError).cause).toBe(WEBKIT);
	});

	it("runs the loader again on a later call, so a cached rejected promise cannot stick", async () => {
		let calls = 0;
		const load = async (): Promise<string> => {
			calls++;
			if (calls <= 2) throw GECKO;
			return "back";
		};
		await expect(importChunk(load)).rejects.toBeInstanceOf(StaleBuildError);
		expect(await importChunk(load)).toBe("back");
	});

	it("passes other errors through untouched and unretried", async () => {
		let calls = 0;
		const boom = new Error("the chunk's own code threw");
		const failure = await importChunk(async () => {
			calls++;
			throw boom;
		}).catch((error: unknown) => error);
		expect(failure).toBe(boom);
		expect(calls).toBe(1);
	});

	it("does not call an offline failure an update: the chunk may well exist", async () => {
		Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
		const failure = await importChunk(async () => {
			throw CHROMIUM;
		}).catch((error: unknown) => error);
		expect(failure).toBe(CHROMIUM);
	});
});

describe("ignoreStaleBuild", () => {
	it("swallows the update notice and rethrows anything else", () => {
		expect(() => ignoreStaleBuild(new StaleBuildError())).not.toThrow();
		const other = new Error("offline");
		expect(() => ignoreStaleBuild(other)).toThrow(other);
	});
});
