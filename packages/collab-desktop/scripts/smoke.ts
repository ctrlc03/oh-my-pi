/**
 * End-to-end smoke test: launches the real Electron app against a throw-away HOME (the collab-web e2e harness: a
 * private tmux server, a scripted model, the companion on its own port) and drives it with Playwright's Electron
 * support. Nothing here touches `~/.omp`, the user's tmux or the companion on port 7467.
 *
 *   bun scripts/smoke.ts [--out <dir>]                                   # the development app (`electron .`), companion from the checkout
 *   bun scripts/smoke.ts --packaged <omp collab.app> --omp <compiled omp> [--out <dir>]   # a packaged app and a compiled omp
 *
 * What it checks: the app starts its own companion and pairs its window; a relaunch does not pair again; the
 * menu-bar state and a native notification follow a scripted report and a real session that asks a question; the
 * global shortcut is registered and the window toggles; the bridge's save goes through the native dialog path; a
 * crashed companion is restarted; quitting stops the companion the app started; a companion that is already running is
 * attached to, not duplicated, and survives the app; "keep running" leaves the companion up. Screenshots go to `--out`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { createE2eHome } from "../../collab-web/scripts/e2e-home";
import { type StubReply, type StubRequest, startStubModel } from "../../collab-web/scripts/stub-model";
import { isRecord } from "../src/main/guards";
import type { Diagnostics } from "../src/main/test-hook";
import type { OmpDesktopBridge, ReportedSession } from "../src/shared/bridge";
import { electronExecutable } from "./electron-dist";

declare global {
	interface Window {
		ompDesktop?: OmpDesktopBridge;
	}
}

const root = path.join(import.meta.dir, "..");
const repoRoot = path.join(root, "..", "..");
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
	const at = args.indexOf(name);
	return at >= 0 ? args[at + 1] : undefined;
};
const packagedApp = flag("--packaged");
const compiledOmp = flag("--omp");
const outDir = path.resolve(flag("--out") ?? path.join(os.tmpdir(), "omp-desktop-smoke"));
fs.mkdirSync(outDir, { recursive: true });
if (packagedApp !== undefined && compiledOmp === undefined) throw new Error("--packaged needs --omp <a compiled omp>");

const executablePath =
	packagedApp === undefined
		? electronExecutable()
		: path.join(packagedApp, "Contents", "MacOS", fs.readdirSync(path.join(packagedApp, "Contents", "MacOS"))[0]!);

let failures = 0;
async function step(name: string, body: () => Promise<void>): Promise<void> {
	try {
		await body();
		console.log(`PASS ${name}`);
	} catch (err) {
		failures++;
		console.log(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function until<T>(
	what: string,
	probe: () => Promise<T | null | undefined | false> | T | null | undefined | false,
	timeoutMs = 60_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const value = await probe();
			if (value) return value;
		} catch {
			// not yet
		}
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(200);
	}
}

/** The command line of a process, or null when it is gone: how every kill below checks it is killing what it started. */
function commandOf(pid: number): string | null {
	const result = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)]);
	const text = result.stdout.toString().trim();
	return result.exitCode === 0 && text !== "" ? text : null;
}

/** The scripted model: the first prompt containing ASK makes the session ask the user a question. */
function responder(request: StubRequest): StubReply {
	const asked = request.messages.some(message => message.toolCalls.some(call => call.name === "ask"));
	if (request.lastUser.includes("ASK") && !asked && request.tools.includes("ask")) {
		return {
			toolCalls: [
				{
					name: "ask",
					arguments: {
						questions: [
							{ id: "pick", question: "Which database?", options: [{ label: "SQLite" }, { label: "Postgres" }] },
						],
					},
				},
			],
		};
	}
	return { text: "ok" };
}

