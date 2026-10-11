/**
 * How the companion runs: from a checkout under bun (`bun scripts/companion.ts`), or inside the standalone omp
 * binary (`omp companion`), where there is no checkout, no bun on PATH and `process.execPath` is omp itself.
 * The release identity of the build comes from the coding-agent so `omp update` and the companion agree on it.
 */

import * as path from "node:path";

export { BUILD_TAG, buildLabel, IS_FORK_BUILD, RELEASE_REPO } from "@oh-my-pi/pi-coding-agent/build-identity";

/** `omp companion …`: the companion's subcommand in the standalone binary. */
export const COMPANION_COMMAND = "companion";
/** Internal subcommand of the standalone binary that runs one foreign agent host (`foreign/host-main.ts`). */
export const FOREIGN_HOST_COMMAND = "__collab-foreign-host";

/** Internal subcommand of the standalone binary that runs an ACP adapter's script (`omp __collab-adapter <script> [args…]`). */
export const ADAPTER_COMMAND = "__collab-adapter";

/** Running inside the compiled omp binary; the define is folded at build time and absent in a checkout. */
export const isCompiled: boolean = process.env.PI_COMPILED === "true";

/** The command that runs the companion: the service manager's argv. */
export function selfCommand(compiled: boolean = isCompiled): string[] {
	return compiled
		? [process.execPath, COMPANION_COMMAND]
		: [process.execPath, path.join(import.meta.dir, "companion.ts")];
}

/** The command that runs a foreign agent host, before its flags. */
export function foreignHostLauncher(compiled: boolean = isCompiled): string[] {
	return compiled
		? [process.execPath, FOREIGN_HOST_COMMAND]
		: [process.execPath, path.join(import.meta.dir, "foreign", "host-main.ts")];
}

/**
 * The command that runs an adapter's script. Compiled, the binary imports the script itself, so the adapter and the vendor
 * CLI below it never see `BUN_BE_BUN` (which would make every Bun-compiled executable they start act as bun).
 */
export function adapterLauncher(bun: string, script: string, compiled: boolean = isCompiled): string[] {
	return compiled ? [process.execPath, ADAPTER_COMMAND, script] : [bun, script];
}

/** Environment that makes the compiled binary behave as the `bun` it embeds; only for `bun install --ignore-scripts`, which starts no children. */
export const BUN_BE_BUN_ENV: Readonly<Record<string, string>> = { BUN_BE_BUN: "1" };
