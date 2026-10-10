import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	chunkSpan,
	DOWNLOAD_CHUNK_BYTES,
	DOWNLOAD_MAX_BYTES,
	mimeOf,
	readFileChunk,
} from "../scripts/companion-download";
import type { FileChunk } from "../src/lib/companion";
import { assembleChunks, DownloadCancelled } from "../src/lib/download";

let root: string;
let session: string;

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "companion-download-"));
	session = path.join(root, "session");
	await fs.mkdir(path.join(session, "src"), { recursive: true });
	await fs.writeFile(path.join(root, "secret.txt"), "outside");
	await fs.writeFile(path.join(session, "src", "note.md"), "hello");
	await fs.writeFile(path.join(session, "empty.bin"), "");
	await fs.symlink(path.join(root, "secret.txt"), path.join(session, "leak.txt"));
	await fs.symlink(path.join(session, "src", "note.md"), path.join(session, "alias.md"));
	// Sparse files: sizes without the disk use.
	for (const [name, size] of [
		["two-chunks.bin", DOWNLOAD_CHUNK_BYTES + 10],
		["huge.bin", DOWNLOAD_MAX_BYTES + 1],
	] as const) {
		const handle = await fs.open(path.join(session, name), "w");
		await handle.truncate(size);
		await handle.close();
	}
});

