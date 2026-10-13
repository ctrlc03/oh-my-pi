#!/usr/bin/env bun
/**
 * Compile the fork's standalone omp binary (regular omp plus `omp companion`) for one target.
 *
 *   bun scripts/build-collab-binary.ts --target <darwin-arm64|darwin-x64|linux-x64|linux-arm64> [--outdir <dir>]
 *
 * Output: `<outdir>/omp-<target>` (default outdir `dist/collab/`). The binary embeds the production build of the collab web
 * app (the same pipeline as the Pages build, minus the analytics beacon), which its companion serves on the loopback
 * relay's port. The target's pi_natives addon(s) must already
 * sit in `packages/natives/native/` (`OMP_NATIVE_CARGO_PROFILE=ci bun scripts/bazel-natives.ts host` builds the
 * host's; x64 hosts honor `OMP_NATIVE_X64_VARIANT=baseline|modern`). Same compile as `ci-release-build-binaries.ts`
 * (`compileCodingAgent`, embedded natives, stats bundle, tool views), with the collab entry point.
 *
 * Environment:
 *   OMP_RELEASE_REPO  GitHub repository `omp update` follows (default ctrlc03/oh-my-pi; CI passes ${{ github.repository }}).
 *   OMP_BUILD_TAG     release tag the binary is built for, `collab-v<version>-<n>` (default `dev`, which every release outranks).
 *
 * On a darwin host a darwin target is ad-hoc signed with the omp entitlements, as in the upstream release build.
 */

import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { compileCodingAgent } from "../packages/coding-agent/scripts/compile-binary";
import { parseForkTag } from "../packages/coding-agent/src/cli/fork-release";
import { buildApp } from "../packages/collab-web/scripts/build-app";
import { embeddedAppFiles } from "../packages/collab-web/scripts/local-app-embed";

interface CollabTarget {
	readonly platform: string;
	readonly arch: string;
	readonly target: Bun.Build.CompileTarget;
}

/** Targets the fork ships: no musl, no Windows. */
const TARGETS: Readonly<Record<string, CollabTarget>> = {
	"darwin-arm64": { platform: "darwin", arch: "arm64", target: "bun-darwin-arm64" },
	"darwin-x64": { platform: "darwin", arch: "x64", target: "bun-darwin-x64" },
	"linux-x64": { platform: "linux", arch: "x64", target: "bun-linux-x64-baseline" },
	"linux-arm64": { platform: "linux", arch: "arm64", target: "bun-linux-arm64" },
};

const DEFAULT_RELEASE_REPO = "ctrlc03/oh-my-pi";
const DEV_BUILD_TAG = "dev";

const repoRoot = path.join(import.meta.dir, "..");

function argValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

async function runCommand(command: string[]): Promise<void> {
	const proc = Bun.spawn(command, { cwd: repoRoot, stdout: "inherit", stderr: "inherit" });
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`);
}

/** Validate the tag: `dev`, or `collab-v<version>-<n>` with the version of the package being built. */
function checkBuildTag(tag: string, packageVersion: string): void {
	if (tag === DEV_BUILD_TAG) return;
	const parsed = parseForkTag(tag);
	if (!parsed) throw new Error(`OMP_BUILD_TAG "${tag}" is not "${DEV_BUILD_TAG}" or collab-v<version>-<n>`);
	if (parsed.version !== packageVersion) {
		throw new Error(`OMP_BUILD_TAG ${tag} names version ${parsed.version} but the package is ${packageVersion}`);
	}
}

async function main(): Promise<void> {
	const targetId = argValue("--target");
	const target = targetId === undefined ? undefined : TARGETS[targetId];
	if (targetId === undefined || target === undefined) {
		throw new Error(`--target <${Object.keys(TARGETS).join("|")}> is required`);
	}
	const outdir = path.resolve(argValue("--outdir") ?? path.join(repoRoot, "dist", "collab"));
	const outfile = path.join(outdir, `omp-${targetId}`);
	const repo = process.env.OMP_RELEASE_REPO || DEFAULT_RELEASE_REPO;
	const tag = process.env.OMP_BUILD_TAG || DEV_BUILD_TAG;

	const require = createRequire(import.meta.url);
	const transformersManifest: { version?: unknown } = require("@huggingface/transformers/package.json");
	if (typeof transformersManifest.version !== "string") {
		throw new Error("@huggingface/transformers package manifest has no string version");
	}
	const agentManifest: { version: string } = require("../packages/coding-agent/package.json");
	checkBuildTag(tag, agentManifest.version);

	const adhocSign = target.platform === "darwin" && process.platform === "darwin";
	const appDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-app-"));
	// Generate inside the try so the finally restores the empty checked-in placeholders even when a step throws.
	try {
		await runCommand(["bun", "run", "gen:stats"]);
		await runCommand(["bun", "--cwd=packages/collab-web", "run", "gen:tool-views"]);
		await buildApp(appDir, { local: true });
		const app = await embeddedAppFiles(appDir);
		console.log(
			`Embedding the web app (${(app.rawBytes / 1048576).toFixed(1)} MiB, ${(app.storedBytes / 1048576).toFixed(1)} MiB stored)`,
		);
		console.log(`Building ${outfile} (${repo} @ ${tag})...`);
		await compileCodingAgent({
			repoRoot,
			entrypoint: path.join(repoRoot, "packages", "collab-web", "scripts", "omp-collab.ts"),
			outfile,
			transformersVersion: transformersManifest.version,
			native: target,
			target: target.target,
			minifyIdentifiers: true,
			skipBuiltinCodesign: adhocSign,
			release: { repo, tag },
			extraFiles: app.overrides,
		});
		// Bun 1.3.12 emits a truncated Mach-O signature on darwin builds.
		if (adhocSign) {
			await runCommand([
				"codesign",
				"--force",
				"--sign",
				"-",
				"--entitlements",
				path.join(repoRoot, "scripts", "macos-entitlements.plist"),
				outfile,
			]);
		}
	} finally {
		await fs.rm(appDir, { recursive: true, force: true });
		await runCommand(["bun", "run", "gen:stats:reset"]);
	}
	console.log(outfile);
}

await main();
