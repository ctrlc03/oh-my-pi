import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	ADAPTER_COMMAND,
	adapterLauncher,
	BUN_BE_BUN_ENV,
	COMPANION_COMMAND,
	FOREIGN_HOST_COMMAND,
	foreignHostLauncher,
	isCompiled,
	selfCommand,
} from "../scripts/build-identity";

const SCRIPTS = path.join(import.meta.dir, "..", "scripts");

describe("build identity", () => {
	it("runs from a checkout under bun tests", () => {
		expect(isCompiled).toBe(false);
	});

	it("starts the companion from its script in a checkout", async () => {
		const [exe, script] = selfCommand();
		expect(exe).toBe(process.execPath);
		expect(script).toBe(path.join(SCRIPTS, "companion.ts"));
		expect(await Bun.file(script).exists()).toBe(true);
	});

	it("starts the companion as a subcommand of the compiled binary", () => {
		expect(selfCommand(true)).toEqual([process.execPath, COMPANION_COMMAND]);
		expect(COMPANION_COMMAND).toBe("companion");
	});

	it("starts a foreign host from host-main.ts in a checkout", async () => {
		const [exe, script] = foreignHostLauncher();
		expect(exe).toBe(process.execPath);
		expect(script).toBe(path.join(SCRIPTS, "foreign", "host-main.ts"));
		expect(await Bun.file(script).exists()).toBe(true);
	});

	it("starts a foreign host as the internal subcommand of the compiled binary", () => {
		expect(foreignHostLauncher(true)).toEqual([process.execPath, FOREIGN_HOST_COMMAND]);
		expect(FOREIGN_HOST_COMMAND).toBe("__collab-foreign-host");
	});

	it("makes the compiled binary act as bun only for the install", () => {
		expect(BUN_BE_BUN_ENV).toEqual({ BUN_BE_BUN: "1" });
	});

	it("runs an adapter script under bun in a checkout and through the binary's own subcommand when compiled", () => {
		expect(adapterLauncher("/usr/bin/bun", "/a/index.js")).toEqual(["/usr/bin/bun", "/a/index.js"]);
		expect(adapterLauncher("/usr/bin/bun", "/a/index.js", true)).toEqual([
			process.execPath,
			ADAPTER_COMMAND,
			"/a/index.js",
		]);
		expect(ADAPTER_COMMAND).toBe("__collab-adapter");
	});
});

describe("omp-collab entry", () => {
	it("answers `companion --help` without starting the companion", async () => {
		const proc = Bun.spawn([process.execPath, path.join(SCRIPTS, "omp-collab.ts"), "companion", "--help"], {
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		});
		const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		expect(code).toBe(0);
		expect(out).toContain("Usage: omp companion");
		expect(out).toContain("--install");
		expect(out).toContain("Build: dev (can1357/oh-my-pi)");
	});

	it("runs an adapter script with its own argv and without BUN_BE_BUN for the processes it starts", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-adapter-"));
		try {
			const stub = path.join(dir, "stub.js");
			await Bun.write(
				stub,
				`const child = Bun.spawnSync(["sh", "-c", 'printf %s "\${BUN_BE_BUN-unset}"']);
console.log(JSON.stringify({ argv: process.argv.slice(1), child: child.stdout.toString() }));
`,
			);
			const { BUN_BE_BUN: _unused, ...env } = process.env;
			const proc = Bun.spawn(
				[process.execPath, path.join(SCRIPTS, "omp-collab.ts"), ADAPTER_COMMAND, stub, "--flag", "x"],
				{ stdout: "pipe", stderr: "pipe", stdin: "ignore", env },
			);
			const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
			expect(code).toBe(0);
			expect(JSON.parse(out)).toEqual({ argv: [stub, "--flag", "x"], child: "unset" });
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
