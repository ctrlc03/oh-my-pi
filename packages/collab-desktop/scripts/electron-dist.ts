import * as fs from "node:fs";
import * as path from "node:path";

const electronPackage = path.join(import.meta.dir, "..", "..", "..", "node_modules", "electron");

/**
 * The directory holding `Electron.app` (or the platform's equivalent) of the installed `electron` package.
 * Bun does not run `electron`'s postinstall (it is not a trusted dependency), so the first call downloads the binary
 * with the package's own installer.
 */
export function electronDist(): string {
	const dist = path.join(electronPackage, "dist");
	if (!fs.existsSync(path.join(dist, "version"))) {
		const result = Bun.spawnSync(["node", path.join(electronPackage, "install.js")], {
			stdio: ["inherit", "inherit", "inherit"],
		});
		if (result.exitCode !== 0) throw new Error("downloading the Electron binary failed");
	}
	return dist;
}

/** The version of the installed `electron` package: what a build for another platform downloads, with no host binary. */
export function electronVersion(): string {
	const manifest: unknown = JSON.parse(fs.readFileSync(path.join(electronPackage, "package.json"), "utf8"));
	if (
		typeof manifest === "object" &&
		manifest !== null &&
		"version" in manifest &&
		typeof manifest.version === "string"
	)
		return manifest.version;
	throw new Error("the electron package has no version");
}

export function electronExecutable(): string {
	const dist = electronDist();
	return process.platform === "darwin"
		? path.join(dist, "Electron.app", "Contents", "MacOS", "Electron")
		: path.join(dist, process.platform === "win32" ? "electron.exe" : "electron");
}
