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

export function electronExecutable(): string {
	const dist = electronDist();
	return process.platform === "darwin"
		? path.join(dist, "Electron.app", "Contents", "MacOS", "Electron")
		: path.join(dist, process.platform === "win32" ? "electron.exe" : "electron");
}