const stub = startStubModel({ responder });
// The sessions the smoke test starts need a relay to host on, and omp's public one is unreachable here: the companion's own
// loopback relay is a relay too, so both settings name the same private port.
const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
const relayPort = probe.port;
probe.stop(true);
const e2e = await createE2eHome({
	stubUrl: stub.url,
	localRelayPort: relayPort,
	relayUrl: `ws://127.0.0.1:${relayPort}`,
});
const dataDir = path.join(e2e.root, "desktop-data");
const savedFile = path.join(e2e.root, "saved", "notes.txt");
const env: Record<string, string> = {
	...e2e.env,
	OMP_DESKTOP_DATA_DIR: dataDir,
	OMP_DESKTOP_TEST: "1",
	...(compiledOmp === undefined ? {} : { OMP_BIN: compiledOmp }),
};
const endpointFile = path.join(e2e.configDir, "agent", "collab-companion-local.json");
const stateFile = path.join(e2e.configDir, "agent", "collab-companion.json");
const companionCommand =
	compiledOmp === undefined
		? [process.execPath, path.join(repoRoot, "packages", "collab-web", "scripts", "companion.ts")]
		: [compiledOmp, "companion"];

interface Launched {
	app: ElectronApplication;
	diag: () => Promise<Diagnostics>;
	page: () => Promise<Page>;
	/** Make the window visible or hidden, waiting for it to exist and for the change to land. */
	showWindow: (visible: boolean) => Promise<void>;
}

const launched: ElectronApplication[] = [];
async function launch(): Promise<Launched> {
	const app = await electron.launch({
		executablePath,
		args: packagedApp === undefined ? [root] : [],
		env,
		timeout: 90_000,
	});
	launched.push(app);
	await until("the test hook", () => app.evaluate(() => globalThis.__ompDesktop !== undefined));
	return {
		app,
		diag: () => app.evaluate(() => globalThis.__ompDesktop!.diagnostics()),
		page: async () => {
			const window = await app.firstWindow();
			await window.waitForLoadState("domcontentloaded");
			return window;
		},
		showWindow: async visible => {
			const state = () => app.evaluate(() => globalThis.__ompDesktop!.diagnostics().window?.visible);
			await until("the window", async () => (await state()) !== undefined);
			// A visible window that is not focused is brought to the front by the first toggle and hidden by the second.
			for (let toggles = 0; toggles < 3 && (await state()) !== visible; toggles++) {
				await app.evaluate(() => globalThis.__ompDesktop!.toggleWindow());
				await Bun.sleep(400);
			}
			await until(visible ? "a visible window" : "a hidden window", async () => (await state()) === visible);
		},
	};
}

/** Quit the way the Quit item does and wait for the process to exit. */
async function quit(app: ElectronApplication): Promise<void> {
	const child = app.process();
	const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
	await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => {});
	await Promise.race([exited, Bun.sleep(20_000)]);
	check(child.exitCode !== null || child.signalCode !== null, "the app did not exit");
}

function readEndpoint(): { pid: number; port: number; app: boolean } | null {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(endpointFile, "utf8"));
		return isRecord(parsed) && typeof parsed.pid === "number" && typeof parsed.port === "number"
			? { pid: parsed.pid, port: parsed.port, app: parsed.app === true }
			: null;
	} catch {
		return null;
	}
}

function deviceCount(): number {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(stateFile, "utf8"));
		return isRecord(parsed) && Array.isArray(parsed.devices) ? parsed.devices.length : 0;
	} catch {
		return 0;
	}
}

const session = (activity: ReportedSession["activity"]): ReportedSession => ({
	computerId: "scripted",
	instanceId: "s1",
	title: "fix the login bug",
	computerName: "laptop",
	activity,
});

