import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SANDBOX_EXEC, type SandboxPaths, sandboxedPids, sandboxProfile } from "../scripts/companion-sandbox";

const canRun = process.platform === "darwin" && (await Bun.file(SANDBOX_EXEC).exists());

let base: string;
let paths: SandboxPaths;

/** Exit code of `sh -c script` under the generated profile. */
async function sandboxed(script: string): Promise<number> {
	const proc = Bun.spawn([SANDBOX_EXEC, "-p", sandboxProfile(paths), "/bin/sh", "-c", script], {
		stdout: "ignore",
		stderr: "ignore",
	});
	return await proc.exited;
}

beforeAll(async () => {
	base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "companion-sandbox-")));
	const home = path.join(base, "home dir");
	paths = {
		folder: path.join(base, "work (1)"),
		home,
		configDir: path.join(home, ".omp"),
		// Not the real temp dir, which contains `base`: everything under it would be writable.
		tmpDir: path.join(base, "tmp"),
		companionState: path.join(home, ".omp", "agent", "collab-companion.json"),
	};
	for (const dir of [
		paths.folder,
		path.join(paths.folder, ".git"),
		path.join(paths.folder, "sub", ".git"),
		path.join(home, ".ssh"),
		path.join(paths.configDir, "agent", "sessions"),
	]) {
		await fs.mkdir(dir, { recursive: true });
	}
	await fs.writeFile(path.join(home, ".ssh", "id_ed25519"), "key\n");
	await fs.writeFile(paths.companionState, "{}\n");
	await fs.writeFile(path.join(paths.folder, "notes.txt"), "notes\n");
});

afterAll(async () => {
	await fs.rm(base, { recursive: true, force: true });
});

describe.skipIf(!canRun)("sandboxProfile under sandbox-exec", () => {
	const q = (p: string) => `'${p}'`;

	it("lets the session edit its folder and omp write its state", async () => {
		expect(await sandboxed(`echo x >> ${q(path.join(paths.folder, "notes.txt"))}`)).toBe(0);
		expect(await sandboxed(`mkdir -p ${q(path.join(paths.folder, "src", "lib"))}`)).toBe(0);
		expect(await sandboxed(`touch ${q(path.join(paths.configDir, "agent", "sessions", "s.jsonl"))}`)).toBe(0);
		expect(await sandboxed(`touch ${q(path.join(paths.configDir, "agent", "agent.db-wal"))}`)).toBe(0);
	});

	it("keeps writes out of the rest of the disk and omp's config", async () => {
		expect(await sandboxed(`touch ${q(path.join(base, "escape.txt"))}`)).not.toBe(0);
		expect(await sandboxed(`touch ${q(path.join(paths.home, ".zshrc"))}`)).not.toBe(0);
		expect(await sandboxed(`touch ${q(path.join(paths.configDir, "agent", "config.yml"))}`)).not.toBe(0);
		expect(await sandboxed(`mkdir ${q(path.join(paths.configDir, "agent", "extensions"))}`)).not.toBe(0);
	});

	it("keeps code-running config inside the folder read-only, at any depth", async () => {
		expect(await sandboxed(`touch ${q(path.join(paths.folder, ".git", "hooks-pre-commit"))}`)).not.toBe(0);
		expect(await sandboxed(`touch ${q(path.join(paths.folder, "sub", ".git", "config"))}`)).not.toBe(0);
		expect(await sandboxed(`mkdir ${q(path.join(paths.folder, ".omp"))}`)).not.toBe(0);
		expect(await sandboxed(`touch ${q(path.join(paths.folder, "sub", ".envrc"))}`)).not.toBe(0);
		// Same prefix, different name: an ordinary file.
		expect(await sandboxed(`touch ${q(path.join(paths.folder, ".gitignore"))}`)).toBe(0);
	});

	it("hides credentials and the companion's pairing key", async () => {
		expect(await sandboxed(`cat ${q(path.join(paths.folder, "notes.txt"))}`)).toBe(0);
		expect(await sandboxed(`cat ${q(path.join(paths.home, ".ssh", "id_ed25519"))}`)).not.toBe(0);
		expect(await sandboxed(`cat ${q(paths.companionState)}`)).not.toBe(0);
	});
});

describe("sandboxProfile", () => {
	it("refuses a folder that would put the home or omp config dir in reach", () => {
		expect(() => sandboxProfile({ ...paths, folder: paths.home })).toThrow();
		expect(() => sandboxProfile({ ...paths, folder: path.dirname(paths.home) })).toThrow();
		expect(() => sandboxProfile({ ...paths, folder: path.join(paths.configDir, "agent") })).toThrow();
	});

	it("refuses paths a profile string cannot hold", () => {
		expect(() => sandboxProfile({ ...paths, folder: path.join(base, 'a")(allow file-write*') })).toThrow();
		expect(() => sandboxProfile({ ...paths, folder: path.join(base, "a\nb") })).toThrow();
	});
});

describe("sandboxedPids", () => {
	it("matches the overlay as a whole --config argument only", async () => {
		const overlay = path.join(base, "sandbox.yml");
		// Children stay alive reading their (never-closed) stdin until killed.
		const spawn = (config: string) =>
			Bun.spawn(["bun", "-e", "await Bun.stdin.text()", "--", "--config", config, "-r", "x"], {
				stdin: "pipe",
				stdout: "ignore",
				stderr: "ignore",
			});
		const exact = spawn(overlay);
		const longer = spawn(`${overlay}.bak`);
		try {
			const found = await sandboxedPids([exact.pid, longer.pid], overlay);
			expect([...found]).toEqual([exact.pid]);
		} finally {
			exact.kill();
			longer.kill();
		}
	});
});
