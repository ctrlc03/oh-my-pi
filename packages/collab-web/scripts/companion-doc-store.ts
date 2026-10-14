/**
 * Where the companion keeps things it generates for the user (architecture maps, quizzes): `<dir>/index.json` (one
 * summary per item, the list's source of truth, including items still running or failed) and `<dir>/<id>.json` (the
 * finished document). Private to the user: the folder is 0700 and the files 0600, under the omp config folder and
 * never in a repository. Writes are atomic (temp file, then rename) and serialized.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord } from "../src/tool-render/util";

const INDEX_VERSION = 1;

/** What the store needs of a summary row. */
export interface DocSummary {
	id: string;
	title: string;
	repoRoot: string;
	createdAt: number;
	status: "running" | "ready" | "failed";
	progress?: string;
	error?: string;
	/** The omp session still working on it, so a companion that restarts can end it. */
	instanceId?: string;
}

export interface DocStoreOptions<D extends { id: string; v: number }> {
	dir: string;
	/** The property of `index.json` holding the summaries (`maps` for architecture maps, as written before the store was shared). */
	indexKey: string;
	/** Ids are `<prefix>-` and twelve hex digits. */
	idPrefix: string;
	/** What an item is called in error messages ("map", "quiz"). */
	noun: string;
	/** The format version a stored document must have; others read back as missing. */
	version: D["v"];
	/** Extra shape checks of a summary read back from disk (the common fields are checked already). */
	isSummary?(value: Record<string, unknown>): boolean;
}

export interface DocStore<S extends DocSummary, D extends { id: string; v: number }> {
	/** A new id. */
	newId(): string;
	/** `value` when it is a well-formed id; throws "invalid <noun> id" otherwise. */
	checkId(value: unknown): string;
	/** Read the index; items that were running when the companion stopped come back `failed` ("interrupted"). */
	load(): Promise<{ interruptedInstances: string[] }>;
	list(): S[];
	get(id: string): S | undefined;
	/** Insert or replace a summary. */
	put(summary: S): Promise<void>;
	/** Drop a summary and the document file. */
	remove(id: string): Promise<void>;
	readDoc(id: string): Promise<D | null>;
	writeDoc(doc: D): Promise<void>;
}

export function createDocStore<S extends DocSummary, D extends { id: string; v: number }>(
	options: DocStoreOptions<D>,
): DocStore<S, D> {
	const { dir, noun } = options;
	const idRe = new RegExp(`^${options.idPrefix}-[0-9a-f]{12}$`);
	const indexFile = path.join(dir, "index.json");
	const entries = new Map<string, S>();
	let saving: Promise<void> = Promise.resolve();

	const checkId = (value: unknown): string => {
		if (typeof value !== "string" || !idRe.test(value)) throw new Error(`invalid ${noun} id`);
		return value;
	};
	const parseSummary = (value: unknown): S | null => {
		if (!isRecord(value)) return null;
		const { id, title, repoRoot, createdAt, status } = value;
		if (
			typeof id !== "string" ||
			!idRe.test(id) ||
			typeof title !== "string" ||
			typeof repoRoot !== "string" ||
			typeof createdAt !== "number" ||
			(status !== "running" && status !== "ready" && status !== "failed") ||
			options.isSummary?.(value) === false
		)
			return null;
		return value as unknown as S;
	};
	const writeAtomic = async (file: string, text: string): Promise<void> => {
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		await fs.chmod(dir, 0o700);
		const temp = `${file}.${crypto.randomUUID().slice(0, 8)}.tmp`;
		await fs.writeFile(temp, text, { mode: 0o600 });
		await fs.rename(temp, file);
		await fs.chmod(file, 0o600);
	};
	const persist = (): Promise<void> => {
		const text = `${JSON.stringify({ v: INDEX_VERSION, [options.indexKey]: [...entries.values()] })}\n`;
		const next = saving.then(() => writeAtomic(indexFile, text));
		saving = next.catch(() => undefined);
		return next;
	};

	return {
		newId: () => `${options.idPrefix}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
		checkId,
		async load() {
			entries.clear();
			const interruptedInstances: string[] = [];
			let interrupted = false;
			try {
				const raw = JSON.parse(await fs.readFile(indexFile, "utf8")) as unknown;
				const items =
					isRecord(raw) && Array.isArray(raw[options.indexKey]) ? (raw[options.indexKey] as unknown[]) : [];
				for (const value of items) {
					const summary = parseSummary(value);
					if (!summary) continue;
					if (summary.status === "running") {
						const { progress: _progress, instanceId, ...rest } = summary;
						entries.set(summary.id, { ...rest, status: "failed", error: "interrupted" } as unknown as S);
						if (instanceId !== undefined) interruptedInstances.push(instanceId);
						interrupted = true;
					} else {
						entries.set(summary.id, summary);
					}
				}
			} catch (err) {
				// No index yet is normal; an unreadable one starts the list empty rather than blocking the feature.
				if ((err as NodeJS.ErrnoException).code !== "ENOENT")
					console.error(
						`companion: reading the ${noun} index failed: ${err instanceof Error ? err.message : err}`,
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
			const file = path.join(dir, `${checkId(id)}.json`);
			entries.delete(id);
			await persist();
			await fs.rm(file, { force: true });
		},
		async readDoc(id) {
			try {
				const doc = JSON.parse(await fs.readFile(path.join(dir, `${checkId(id)}.json`), "utf8")) as D;
				return doc.v === options.version ? doc : null;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
				throw err;
			}
		},
		async writeDoc(doc) {
			await writeAtomic(path.join(dir, `${checkId(doc.id)}.json`), `${JSON.stringify(doc)}\n`);
		},
	};
}
