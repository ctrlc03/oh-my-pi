/**
 * Packages the app for macOS: an ad-hoc signed `omp collab.app`, plus `collab-desktop-darwin-<arch>.zip` (what the
 * installer and the self-updater download) and `.dmg` in `release/`.
 *
 *   bun scripts/package.ts [--dir] [--arch arm64|x64] [--tag collab-v18.10.4-1] [--repo owner/name]
 *
 * `--dir` stops after the signed `.app`. `--tag` (or OMP_BUILD_TAG) is the release this build belongs to; without one the
 * app is a development build that never updates itself. The asset names must not start with `omp-`: the release workflow
 * counts and checksums `omp-*` as the compiled binaries.
 *
 * The app is built from a staging directory outside the workspace: electron-builder collects the production
 * dependencies of the nearest `node_modules`, and inside this monorepo that is every package of the checkout, none of
 * which the bundled app uses (everything it needs is in `dist/`).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Arch, build, Platform } from "electron-builder";
import { electronDist } from "./electron-dist";

const root = path.join(import.meta.dir, "..");
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
	const at = args.indexOf(name);
	return at >= 0 ? args[at + 1] : undefined;
};
const dirOnly = args.includes("--dir");
const archName = flag("--arch") ?? process.arch;
if (archName !== "arm64" && archName !== "x64") throw new Error(`unsupported --arch ${archName}`);
const tag = flag("--tag") ?? process.env.OMP_BUILD_TAG ?? "";
const repo = flag("--repo") ?? process.env.OMP_RELEASE_REPO ?? "";
if (process.platform !== "darwin") throw new Error("packaging is implemented for macOS only");

const PRODUCT = "omp collab";
const BUNDLE_ID = "sh.omp.collab.desktop";
const releaseDir = path.join(root, "release");
fs.rmSync(releaseDir, { recursive: true, force: true });

const built = Bun.spawnSync([process.execPath, path.join(root, "scripts", "build.ts")], {
	env: { ...process.env, OMP_BUILD_TAG: tag, OMP_RELEASE_REPO: repo },
	stdio: ["inherit", "inherit", "inherit"],
});
if (built.exitCode !== 0) process.exit(built.exitCode ?? 1);

const dist = electronDist();
const electronVersion = fs.readFileSync(path.join(dist, "version"), "utf8").trim();
const manifest: unknown = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version =
	typeof manifest === "object" && manifest !== null && "version" in manifest && typeof manifest.version === "string"
		? manifest.version
		: "0.0.0";

const stage = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "omp-collab-desktop-"));
fs.cpSync(path.join(root, "dist"), path.join(stage, "dist"), { recursive: true });
fs.cpSync(path.join(root, "assets"), path.join(stage, "assets"), { recursive: true });
fs.cpSync(path.join(root, "build"), path.join(stage, "build"), { recursive: true });
fs.writeFileSync(
	path.join(stage, "package.json"),
	`${JSON.stringify({ name: "omp-collab-desktop", productName: PRODUCT, version, description: "omp collab desktop app", author: "ctrlc03", main: "dist/main.cjs" }, null, "\t")}\n`,
);

/** electron-builder (identity: null) leaves the bundle with a signature its own edits invalidated; sign it ad hoc, the whole bundle at once. */
function adHocSign(appPath: string): void {
	const result = Bun.spawnSync(["codesign", "--force", "--deep", "--sign", "-", appPath]);
	if (result.exitCode !== 0) throw new Error(`codesign failed: ${result.stderr.toString()}`);
}

try {
	await build({
		projectDir: stage,
		targets: Platform.MAC.createTarget(dirOnly ? "dir" : "zip", archName === "arm64" ? Arch.arm64 : Arch.x64),
		publish: "never",
		config: {
			appId: BUNDLE_ID,
			productName: PRODUCT,
			electronVersion,
			electronDist: dist,
			directories: { output: releaseDir, buildResources: path.join(stage, "build") },
			files: ["dist/**", "assets/**", "package.json"],
			npmRebuild: false,
			nodeGypRebuild: false,
			artifactName: `collab-desktop-darwin-\${arch}.\${ext}`,
			afterPack: async context => {
				adHocSign(path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`));
			},
			mac: {
				identity: null,
				category: "public.app-category.developer-tools",
				icon: path.join(stage, "build", "icon.icns"),
				hardenedRuntime: false,
				gatekeeperAssess: false,
				darkModeSupport: true,
				extendInfo: {
					OmpBuildTag: tag,
					NSMicrophoneUsageDescription: "omp collab uses the microphone when you dictate a prompt.",
					NSCameraUsageDescription: "omp collab uses the camera when you scan a pairing code.",
				},
			},
		},
	});
} finally {
	fs.rmSync(stage, { recursive: true, force: true });
}

const appDir = fs
	.readdirSync(releaseDir)
	.map(name => path.join(releaseDir, name))
	.find(dir => fs.existsSync(path.join(dir, `${PRODUCT}.app`)));
if (appDir === undefined) throw new Error("electron-builder produced no app bundle");
const appPath = path.join(appDir, `${PRODUCT}.app`);

if (!dirOnly) {
	// A plain disk image with the app and an Applications shortcut: hdiutil ships with macOS, so no helper download.
	const staging = path.join(releaseDir, "dmg-staging");
	fs.mkdirSync(staging, { recursive: true });
	const copied = Bun.spawnSync(["ditto", appPath, path.join(staging, `${PRODUCT}.app`)]);
	if (copied.exitCode !== 0) throw new Error(`ditto failed: ${copied.stderr.toString()}`);
	fs.symlinkSync("/Applications", path.join(staging, "Applications"));
	const dmg = path.join(releaseDir, `collab-desktop-darwin-${archName}.dmg`);
	const made = Bun.spawnSync([
		"hdiutil",
		"create",
		"-volname",
		PRODUCT,
		"-srcfolder",
		staging,
		"-ov",
		"-format",
		"UDZO",
		dmg,
	]);
	fs.rmSync(staging, { recursive: true, force: true });
	if (made.exitCode !== 0) throw new Error(`hdiutil failed: ${made.stderr.toString()}`);
}

console.log(`packaged ${appPath}`);
for (const name of fs.readdirSync(releaseDir))
	if (name.startsWith("collab-desktop-")) console.log(`  ${path.join(releaseDir, name)}`);
