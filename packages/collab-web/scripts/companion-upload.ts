/**
 * Files a paired device attaches to a prompt (`upload` request). Each is saved under its own random
 * directory in the temp folder, so two uploads of `report.pdf` never collide, and the absolute path
 * goes back to the device, which hands it to the agent. Nothing here is served back to anyone.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_UPLOAD_BYTES } from "../src/lib/files";

export const UPLOAD_ROOT = path.join(os.tmpdir(), "omp-collab-uploads");
/** Upload directories older than this are deleted the next time something is uploaded. */
export const UPLOAD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_NAME_CHARS = 120;
const FALLBACK_NAME = "file";

/**
 * A file name that is safe to create under the upload directory: the basename only, no control
 * characters or backticks (the path is quoted in a markdown code span), no leading dots, and
 * shortened from the middle of the stem so the extension survives.
 */
export function sanitizeUploadName(name: unknown): string {
	if (typeof name !== "string") return FALLBACK_NAME;
	const base = name.split(/[\\/]/).pop() ?? "";
	const clean = base
		.replace(/[\u0000-\u001f\u007f`]/g, "")
		.replace(/^[.\s]+/, "")
		.trim();
	if (clean === "") return FALLBACK_NAME;
	if (clean.length <= MAX_NAME_CHARS) return clean;
	const dot = clean.lastIndexOf(".");
	const ext = dot > 0 && clean.length - dot <= 16 ? clean.slice(dot) : "";
	return clean.slice(0, MAX_NAME_CHARS - ext.length) + ext;
}

/** The bytes of a base64 payload, refused before decoding when it is more than {@link MAX_UPLOAD_BYTES}. */
export function decodeUpload(data: unknown): Uint8Array {
	if (typeof data !== "string") throw new Error("invalid upload");
	if (data.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4) throw new Error("The file is too large to upload.");
	const bytes = Buffer.from(data, "base64");
	if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error("The file is too large to upload.");
	return bytes;
}

/** Remove upload directories last modified more than `maxAgeMs` before `now`. Missing root is fine. */
export async function pruneUploads(root: string, now: number, maxAgeMs = UPLOAD_MAX_AGE_MS): Promise<void> {
	let entries: string[];
	try {
		entries = await fs.readdir(root);
	} catch {
		return;
	}
	await Promise.all(
		entries.map(async entry => {
			const dir = path.join(root, entry);
			try {
				const stat = await fs.stat(dir);
				if (now - stat.mtimeMs > maxAgeMs) await fs.rm(dir, { recursive: true, force: true });
			} catch {
				// Removed by someone else meanwhile.
			}
		}),
	);
}

/** Save an upload (private to this user) and return the absolute path it was written to. */
export async function storeUpload(
	name: unknown,
	data: unknown,
	options: { root?: string; now?: number } = {},
): Promise<string> {
	const root = options.root ?? UPLOAD_ROOT;
	const bytes = decodeUpload(data);
	await fs.mkdir(root, { recursive: true, mode: 0o700 });
	await pruneUploads(root, options.now ?? Date.now());
	const dir = path.join(root, randomUUID());
	await fs.mkdir(dir, { mode: 0o700 });
	const file = path.join(dir, sanitizeUploadName(name));
	await fs.writeFile(file, bytes, { mode: 0o600 });
	return file;
}