try {
	// ── 1. the app starts its own companion and pairs ───────────────────────
	let first = await launch();
	let companionPid = 0;
	let port = 0;
	await step("starts its own companion on a private port and loads the app", async () => {
		const state = await until("a running companion", async () => {
			const d = await first.diag();
			return d.companion.kind === "running" ? d.companion : null;
		});
		companionPid = state.pid;
		port = state.endpoint.port;
		check(port !== 7467, "the companion took port 7467");
		check(port === e2e.localRelayPort, `expected port ${e2e.localRelayPort}, got ${port}`);
		check(readEndpoint()?.pid === companionPid, "the endpoint file does not name the companion the app started");
		check(commandOf(companionPid) !== null, "the companion is not running");
		const page = await first.page();
		await until("the app origin", async () => page.url().startsWith(`http://127.0.0.1:${port}/`));
	});

	await step("pairs the window with the companion, once", async () => {
		const page = await first.page();
		const stored = await until("a paired computer in the window's storage", async () => {
			const value = await page.evaluate(() => window.localStorage.getItem("omp.collab.computers"));
			return value !== null && value.includes('"token"') ? value : null;
		});
		const roomId = fs.readFileSync(stateFile, "utf8").match(/"roomId":\s*"([^"]+)"/)?.[1];
		check(roomId !== undefined && stored.includes(roomId), "the stored computer is not this companion's room");
		check(deviceCount() === 1, `expected one paired device, found ${deviceCount()}`);
		await Bun.sleep(4_000);
		await page.screenshot({ path: path.join(outDir, "01-paired-window.png") });
		console.log(
			`  window text: ${JSON.stringify((await page.evaluate(() => document.body.innerText)).slice(0, 160))}`,
		);
	});

	await step("exposes the bridge to the app origin and nothing more", async () => {
		const page = await first.page();
		const shape = await page.evaluate(() => ({
			keys: window.ompDesktop === undefined ? null : Object.keys(window.ompDesktop).sort(),
			require: typeof Reflect.get(window, "require"),
			process: typeof Reflect.get(window, "process"),
		}));
		check(
			JSON.stringify(shape.keys) ===
				JSON.stringify(["onOpenSession", "platform", "reportSessions", "saveFile", "version"]),
			`bridge keys: ${JSON.stringify(shape.keys)}`,
		);
		check(shape.require === "undefined" && shape.process === "undefined", "node globals leaked into the page");
	});

	await step("opens external links in the browser, not in the window", async () => {
		const page = await first.page();
		await first.app.evaluate(({ shell }) => {
			globalThis.__opened = [];
			Object.assign(shell, {
				openExternal: async (url: string) => {
					globalThis.__opened?.push(url);
				},
			});
		});
		const before = page.url();
		await page.evaluate(() => window.open("https://example.com/a", "_blank"));
		await page.evaluate(() => location.assign("https://example.org/b"));
		await Bun.sleep(800);
		const calls = await first.app.evaluate(() => globalThis.__opened);
		check(
			calls?.includes("https://example.com/a") && calls.includes("https://example.org/b"),
			`external opens: ${JSON.stringify(calls)}`,
		);
		check(page.url() === before, `the window navigated to ${page.url()}`);
	});

	// ── 2. menu-bar state and notifications ─────────────────────────────────
	await step("hides the window, then a scripted report changes the tray and notifies", async () => {
		const page = await first.page();
		await first.showWindow(false);
		const report = (sessions: ReportedSession[], live: number) =>
			page.evaluate(r => window.ompDesktop!.reportSessions(r), { sessions, computersLive: live, computersTotal: 1 });
		await report([session("working")], 1);
		await until("tray working", async () => (await first.diag()).tray.state === "working");
		await report([session("input")], 1);
		const d = await until("tray input", async () => {
			const current = await first.diag();
			return current.tray.state === "input" ? current : null;
		});
		check(d.tray.waiting === 1, "waiting count");
		check(
			d.notifications.some(n => n.title === "fix the login bug" && n.body.startsWith("Needs your input")),
			`notifications: ${JSON.stringify(d.notifications)}`,
		);
		const menu = await first.app.evaluate(() => globalThis.__ompDesktop!.trayMenu());
		check(
			menu[0] === "1 session needs your input" && menu[1]!.startsWith("fix the login bug"),
			`tray menu: ${JSON.stringify(menu)}`,
		);
		await report([session("idle")], 1);
		await until("tray idle", async () => (await first.diag()).tray.state === "idle");
		await report([], 0);
		await until("tray offline", async () => (await first.diag()).tray.state === "offline");
		await page.evaluate(() => window.ompDesktop!.reportSessions(JSON.parse('{"sessions":"garbage"}')));
		await Bun.sleep(300);
		check((await first.diag()).tray.state === "offline", "a malformed report changed the tray");
	});

	await step("the global shortcut is registered and toggling brings the window back", async () => {
		const d = await first.diag();
		check(d.shortcut.registered, `shortcut ${d.shortcut.accelerator} is not registered (another app may hold it)`);
		await first.showWindow(true);
	});

	await step("a real session that asks a question turns the tray to needs-input and notifies", async () => {
		const page = await first.page();
		const roomId = fs.readFileSync(stateFile, "utf8").match(/"roomId":\s*"([^"]+)"/)?.[1];
		await page.evaluate(r => window.ompDesktop!.reportSessions(r), {
			sessions: [],
			computersLive: 1,
			liveComputerIds: roomId === undefined ? [] : [roomId],
			computersTotal: 1,
		});
		const overlay = path.join(e2e.root, "overlay.yml");
		fs.writeFileSync(overlay, `collab:\n  autoStart: control\n  localRelayUrl: "ws://127.0.0.1:${port}"\n`);
		const work = path.join(e2e.root, "project");
		fs.mkdirSync(work, { recursive: true });
		await first.showWindow(false);
		const before = (await first.diag()).notifications.length;
		const started = await e2e.tmux.run([
			"new-session",
			"-d",
			"-s",
			"omp-smoke",
			"-c",
			work,
			`${e2e.ompBin} --config ${overlay} 'ASK me something'`,
		]);
		check(started.code === 0, `tmux: ${started.err}`);
		const d = await until(
			"a waiting session",
			async () => {
				const current = await first.diag();
				return current.tray.state === "input" ? current : null;
			},
			90_000,
		).catch(async err => {
			console.log(
				`  tmux pane:\n${(await e2e.tmux.capture("omp-smoke").catch(() => "(no pane)")).split("\n").filter(Boolean).slice(-12).join("\n")}`,
			);
			throw err;
		});
		check(d.notifications.length > before, "no notification for the real session");
		console.log(`  real session: ${d.tray.tooltip}; notification: ${JSON.stringify(d.notifications.at(-1))}`);
		// Best effort: macOS may not allow a capture of the menu bar without the Screen Recording permission.
		const { width } = await first.app.evaluate(({ screen }) => screen.getPrimaryDisplay().bounds);
		Bun.spawnSync([
			"screencapture",
			"-x",
			"-R",
			`${width - 560},0,560,34`,
			path.join(outDir, "menu-bar-needs-input.png"),
		]);
		await first.showWindow(true);
		await Bun.sleep(1_500);
		await page.screenshot({ path: path.join(outDir, "02-session-needs-input.png") });
	});

	// ── 3. saving a file ────────────────────────────────────────────────────
	await step("saves a file through the native save dialog path", async () => {
		const page = await first.page();
		fs.mkdirSync(path.dirname(savedFile), { recursive: true });
		await first.app.evaluate(({ dialog }, file) => {
			Object.assign(dialog, {
				showSaveDialog: async (...given: unknown[]) => {
					globalThis.__saveOptions = given.at(-1);
					return { canceled: false, filePath: file };
				},
			});
		}, savedFile);
		const outcome = await page.evaluate(() =>
			window.ompDesktop!.saveFile("../../notes.txt", new TextEncoder().encode("hello from the app")),
		);
		check(outcome === "saved", `outcome ${outcome}`);
		check(fs.readFileSync(savedFile, "utf8") === "hello from the app", "the file's content");
		const options = await first.app.evaluate(() => globalThis.__saveOptions);
		const defaultPath = isRecord(options) && typeof options.defaultPath === "string" ? options.defaultPath : "";
		check(path.basename(defaultPath) === "notes.txt" && !defaultPath.includes(".."), `default path ${defaultPath}`);
		await first.app.evaluate(({ dialog }) => {
			Object.assign(dialog, { showSaveDialog: async () => ({ canceled: true, filePath: "" }) });
		});
		check(
			(await page.evaluate(() => window.ompDesktop!.saveFile("x.txt", new Uint8Array([1])))) === "cancelled",
			"cancel",
		);
	});

	// ── 4. a crashed companion is restarted ─────────────────────────────────
	await step("restarts the companion after a crash", async () => {
		check(
			commandOf(companionPid)?.includes("companion") ?? false,
			`pid ${companionPid} is not the companion we started: ${commandOf(companionPid)}`,
		);
		process.kill(companionPid, "SIGKILL");
		const next = await until(
			"a new companion",
			async () => {
				const current = (await first.diag()).companion;
				return current.kind === "running" && current.pid !== companionPid ? current : null;
			},
			90_000,
		);
		companionPid = next.pid;
		check(commandOf(companionPid) !== null, "the new companion is not running");
	});

	// ── 5. quitting stops the companion the app started ─────────────────────
	await step("quitting stops the companion it started, and a relaunch does not pair again", async () => {
		await quit(first.app);
		await until("the companion to stop", () => commandOf(companionPid) === null, 20_000);
		const left = readEndpoint();
		check(left === null || commandOf(left.pid) === null, "the endpoint file still names a live process");
		const devices = deviceCount();
		first = await launch();
		const running = await until("a running companion", async () => {
			const c = (await first.diag()).companion;
			return c.kind === "running" ? c : null;
		});
		const page = await first.page();
		await until("the app", async () => page.url().startsWith("http://127.0.0.1:"));
		await Bun.sleep(5_000);
		check(deviceCount() === devices, `a second device was paired (${devices} → ${deviceCount()})`);
		companionPid = running.pid;
		await quit(first.app);
		await until("the companion to stop", () => commandOf(companionPid) === null, 20_000);
	});

	// ── 6. an existing companion is attached to, not duplicated ─────────────
	await step("attaches to a companion that is already running and leaves it running", async () => {
		const external = Bun.spawn(companionCommand, { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		try {
			await until("the external companion", () => readEndpoint()?.pid === external.pid, 90_000);
			const second = await launch();
			const attached = await until("attached", async () => {
				const c = (await second.diag()).companion;
				return c.kind === "attached" ? c : null;
			});
			check(attached.endpoint.pid === external.pid, "attached to a different companion");
			const page = await second.page();
			await until("the app", async () => page.url().startsWith(`http://127.0.0.1:${attached.endpoint.port}/`));
			await page.screenshot({ path: path.join(outDir, "03-attached.png") });
			await quit(second.app);
			await Bun.sleep(1_500);
			check(
				commandOf(external.pid) !== null && readEndpoint()?.pid === external.pid,
				"the app stopped a companion it did not start",
			);
		} finally {
			if (commandOf(external.pid) !== null) external.kill("SIGTERM");
			await external.exited;
		}
	});

	// ── 7. keep running after quit ──────────────────────────────────────────
	await step("leaves its companion running when 'keep running' is on", async () => {
		fs.mkdirSync(dataDir, { recursive: true });
		fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({ keepCompanionRunning: true }));
		const third = await launch();
		const running = await until("a running companion", async () => {
			const c = (await third.diag()).companion;
			return c.kind === "running" ? c : null;
		});
		const pid = running.pid;
		await quit(third.app);
		try {
			await Bun.sleep(2_000);
			check(commandOf(pid) !== null, "the companion stopped");
			check(readEndpoint()?.pid === pid, "the endpoint is gone");
		} finally {
			if (commandOf(pid) !== null) process.kill(pid, "SIGTERM");
			await until("the companion to stop", () => commandOf(pid) === null, 20_000);
			fs.rmSync(path.join(dataDir, "settings.json"), { force: true });
		}
	});
} finally {
	for (const app of launched) await app.close().catch(() => {});
	await Bun.write(path.join(outDir, "companion.log"), Bun.file(path.join(dataDir, "logs", "companion.log"))).catch(
		() => {},
	);
	await e2e.tmux.killServer().catch(() => {});
	await stub.stop();
	await e2e.cleanup().catch(() => {});
}

console.log(failures === 0 ? "smoke: all steps passed" : `smoke: ${failures} step(s) failed`);
process.exit(failures === 0 ? 0 : 1);
