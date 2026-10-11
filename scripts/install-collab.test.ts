import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

/**
 * Drives scripts/install-collab.sh the way `curl | sh` does (the script arrives on stdin, with
 * no controlling terminal) against a release directory served over local HTTP. `omp` is a
 * shell stub that records its calls, so nothing here touches launchd, systemd, or the user's
 * home: HOME, PI_INSTALL_DIR and PI_CONFIG_DIR all point into a temp dir, and PATH holds only
 * system directories plus stubs for tmux, git and the browser opener.
 */

const installer = path.join(import.meta.dir, "install-collab.sh");
const OS = process.platform === "darwin" ? "darwin" : "linux";
const ARCH = process.arch === "arm64" ? "arm64" : "x64";
const ASSET = `omp-${OS}-${ARCH}`;
const PAIR_URL = "https://example.test/app/#pair:room.key&invite=once";

function stubOmp(version: string): string {
	return `#!/bin/sh
echo "$*" >>"$HOME/calls.log"
state="$HOME/stub"
mkdir -p "$state"
case "$1 $2" in
"--version "*) echo "${version}" ;;
"config set") echo "$3=$4" >>"$state/config" ;;
"models --json") if [ -e "$state/logged-in" ]; then echo '{"models":[{"id":"m"}]}'; else echo '{"models":[]}'; fi ;;
"companion --install")
	if [ -e "$state/fail-service" ]; then echo "systemd is not available" >&2; exit 1; fi
	echo "omp collab companion"
	echo "pair a device: scan the code or open ${PAIR_URL}"
	if [ "$3" = "--dry-run" ]; then echo "dry run: would write plist"; else touch "$state/service"; fi ;;
"companion --pair") echo "pair a device: scan the code or open ${PAIR_URL}" ;;
"companion --uninstall") rm -f "$state/service"; echo "service removed" ;;
"login "*|"login ") touch "$state/logged-in" ;;
*) echo "stub: unexpected $*" >&2; exit 2 ;;
esac
`;
}

const tempDirs: string[] = [];
let server: Bun.Server<undefined>;
const served = new Map<string, string | Uint8Array>();

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		fetch(req) {
			const name = new URL(req.url).pathname.slice(1);
			const body = served.get(name);
			return body === undefined ? new Response("not found", { status: 404 }) : new Response(body);
		},
	});
});

afterAll(() => {
	server.stop(true);
});

