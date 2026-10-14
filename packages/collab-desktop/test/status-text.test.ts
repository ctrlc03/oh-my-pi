import { describe, expect, it } from "bun:test";
import {
	acceleratorLabel,
	companionLine,
	installCommand,
	pageForStatus,
	statusPageHtml,
} from "../src/main/status-text";
import { updateMenuItem } from "../src/main/update-status";

describe("acceleratorLabel", () => {
	it("writes macOS shortcuts with symbols in the system's order", () => {
		expect(acceleratorLabel("CommandOrControl+Alt+O", "darwin")).toBe("⌥⌘O");
		expect(acceleratorLabel("Shift+Control+Space", "darwin")).toBe("⌃⇧Space");
	});
	it("spells them out elsewhere", () => {
		expect(acceleratorLabel("CommandOrControl+Alt+O", "linux")).toBe("Ctrl+Alt+O");
		expect(acceleratorLabel("CommandOrControl+Shift+k", "win32")).toBe("Ctrl+Shift+K");
	});
});

describe("texts", () => {
	it("names the installer for a repository", () => {
		expect(installCommand("ctrlc03/oh-my-pi")).toBe("curl -fsSL https://ctrlc03.github.io/oh-my-pi/install.sh | sh");
	});

	it("describes the companion in a line", () => {
		expect(companionLine({ kind: "attached", endpoint: { pid: 1, port: 7467, app: true } })).toContain(
			"running elsewhere",
		);
		expect(companionLine({ kind: "restarting", attempt: 2, delayMs: 2000, reason: "x" })).toBe(
			"Companion: restarting in 2 s",
		);
		expect(companionLine({ kind: "unavailable", reason: "no-omp", message: "", tried: [] })).toContain(
			"not installed",
		);
	});

	it("escapes what the status page shows", () => {
		const html = statusPageHtml("<b>", 'a & "b"');
		expect(html).not.toContain("<b>");
		expect(html).toContain("&#60;b&#62;");
		expect(pageForStatus({ kind: "starting" }).title).toContain("Starting");
	});
});

describe("updateMenuItem", () => {
	it("offers a check, shows progress, and offers the restart once ready", () => {
		expect(updateMenuItem({ kind: "idle" })).toEqual({ label: "Check for Updates…", enabled: true, action: "check" });
		expect(updateMenuItem({ kind: "downloading", tag: "t", percent: 40 })).toMatchObject({
			enabled: false,
			label: "Downloading Update… 40%",
		});
		expect(updateMenuItem({ kind: "ready", tag: "collab-v1.2.3-1" })).toMatchObject({
			action: "restart",
			label: "Restart to Update to collab-v1.2.3-1",
		});
		expect(updateMenuItem({ kind: "unsupported", reason: "dev" })).toBeNull();
	});
});
