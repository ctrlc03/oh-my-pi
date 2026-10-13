/**
 * Where the companion keeps architecture maps: `<dir>/index.json` (one summary per map, the list's source of
 * truth, including maps still running or failed) and `<dir>/<id>.json` (a finished map). Private to the user:
 * the folder is 0700 and the files 0600, under the omp config folder and never in a repository. Writes are
 * atomic (temp file, then rename) and serialized.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type Blueprint, type BlueprintSummary, BLUEPRINT_VERSION } from "@oh-my-pi/pi-wire/blueprint";
import { isRecord } from "../src/tool-render/util";

export const BLUEPRINT_ID_RE = /^bp-[0-9a-f]{12}$/;
const INDEX_VERSION = 1;

/** A new map id. */
export function newBlueprintId(): string {
	return `bp-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export function checkBlueprintId(value: unknown): string {
	if (typeof value !== "string" || !BLUEPRINT_ID_RE.test(value)) throw new Error("invalid map id");
	return value;
}

function isCommit(value: unknown): boolean {
	return isRecord(value) && typeof value.commit === "string";
}

/** A summary read back from disk, or null when it is not one. */
function parseSummary(value: unknown): BlueprintSummary | null {
	if (!isRecord(value)) return null;
	const { id, title, repoRoot, head, createdAt, status } = value;
	if (
		typeof id !== "string" ||
		!BLUEPRINT_ID_RE.test(id) ||
		typeof title !== "string" ||
		typeof repoRoot !== "string" ||
		!isCommit(head) ||
		typeof createdAt !== "number" ||
		(status !== "running" && status !== "ready" && status !== "failed")
	)
		return null;
	return value as unknown as BlueprintSummary;
}

export interface BlueprintStore {
	/** Read the index; maps that were running when the companion stopped come back `failed` ("interrupted"). */
	load(): Promise<{ interruptedInstances: string[] }>;
	list(): BlueprintSummary[];
	get(id: string): BlueprintSummary | undefined;
	/** Insert or replace a summary. */
	put(summary: BlueprintSummary): Promise<void>;
	/** Drop a summary and the map file. */
	remove(id: string): Promise<void>;
	readMap(id: string): Promise<Blueprint | null>;
	writeMap(map: Blueprint): Promise<void>;
}

export function createBlueprintStore(dir: string): BlueprintStore {
	const indexFile = path.join(dir, "index.json");
	const entries = new Map<string, BlueprintSummary>();
	let saving: Promise<void> = Promise.resolve();

	const writeAtomic = async (file: string, text: string): Promise<void> => {
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		await fs.chmod(dir, 0o700);
		const temp = `${file}.${crypto.randomUUID().slice(0, 8)}.tmp`;
		await fs.writeFile(temp, text, { mode: 0o600 });
		await fs.rename(temp, file);
		await fs.chmod(file, 0o600);
	};
	const persist = (): Promise<void> => {
		const text = `${JSON.stringify({ v: INDEX_VERSION, maps: [...entries.values()] })}\n`;
		const next = saving.then(() => writeAtomic(indexFile, text));
		saving = next.catch(() => undefined);
		return next;
	};

	return {
		async load() {
			entries.clear();
			const interruptedInstances: string[] = [];
			let interrupted = false;
			try {
				const raw = JSON.parse(await fs.readFile(indexFile, "utf8")) as unknown;
				const maps = isRecord(raw) && Array.isArray(raw.maps) ? raw.maps : [];
				for (const value of maps) {
					const summary = parseSummary(value);
					if (!summary) continue;
					if (summary.status === "running") {
						const { progress: _progress, instanceId, ...rest } = summary;
						entries.set(summary.id, { ...rest, status: "failed", error: "interrupted" });
						if (instanceId !== undefined) interruptedInstances.push(instanceId);
						interrupted = true;
					} else {
						entries.set(summary.id, summary);
					}
				}
			} catch (err) {
				// No index yet is normal; an unreadable one starts the list empty rather than blocking maps.
				if ((err as NodeJS.ErrnoException).code !== "ENOENT")
					console.error(
						`companion: reading the architecture map index failed: ${err instanceof Error ? err.message : err}`,
					);
			}
			if (interrupted) await persist();
			return { interruptedInstances };
		},
		list: () => [...entries.values()],
		get: id => entries.get(id),
		async put(summary) {
			entries.set(summary.id, summary);
			await persist();
		},
		async remove(id) {
			const file = path.join(dir, `${checkBlueprintId(id)}.json`);
			entries.delete(id);
			await persist();
			await fs.rm(file, { force: true });
		},
		async readMap(id) {
			try {
				const map = JSON.parse(
					await fs.readFile(path.join(dir, `${checkBlueprintId(id)}.json`), "utf8"),
				) as Blueprint;
				return map.v === BLUEPRINT_VERSION ? map : null;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
				throw err;
			}
		},
		async writeMap(map) {
			await writeAtomic(path.join(dir, `${checkBlueprintId(map.id)}.json`), `${JSON.stringify(map)}\n`);
		},
	};
}
