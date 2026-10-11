/**
 * Entry of the standalone omp binary that ships the collab companion (`scripts/build-collab-binary.ts`):
 *
 *   omp companion [flags]            the companion, with the flags of `bun scripts/companion.ts`
 *   omp __collab-foreign-host …      one foreign agent host (`./foreign/host-main.ts`), started by the companion
 *   omp __collab-adapter <script> …  one ACP adapter script (a managed Claude or Codex adapter), run with its own argv
 *   omp <anything else>              regular omp
 *
 * Regular omp is `require`d, not imported dynamically: its worker-thread dispatch must attach message inboxes
 * in the synchronous prefix of the entry module, before the first await.
 */

import { ADAPTER_COMMAND, buildLabel, COMPANION_COMMAND, FOREIGN_HOST_COMMAND } from "./build-identity";

const COMPANION_HELP = `omp companion: keeps one encrypted relay room open on this computer so the collab web app can list, start and join omp sessions here.

Usage: omp ${COMPANION_COMMAND} [flags]

Flags:
  (none)       print a pairing link and QR code, then serve
  --pair       print a fresh one-time pairing link and QR code, then exit
  --rotate     new room key: unpairs every device
  --install    run at login as a background service (launchd on macOS, a systemd user unit on Linux)
  --dry-run    with --install: print the service definition only
  --uninstall  remove the background service
  --help       this text

Settings: collab.webUrl (the web app the pairing link opens), collab.relayUrl. Set them with \`omp config set\`.
Build: ${buildLabel()}
`;

const command = process.argv[2];

if (command === COMPANION_COMMAND) {
	if (process.argv.slice(3).some(flag => flag === "--help" || flag === "-h")) {
		process.stdout.write(COMPANION_HELP);
		process.exit(0);
	}
	process.argv.splice(2, 1);
	await import("./companion");
} else if (command === FOREIGN_HOST_COMMAND) {
	process.argv.splice(2, 1);
	await import("./foreign/host-main");
} else if (command === ADAPTER_COMMAND) {
	// argv becomes [omp, <script>, …args], as `bun <script> …args` would give the adapter.
	const script = process.argv[3];
	if (!script) {
		process.stderr.write(`omp ${ADAPTER_COMMAND}: missing script\n`);
		process.exit(2);
	}
	process.argv.splice(1, 2);
	await import(script);
} else {
	// The package's exports map has no `require` condition, so the sibling package is reached by path.
	require("../../coding-agent/src/cli.ts");
}
