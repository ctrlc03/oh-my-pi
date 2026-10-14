import { describe, expect, it } from "bun:test";
import {
	checkoutCommand,
	companionEnv,
	companionPath,
	installerStateFile,
	ompCandidates,
	ompCommand,
	parseInstallerState,
	type ResolveDeps,
	resolveCompanion,
	searchDirs,
} from "../src/main/companion-resolve";

describe("parseInstallerState", () => {
	it("reads the path the installer recorded", () => {
		expect(parseInstallerState("path=/home/u/.local/bin/omp\nsha256=abc\nsource=x\n")).toBe("/home/u/.local/bin/omp");
	});
	it("ignores a missing, empty or relative path", () => {
		expect(parseInstallerState(null)).toBeNull();
		expect(parseInstallerState("sha256=abc\n")).toBeNull();
		expect(parseInstallerState("path=omp\n")).toBeNull();
	});
	it("finds the file where the installer writes it", () => {
		expect(installerStateFile("/h", {})).toBe("/h/.local/share/omp-collab/install");
		expect(installerStateFile("/h", { XDG_DATA_HOME: "/x" })).toBe("/x/omp-collab/install");
	});
});

describe("ompCandidates", () => {
	const base = { home: "/h", settingsPath: null, installerState: null, platform: "darwin" as const };

	it("orders OMP_BIN, settings, the installer's path, then the usual places", () => {
		const list = ompCandidates({
			...base,
			env: { OMP_BIN: "/a/omp", PATH: "/usr/bin:/bin" },
			settingsPath: "/b/omp",
			installerState: "path=/c/omp\n",
		});
		expect(list.map(c => [c.source, c.path])).toEqual([
			["env", "/a/omp"],
			["settings", "/b/omp"],
			["installer", "/c/omp"],
			["search", "/h/.local/bin/omp"],
			["search", "/usr/bin/omp"],
			["search", "/bin/omp"],
			["search", "/opt/homebrew/bin/omp"],
			["search", "/usr/local/bin/omp"],
			["search", "/h/.bun/bin/omp"],
		]);
	});

	it("lists each path once and skips relative ones", () => {
		const list = ompCandidates({
			...base,
			env: { OMP_BIN: "/h/.local/bin/omp", PATH: "relative:/usr/bin" },
			installerState: "path=/h/.local/bin/omp\n",
		});
		expect(list.filter(c => c.path === "/h/.local/bin/omp").length).toBe(1);
		expect(list.some(c => c.path.startsWith("relative"))).toBe(false);
	});
});

describe("environment", () => {
	it("builds the companion's PATH like the service definitions do", () => {
		expect(
			companionPath({ omp: "/h/.local/bin/omp", home: "/h", callerPath: "/usr/bin:/bin", platform: "darwin" }),
		).toBe("/h/.local/bin:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin:/h/.bun/bin:/usr/sbin:/sbin");
		expect(searchDirs("/h", undefined, "linux")).toEqual(["/h/.local/bin", "/usr/local/bin", "/h/.bun/bin"]);
	});

	it("drops Electron's variables and names the omp it runs", () => {
		const env = companionEnv(
			{ HOME: "/h", ELECTRON_RUN_AS_NODE: "1", ELECTRON_FOO: "x", PI_CONFIG_DIR: ".t", PATH: "/usr/bin" },
			ompCommand("/h/.local/bin/omp"),
			"/h",
			"darwin",
		);
		expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
		expect(env.ELECTRON_FOO).toBeUndefined();
		expect(env.PI_CONFIG_DIR).toBe(".t");
		expect(env.OMP_BIN).toBe("/h/.local/bin/omp");
		expect(env.PATH?.startsWith("/h/.local/bin:")).toBe(true);
	});

	it("leaves OMP_BIN alone for a checkout", () => {
		const env = companionEnv({ OMP_BIN: "/mine/omp" }, checkoutCommand("/repo", "/bun"), "/h", "darwin");
		expect(env.OMP_BIN).toBe("/mine/omp");
	});
});

describe("resolveCompanion", () => {
	const input = { env: { PATH: "/usr/bin" }, home: "/h", settingsPath: null, platform: "darwin" as const };
	const deps = (over: {
		runnable?: string[];
		companion?: string[];
		readInstallerState?: ResolveDeps["readInstallerState"];
		checkout?: ResolveDeps["checkout"];
	}): ResolveDeps => ({
		runnable: async file => (over.runnable ?? []).includes(file),
		hasCompanion: async file => (over.companion ?? []).includes(file),
		readInstallerState: over.readInstallerState ?? (async () => null),
		checkout: over.checkout ?? (async () => null),
	});

	it("runs the first omp that exists and has the companion", async () => {
		const result = await resolveCompanion(
			input,
			deps({ runnable: ["/usr/bin/omp", "/h/.local/bin/omp"], companion: ["/usr/bin/omp"] }),
		);
		expect(result).toEqual({ ok: true, command: ompCommand("/usr/bin/omp") });
	});

	it("skips an omp without the companion and says so when nothing is left", async () => {
		const result = await resolveCompanion(input, deps({ runnable: ["/usr/bin/omp"], companion: [] }));
		expect(result).toEqual({ ok: false, tried: ["/usr/bin/omp (no companion)"] });
	});

	it("lists where it looked when there is no omp at all", async () => {
		const result = await resolveCompanion(input, deps({}));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.tried).toContain("/h/.local/bin/omp");
	});

	it("prefers an unpackaged app's checkout", async () => {
		const checkout = checkoutCommand("/repo", "/bun");
		const result = await resolveCompanion(
			input,
			deps({ checkout: async () => checkout, runnable: ["/usr/bin/omp"], companion: ["/usr/bin/omp"] }),
		);
		expect(result).toEqual({ ok: true, command: checkout });
		expect(checkout.argv).toEqual(["/bun", "/repo/packages/collab-web/scripts/companion.ts"]);
	});

	it("uses the installer's recorded path", async () => {
		const result = await resolveCompanion(
			input,
			deps({ readInstallerState: async () => "path=/opt/omp\n", runnable: ["/opt/omp"], companion: ["/opt/omp"] }),
		);
		expect(result).toEqual({ ok: true, command: ompCommand("/opt/omp") });
	});
});
