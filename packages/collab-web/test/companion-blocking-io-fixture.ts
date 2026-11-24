/**
 * Child process of companion-blocking-io.test.ts: the companion's loopback relay and app, a periodic timer standing for the
 * companion's polls, and one operation on a repository in which something the operation reads is a named pipe: a file it
 * opens (`lsp`, `codemap`). Opening a named pipe for reading waits until something opens it for writing, exactly as a
 * read waits behind a macOS privacy prompt for a protected folder, so a synchronous read of it holds the whole process
 * and an asynchronous one only itself.
 *
 *   bun test/companion-blocking-io-fixture.ts <lsp | codemap> <repository>
 *
 * Prints `READY <port>` once the relay serves (it answers `GET /__ticks` with the number of timer ticks so far), `STALLING`
 * when it starts the operation, and `DONE <json>` when the operation finishes.
 */
import { openThrowawayIndex } from "../scripts/companion-codemap";
import { lspQuery } from "../scripts/companion-lsp";
import { startCompanionRelay } from "../scripts/companion-local-relay";
import { createLocalAppHandler } from "../scripts/local-app";

const [scenario, repo] = process.argv.slice(2);
if ((scenario !== "lsp" && scenario !== "codemap") || repo === undefined)
	throw new Error("usage: <lsp|codemap> <repo>");

let ticks = 0;
setInterval(() => {
	ticks++;
}, 25);

const app = createLocalAppHandler(() => ({ kind: "building" }));
const { url } = startCompanionRelay({
	preferredPort: 0,
	app: request => (new URL(request.url).pathname === "/__ticks" ? new Response(String(ticks)) : app(request)),
});
console.log(`READY ${new URL(url).port}`);
console.log("STALLING");

if (scenario === "lsp") {
	// A file no language server handles: the answer is "unavailable", but only after the server configuration, which
	// reads the repository's own lsp files, has been loaded.
	const result = await lspQuery(repo, false, {
		op: "hover",
		path: "notes.zzunknown",
		position: { line: 1, character: 0 },
	});
	console.log(`DONE ${JSON.stringify(result)}`);
} else {
	const codemap = await openThrowawayIndex(repo);
	try {
		// Building the graph names each circuit by its manifest, which is read from the repository.
		const edges = codemap.query.graphEdges().map(edge => `${edge.from} -> ${edge.to}`);
		console.log(`DONE ${JSON.stringify({ edges })}`);
	} finally {
		codemap.close();
	}
}
process.exit(0);