afterEach(async () => {
	served.clear();
	await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

/** Publishes `omp-<os>-<arch>` and its SHA256SUMS.txt (a wrong hash with `badSum`). */
async function publish(version: string, opts: { badSum?: boolean; noEntry?: boolean } = {}): Promise<void> {
	const binary = stubOmp(version);
	const sum = opts.badSum ? "0".repeat(64) : new Bun.CryptoHasher("sha256").update(binary).digest("hex");
	served.set(ASSET, binary);
	served.set("SHA256SUMS.txt", opts.noEntry ? `${sum}  omp-other\n` : `${sum}  ${ASSET}\n`);
}

interface Sandbox {
	home: string;
	prefix: string;
	bin: string;
	env: Record<string, string>;
}

async function sandbox(): Promise<Sandbox> {
	const home = await mkdtemp(path.join(tmpdir(), "omp-install-test-"));
	tempDirs.push(home);
	const bin = path.join(home, "fakebin");
	const prefix = path.join(home, "prefix");
	await mkdir(bin, { recursive: true });
	const logging = (name: string) =>
		writeFile(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >>"$HOME/${name}.log"\n`, { mode: 0o755 });
	await Promise.all(["tmux", "git", "open", "xdg-open"].map(logging));
	return {
		home,
		prefix,
		bin,
		env: {
			HOME: home,
			PI_INSTALL_DIR: prefix,
			PI_CONFIG_DIR: path.join(home, "config"),
			PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
			TMPDIR: home,
			OMP_COLLAB_BASE_URL: `http://127.0.0.1:${server.port}`,
			NO_COLOR: "1",
		},
	};
}

/** Runs the installer with the script on stdin and no controlling terminal, like `curl | sh`. */
async function run(box: Sandbox, args: string[], env: Record<string, string> = {}, insecure = true) {
	const proc = Bun.spawn(["sh", "-s", "--", ...(insecure ? ["--insecure-base-url"] : []), ...args], {
		env: { ...box.env, ...env },
		stdin: new Response(await readFile(installer, "utf8")),
		stdout: "pipe",
		stderr: "pipe",
		detached: true,
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, code, all: stdout + stderr };
}

async function read(file: string): Promise<string> {
	return readFile(file, "utf8").catch(() => "");
}

async function exists(file: string): Promise<boolean> {
	return stat(file).then(
		() => true,
		() => false,
	);
}

/** Makes `https://github.com/ctrlc03/oh-my-pi/releases/...` reach the local server and records curl's flags. */
async function githubShim(box: Sandbox): Promise<void> {
	const script = `#!/bin/sh
echo "$*" >>"$HOME/curl.log"
n=$#
skip=0
while [ "$n" -gt 0 ]; do
	a="$1"; shift; n=$((n - 1))
	if [ "$skip" = 1 ]; then skip=0; continue; fi
	case "$a" in
	--proto | --proto-redir) skip=1; continue ;;
	--tlsv1.2) continue ;;
	https://github.com/ctrlc03/oh-my-pi/releases/*/*) a="http://127.0.0.1:${server.port}/\${a##*/}" ;;
	esac
	set -- "$@" "$a"
done
exec /usr/bin/curl "$@"
`;
	await writeFile(path.join(box.bin, "curl"), script, { mode: 0o755 });
}

describe("install-collab.sh", () => {
	it("installs, configures, installs the service and opens the pairing link", async () => {
		const box = await sandbox();
		await publish("1.0.0");
		const result = await run(box, ["--yes"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("checksum verified");
		expect(result.stdout).toContain(PAIR_URL);
		const omp = path.join(box.prefix, "omp");
		expect((await stat(omp)).mode & 0o111).not.toBe(0);
		expect(await read(path.join(box.home, "stub", "config"))).toBe(
			"collab.webUrl=https://ctrlc03.github.io/oh-my-pi/\n",
		);
		expect(await exists(path.join(box.home, "stub", "service"))).toBe(true);
		expect(await read(path.join(box.home, "calls.log"))).toContain("companion --install");
		const opener = OS === "darwin" ? "open.log" : "xdg-open.log";
		expect(await read(path.join(box.home, opener))).toContain(PAIR_URL);
		expect(await read(path.join(box.home, ".local", "share", "omp-collab", "install"))).toContain(`path=${omp}`);
	});

	it("refuses a checksum mismatch and installs nothing", async () => {
		const box = await sandbox();
		await publish("1.0.0", { badSum: true });
		const result = await run(box, ["--yes"]);

		expect(result.code).not.toBe(0);
		expect(result.all).toContain("checksum mismatch");
		expect(await exists(path.join(box.prefix, "omp"))).toBe(false);
		expect(await exists(path.join(box.home, "stub", "service"))).toBe(false);
	});

	it("refuses when SHA256SUMS.txt has no entry for the asset", async () => {
		const box = await sandbox();
		await publish("1.0.0", { noEntry: true });
		const result = await run(box, ["--yes"]);

		expect(result.code).not.toBe(0);
		expect(result.all).toContain(`no entry for ${ASSET}`);
		expect(await exists(path.join(box.prefix, "omp"))).toBe(false);
	});

	it("refuses a missing release", async () => {
		const box = await sandbox();
		const result = await run(box, ["--yes"]);

		expect(result.code).not.toBe(0);
		expect(await exists(path.join(box.prefix, "omp"))).toBe(false);
	});

	it("updates in place on a re-run without opening the browser again", async () => {
		const box = await sandbox();
		await publish("1.0.0");
		await run(box, ["--yes"]);
		const opener = path.join(box.home, OS === "darwin" ? "open.log" : "xdg-open.log");
		const opened = await read(opener);

		await publish("2.0.0");
		const result = await run(box, ["--yes"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("updated");
		expect(result.stdout).toContain("2.0.0");
		expect(await read(opener)).toBe(opened);
		expect((await read(path.join(box.home, "calls.log"))).match(/companion --install/g)).toHaveLength(2);

		const again = await run(box, ["--yes"]);
		expect(again.stdout).toContain("already the latest");
	});

	it("shows the pairing link again on a re-run with --pair", async () => {
		const box = await sandbox();
		await publish("1.0.0");
		await run(box, ["--yes"]);
		const result = await run(box, ["--yes", "--pair"]);
		expect(result.stdout).toContain(PAIR_URL);
	});

	it("does not replace an omp it did not install without confirmation", async () => {
		const box = await sandbox();
		await publish("1.0.0");
		await mkdir(box.prefix, { recursive: true });
		await writeFile(path.join(box.prefix, "omp"), stubOmp("upstream"), { mode: 0o755 });

		const refused = await run(box, []);
		expect(refused.code).not.toBe(0);
		expect(refused.all).toContain("not replacing");
		expect(await read(path.join(box.prefix, "omp"))).toContain("upstream");

		const replaced = await run(box, ["--yes"]);
		expect(replaced.code).toBe(0);
		expect(await read(path.join(box.prefix, "omp"))).toContain("1.0.0");
	});

	it("says so when another omp is on PATH, and asks before installing next to it", async () => {
		const box = await sandbox();
		await publish("1.0.0");
		await writeFile(path.join(box.bin, "omp"), stubOmp("upstream"), { mode: 0o755 });

		const refused = await run(box, []);
		expect(refused.code).not.toBe(0);
		expect(refused.all).toContain(`another omp is on your PATH: ${path.join(box.bin, "omp")}`);
		expect(await exists(path.join(box.prefix, "omp"))).toBe(false);

		const accepted = await run(box, ["--yes"]);
		expect(accepted.code).toBe(0);
		expect(await exists(path.join(box.prefix, "omp"))).toBe(true);
		expect(await read(path.join(box.bin, "omp"))).toContain("upstream");
	});

	it("skips the service with --no-service and still prints a pairing link", async () => {
		const box = await sandbox();
		await publish("1.0.0");
		const result = await run(box, ["--yes", "--no-service", "--no-open"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain(PAIR_URL);
		const calls = await read(path.join(box.home, "calls.log"));
		expect(calls).not.toContain("companion --install");
		expect(calls).toContain("companion --pair");
		expect(await exists(path.join(box.home, "stub", "service"))).toBe(false);
		expect(await exists(path.join(box.home, "open.log"))).toBe(false);
		expect(await exists(path.join(box.home, "xdg-open.log"))).toBe(false);
	});

	it("reports a failed service install, still pairs, and exits non-zero", async () => {
		const box = await sandbox();
		await publish("1.0.0");
		await mkdir(path.join(box.home, "stub"), { recursive: true });
		await writeFile(path.join(box.home, "stub", "fail-service"), "");
		const result = await run(box, ["--yes", "--no-open"]);

		expect(result.code).not.toBe(0);
		expect(result.all).toContain("systemd is not available");
		expect(result.all).toContain("no background service yet");
		expect(result.stdout).toContain(PAIR_URL);
		expect(await exists(path.join(box.prefix, "omp"))).toBe(true);
	});

	it("prints the service definition with --service-dry-run and installs nothing", async () => {
		const box = await sandbox();
		await publish("1.0.0");
		const result = await run(box, ["--yes", "--service-dry-run"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("dry run: would write plist");
		expect(await exists(path.join(box.home, "stub", "service"))).toBe(false);
	});

	it("skips login when a provider already works and when --no-login is given", async () => {
		const box = await sandbox();
		await publish("1.0.0");
		await mkdir(path.join(box.home, "stub"), { recursive: true });
		await writeFile(path.join(box.home, "stub", "logged-in"), "");
		const result = await run(box, ["--yes"]);
		expect(result.stdout).toContain("already set up");
		expect(await read(path.join(box.home, "calls.log"))).not.toContain("login");

		const other = await sandbox();
		await publish("1.0.0");
		const skipped = await run(other, ["--yes", "--no-login"]);
		expect(skipped.stdout).toContain("--no-login");
		expect(await read(path.join(other.home, "calls.log"))).not.toContain("login");
	});

	it("warns instead of hanging when there is no terminal to log in on", async () => {
		const box = await sandbox();
		await publish("1.0.0");
		const result = await run(box, ["--yes"]);
		expect(result.code).toBe(0);
		expect(result.stderr).toContain("no terminal to log in on");
	});

	it("honours --prefix and --web-url", async () => {
		const box = await sandbox();
		await publish("1.0.0");
		const custom = path.join(box.home, "elsewhere");
		const result = await run(box, ["--yes", "--prefix", custom, "--web-url", "https://app.test/"]);

		expect(result.code).toBe(0);
		expect(await exists(path.join(custom, "omp"))).toBe(true);
		expect(await read(path.join(box.home, "stub", "config"))).toBe("collab.webUrl=https://app.test/\n");
	});

	it("uninstalls the service and, with --yes, the binary", async () => {
		const box = await sandbox();
		await publish("1.0.0");
		await run(box, ["--yes"]);
		const result = await run(box, ["--uninstall", "--yes"]);

		expect(result.code).toBe(0);
		expect(await exists(path.join(box.home, "stub", "service"))).toBe(false);
		expect(await exists(path.join(box.prefix, "omp"))).toBe(false);
		expect(await exists(path.join(box.home, ".local", "share", "omp-collab", "install"))).toBe(false);
	});

	it("keeps the binary on --uninstall without confirmation", async () => {
		const box = await sandbox();
		await publish("1.0.0");
		await run(box, ["--yes"]);
		const result = await run(box, ["--uninstall"]);

		expect(result.code).toBe(0);
		expect(await exists(path.join(box.home, "stub", "service"))).toBe(false);
		expect(await exists(path.join(box.prefix, "omp"))).toBe(true);
	});

	it("rejects unknown options", async () => {
		const box = await sandbox();
		const result = await run(box, ["--bogus"]);
		expect(result.code).not.toBe(0);
		expect(result.all).toContain("unknown option");
	});

	it("refuses a plain-http download source without --insecure-base-url", async () => {
		const box = await sandbox();
		await publish("1.0.0");
		const result = await run(box, ["--yes"], {}, false);

		expect(result.code).not.toBe(0);
		expect(result.all).toContain("downloads must use https://");
		expect(await exists(path.join(box.prefix, "omp"))).toBe(false);
	});

	it("rejects a download source that is not http(s)", async () => {
		const box = await sandbox();
		const result = await run(box, ["--yes", "--base-url", "ftp://example.test/rel"], {}, false);
		expect(result.code).not.toBe(0);
		expect(result.all).toContain("must start with https://");
	});

	describe("with the default GitHub release URL", () => {
		async function githubBox(gh: "none" | "signed-out" | "verifies" | "rejects"): Promise<Sandbox> {
			const box = await sandbox();
			await githubShim(box);
			if (gh !== "none") {
				const status = gh === "signed-out" ? "exit 1" : "exit 0";
				const verify = gh === "rejects" ? 'echo "no matching attestation" >&2; exit 1' : "exit 0";
				await writeFile(
					path.join(box.bin, "gh"),
					[
						"#!/bin/sh",
						'echo "$*" >>"$HOME/gh.log"',
						'case "$1 $2" in',
						`"auth status") ${status} ;;`,
						`"attestation verify") ${verify} ;;`,
						"esac",
						"",
					].join("\n"),
					{ mode: 0o755 },
				);
			}
			await publish("1.0.0");
			return box;
		}
		const env = { OMP_COLLAB_BASE_URL: "" };

		it("fetches over https only and verifies the attestation when gh is signed in", async () => {
			const box = await githubBox("verifies");
			const result = await run(box, ["--yes", "--no-login", "--no-service"], env, false);

			expect(result.code).toBe(0);
			expect(result.stdout).toContain("build attestation verified");
			const curl = await read(path.join(box.home, "curl.log"));
			expect(curl).toContain("--proto =https --proto-redir =https --tlsv1.2");
			expect(curl).toContain("https://github.com/ctrlc03/oh-my-pi/releases/latest/download/SHA256SUMS.txt");
			expect(await read(path.join(box.home, "gh.log"))).toContain("attestation verify");
			expect(await read(path.join(box.home, "gh.log"))).toContain(
				"--repo ctrlc03/oh-my-pi --signer-workflow ctrlc03/oh-my-pi/.github/workflows/collab-release.yml",
			);
		});

		it("refuses a binary whose attestation does not verify", async () => {
			const box = await githubBox("rejects");
			const result = await run(box, ["--yes", "--no-login", "--no-service"], env, false);

			expect(result.code).not.toBe(0);
			expect(result.all).toContain("no matching attestation");
			expect(result.all).toContain("build attestation check failed");
			expect(await exists(path.join(box.prefix, "omp"))).toBe(false);
		});

		it("says so, and still requires the checksum, when gh is missing or signed out", async () => {
			for (const gh of ["none", "signed-out"] as const) {
				const box = await githubBox(gh);
				const result = await run(box, ["--yes", "--no-login", "--no-service"], env, false);
				expect(result.code).toBe(0);
				expect(result.stdout).toContain("build attestation not checked");
				expect(await exists(path.join(box.prefix, "omp"))).toBe(true);
			}
			const bad = await sandbox();
			await githubShim(bad);
			await publish("1.0.0", { badSum: true });
			const refused = await run(bad, ["--yes", "--no-login", "--no-service"], env, false);
			expect(refused.all).toContain("checksum mismatch");
		});
	});
});
