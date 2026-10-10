import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	decodeUpload,
	pruneUploads,
	sanitizeUploadName,
	storeUpload,
	UPLOAD_MAX_AGE_MS,
} from "../scripts/companion-upload";
import { MAX_UPLOAD_BYTES } from "../src/lib/files";

let root: string;

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "companion-upload-"));
});

afterAll(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

const b64 = (text: string): string => Buffer.from(text).toString("base64");

describe("sanitizeUploadName", () => {
	it("keeps only the basename, whichever separator the device used", () => {
		expect(sanitizeUploadName("../../etc/passwd")).toBe("passwd");
		expect(sanitizeUploadName("C:\\Users\\me\\report.pdf")).toBe("report.pdf");
		expect(sanitizeUploadName("/abs/path/notes.txt")).toBe("notes.txt");
	});

	it("strips control characters and backticks but keeps the extension", () => {
		expect(sanitizeUploadName("re\u0000po\nrt`s.tar.gz")).toBe("reports.tar.gz");
	});

	it("never yields a hidden or empty name", () => {
		expect(sanitizeUploadName("..")).toBe("file");
		expect(sanitizeUploadName(".bashrc")).toBe("bashrc");
		expect(sanitizeUploadName("")).toBe("file");
		expect(sanitizeUploadName("a/")).toBe("file");
		expect(sanitizeUploadName(42)).toBe("file");
	});

	it("shortens a long stem, not the extension", () => {
		const name = sanitizeUploadName(`${"x".repeat(300)}.pdf`);
		expect(name.length).toBe(120);
		expect(name.endsWith(".pdf")).toBe(true);
	});
});

describe("decodeUpload", () => {
	it("decodes base64 and rejects non-strings", () => {
		expect(Buffer.from(decodeUpload(b64("hello"))).toString()).toBe("hello");
		expect(() => decodeUpload(12)).toThrow("invalid upload");
	});

	it("accepts a file of exactly the cap and refuses one byte more", () => {
		const exact = Buffer.alloc(MAX_UPLOAD_BYTES).toString("base64");
		expect(decodeUpload(exact).byteLength).toBe(MAX_UPLOAD_BYTES);
		const over = Buffer.alloc(MAX_UPLOAD_BYTES + 1).toString("base64");
		expect(() => decodeUpload(over)).toThrow("too large");
	});
});

describe("storeUpload", () => {
	it("saves under a private random directory and returns the absolute path", async () => {
		const file = await storeUpload("../../x/notes.txt", b64("saved"), { root });
		expect(path.isAbsolute(file)).toBe(true);
		expect(path.basename(file)).toBe("notes.txt");
		expect(path.dirname(path.dirname(file))).toBe(root);
		expect(await Bun.file(file).text()).toBe("saved");
		expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
	});

	it("gives two uploads of the same name separate paths", async () => {
		const a = await storeUpload("same.txt", b64("a"), { root });
		const b = await storeUpload("same.txt", b64("b"), { root });
		expect(a).not.toBe(b);
		expect(await Bun.file(a).text()).toBe("a");
		expect(await Bun.file(b).text()).toBe("b");
	});

	it("refuses an oversized upload without writing anything", async () => {
		const empty = await fs.mkdtemp(path.join(os.tmpdir(), "companion-upload-empty-"));
		try {
			const over = Buffer.alloc(MAX_UPLOAD_BYTES + 1).toString("base64");
			await expect(storeUpload("big.bin", over, { root: empty })).rejects.toThrow("too large");
			expect(await fs.readdir(empty)).toEqual([]);
		} finally {
			await fs.rm(empty, { recursive: true, force: true });
		}
	});

	it("prunes upload directories older than a week when something is uploaded", async () => {
		const stale = await storeUpload("old.txt", b64("old"), { root });
		const fresh = await storeUpload("new.txt", b64("new"), { root });
		const now = Date.now();
		const old = new Date(now - UPLOAD_MAX_AGE_MS - 60_000);
		await fs.utimes(path.dirname(stale), old, old);
		await storeUpload("trigger.txt", b64("t"), { root, now });
		expect(await Bun.file(stale).exists()).toBe(false);
		expect(await Bun.file(fresh).exists()).toBe(true);
	});
});

describe("pruneUploads", () => {
	it("tolerates a root that does not exist", async () => {
		await pruneUploads(path.join(root, "missing"), Date.now());
	});
});
