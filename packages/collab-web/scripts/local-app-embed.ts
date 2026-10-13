/**
 * Build-time half of the embedded app (`./local-app-embedded` is the run-time half): turns a built app directory
 * into the in-memory module overrides that `Bun.build` bundles into the standalone binary.
 *
 * The files are embedded as they are, except text files, which are gzipped when that saves anything: a browser
 * accepts gzip as it is, so the binary carries the smaller copy and the companion inflates only for a client that
 * did not ask for it. Nothing is written to disk.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { contentTypeOf, isCompressible } from "./local-app";

export interface EmbeddedAppFiles {
	/** `Bun.build({ files })` overrides: the manifest module and one module per file. */
	overrides: Record<string, string | Uint8Array>;
	/** Sizes before and after the gzip step, for the build log. */
	rawBytes: number;
	storedBytes: number;
}

/** @throws when `dir` holds a file the app could not serve (no content type) or no `index.html`. */
export async function embeddedAppFiles(dir: string): Promise<EmbeddedAppFiles> {
	const scriptsDir = await fs.realpath(import.meta.dir);
	const rels = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dir, onlyFiles: true })))
		.filter(rel => !rel.split("/").some(segment => segment.startsWith(".")))
		.sort();
	if (!rels.includes("index.html")) throw new Error(`${dir} holds no index.html: build the app first`);
	const overrides: Record<string, string | Uint8Array> = {};
	const imports: string[] = [];
	const entries: string[] = [];
	let rawBytes = 0;
	let storedBytes = 0;
	for (const [index, rel] of rels.entries()) {
		if (contentTypeOf(rel) === undefined) throw new Error(`no content type for ${rel}`);
		const raw = await Bun.file(path.join(dir, rel)).bytes();
		const zipped = isCompressible(rel) ? Bun.gzipSync(raw, { level: 9 }) : null;
		const gzip = zipped !== null && zipped.byteLength < raw.byteLength;
		const stored = gzip ? zipped : raw;
		rawBytes += raw.byteLength;
		storedBytes += stored.byteLength;
		const name = `app-${index}${path.extname(rel)}${gzip ? ".gz" : ""}`;
		overrides[path.join(scriptsDir, "local-app-files", name)] = stored;
		imports.push(`import file${index} from ${JSON.stringify(`./local-app-files/${name}`)} with { type: "file" };`);
		const etag = `"${new Bun.CryptoHasher("sha256").update(raw).digest("hex").slice(0, 20)}"`;
		entries.push(
			`{ path: ${JSON.stringify(rel)}, file: file${index}, gzip: ${gzip}, etag: ${JSON.stringify(etag)} }`,
		);
	}
	overrides[path.join(scriptsDir, "local-app-embedded.ts")] = `${imports.join("\n")}

export const embeddedApp = {
	files: [
		${entries.join(",\n\t\t")},
	],
};
`;
	return { overrides, rawBytes, storedBytes };
}