afterAll(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("chunkSpan", () => {
	it("splits a file into 4 MB chunks with a short last one", () => {
		const size = DOWNLOAD_CHUNK_BYTES * 2 + 5;
		expect(chunkSpan(size, 0)).toEqual({ length: DOWNLOAD_CHUNK_BYTES, done: false });
		expect(chunkSpan(size, DOWNLOAD_CHUNK_BYTES)).toEqual({ length: DOWNLOAD_CHUNK_BYTES, done: false });
		expect(chunkSpan(size, DOWNLOAD_CHUNK_BYTES * 2)).toEqual({ length: 5, done: true });
	});

	it("marks a file of exactly one chunk as done, and an empty file as one empty chunk", () => {
		expect(chunkSpan(DOWNLOAD_CHUNK_BYTES, 0)).toEqual({ length: DOWNLOAD_CHUNK_BYTES, done: true });
		expect(chunkSpan(0, 0)).toEqual({ length: 0, done: true });
	});

	it("refuses offsets that are not a position inside the file", () => {
		for (const offset of [-1, 1.5, Number.NaN, 11, 10]) expect(() => chunkSpan(10, offset)).toThrow("invalid offset");
		expect(() => chunkSpan(0, 1)).toThrow("invalid offset");
	});
});

describe("mimeOf", () => {
	it("maps by extension, case-insensitively, falling back to octet-stream", () => {
		expect(mimeOf("shot.PNG")).toBe("image/png");
		expect(mimeOf("report.pdf")).toBe("application/pdf");
		expect(mimeOf("Makefile")).toBe("application/octet-stream");
		expect(mimeOf("data.unknownext")).toBe("application/octet-stream");
	});
});

describe("readFileChunk", () => {
	it("serves a small file whole, by relative or absolute path", async () => {
		const chunk = await readFileChunk(session, "src/note.md", 0);
		expect(chunk).toEqual({
			name: "note.md",
			size: 5,
			mime: "text/markdown",
			offset: 0,
			data: Buffer.from("hello").toString("base64"),
			done: true,
		});
		expect((await readFileChunk(session, path.join(session, "src", "note.md"), 0)).data).toBe(chunk.data);
	});

	it("serves an empty file as one done chunk", async () => {
		expect(await readFileChunk(session, "empty.bin", 0)).toMatchObject({ size: 0, data: "", done: true });
	});

	it("serves a file larger than a chunk in two chunks that join to its size", async () => {
		const first = await readFileChunk(session, "two-chunks.bin", 0);
		expect(first.done).toBe(false);
		expect(Buffer.from(first.data, "base64").length).toBe(DOWNLOAD_CHUNK_BYTES);
		const second = await readFileChunk(session, "two-chunks.bin", DOWNLOAD_CHUNK_BYTES);
		expect(second.done).toBe(true);
		expect(second.size).toBe(DOWNLOAD_CHUNK_BYTES + 10);
		expect(Buffer.from(second.data, "base64").length).toBe(10);
	});

	it("follows a symlink that stays inside the session", async () => {
		expect((await readFileChunk(session, "alias.md", 0)).name).toBe("note.md");
	});

	it("refuses a symlink that leads outside the session", async () => {
		await expect(readFileChunk(session, "leak.txt", 0)).rejects.toThrow("outside");
	});

	it("refuses paths that climb or point outside the session", async () => {
		await expect(readFileChunk(session, "../secret.txt", 0)).rejects.toThrow("outside");
		await expect(readFileChunk(session, path.join(root, "secret.txt"), 0)).rejects.toThrow("outside");
	});

	it("refuses missing files, directories and bad input", async () => {
		await expect(readFileChunk(session, "nope.txt", 0)).rejects.toThrow("file not found");
		await expect(readFileChunk(session, "src", 0)).rejects.toThrow("not a regular file");
		await expect(readFileChunk(session, "", 0)).rejects.toThrow("invalid path");
		await expect(readFileChunk(session, "src/note.md", "0")).rejects.toThrow("invalid offset");
		await expect(readFileChunk(session, "src/note.md", 5)).rejects.toThrow("invalid offset");
	});

	it("refuses a file over 100 MB", async () => {
		await expect(readFileChunk(session, "huge.bin", 0)).rejects.toThrow("larger than 100 MB");
	});
});

/** A chunk source over `bytes`, cutting at `step` so a few bytes make several chunks. */
function source(bytes: Uint8Array, step: number, name = "f.bin"): (offset: number) => Promise<FileChunk> {
	return async offset => {
		const end = Math.min(bytes.length, offset + step);
		return {
			name,
			size: bytes.length,
			mime: "application/octet-stream",
			offset,
			data: Buffer.from(bytes.subarray(offset, end)).toString("base64"),
			done: end >= bytes.length,
		};
	};
}

describe("assembleChunks", () => {
	it("joins chunks in order into one blob and reports progress", async () => {
		const bytes = Uint8Array.from({ length: 10 }, (_, i) => i);
		const seen: number[] = [];
		const { blob, name } = await assembleChunks(source(bytes, 4), { onProgress: p => seen.push(p.received) });
		expect(name).toBe("f.bin");
		expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
		expect(seen).toEqual([4, 8, 10]);
	});

	it("stops requesting chunks once cancelled", async () => {
		const controller = new AbortController();
		const bytes = new Uint8Array(10);
		const inner = source(bytes, 2);
		let calls = 0;
		const promise = assembleChunks(
			async offset => {
				calls++;
				if (calls === 2) controller.abort();
				return inner(offset);
			},
			{ signal: controller.signal },
		);
		await expect(promise).rejects.toBeInstanceOf(DownloadCancelled);
		expect(calls).toBe(2);
	});

	it("fails when the file changes size between chunks", async () => {
		const inner = source(new Uint8Array(10), 4);
		const shrinking = async (offset: number): Promise<FileChunk> => {
			const chunk = await inner(offset);
			return offset === 0 ? chunk : { ...chunk, size: chunk.size + 1 };
		};
		await expect(assembleChunks(shrinking)).rejects.toThrow("changed while downloading");
	});

	it("fails on an out-of-order chunk instead of corrupting the file", async () => {
		const inner = source(new Uint8Array(10), 4);
		await expect(assembleChunks(async offset => ({ ...(await inner(offset)), offset: 0 }))).rejects.toThrow(
			"out of order",
		);
	});

	it("fails on an empty chunk that is not the last rather than looping", async () => {
		const stuck = async (offset: number): Promise<FileChunk> => ({
			name: "f",
			size: 10,
			mime: "x/y",
			offset,
			data: "",
			done: false,
		});
		await expect(assembleChunks(stuck)).rejects.toThrow("empty chunk");
	});

	it("assembles an empty file", async () => {
		const { blob } = await assembleChunks(source(new Uint8Array(0), 4));
		expect(blob.size).toBe(0);
	});
});
