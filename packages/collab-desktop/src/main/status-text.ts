/** Plain-language texts for the menu, the tray and the window while there is no app to show. */
import type { CompanionStatus } from "./companion-supervisor";

/** `curl … | sh` for a repository's installer (served from its GitHub Pages site, like the fork's `omp update` hint). */
export function installCommand(repo: string): string {
	const [owner, name] = repo.split("/");
	return `curl -fsSL https://${owner}.github.io/${name}/install.sh | sh`;
}

/** One line for the Companion menu. */
export function companionLine(status: CompanionStatus): string {
	switch (status.kind) {
		case "stopped":
			return "Companion: not running";
		case "starting":
			return "Companion: starting…";
		case "attached":
			return `Companion: running elsewhere (port ${status.endpoint.port})`;
		case "running":
			return `Companion: started by this app (port ${status.endpoint.port})`;
		case "restarting":
			return `Companion: restarting in ${Math.ceil(status.delayMs / 1000)} s`;
		case "unavailable":
			return status.reason === "no-omp" ? "Companion: omp is not installed" : "Companion: another one is in the way";
	}
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"]/g, ch => `&#${ch.charCodeAt(0)};`);
}

/** What the window shows while the companion is not serving the app yet: a title and a line, nothing to click. */
export function statusPageHtml(title: string, body: string): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>omp collab</title>
<style>html,body{height:100%;margin:0}body{display:grid;place-items:center;font:15px/1.5 system-ui,sans-serif}main{max-width:30rem;padding:0 1.5rem;text-align:center}h1{font-size:1.15rem;margin:0 0 .5rem}p{margin:0;opacity:.7;word-break:break-word}</style>
</head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main></body></html>`;
}

/** The status page for a companion that is not serving yet. */
export function pageForStatus(status: CompanionStatus): { title: string; body: string } {
	switch (status.kind) {
		case "restarting":
			return {
				title: "The companion stopped",
				body: `It stopped (${status.reason}). Starting it again in ${Math.ceil(status.delayMs / 1000)} s.`,
			};
		case "unavailable":
			return {
				title: status.reason === "no-omp" ? "omp is not installed" : "The companion is not available",
				body: status.message,
			};
		default:
			return {
				title: "Starting the companion…",
				body: "The app opens as soon as this computer's companion is ready.",
			};
	}
}

const MAC_KEYS: Record<string, string> = {
	commandorcontrol: "⌘",
	cmdorctrl: "⌘",
	command: "⌘",
	cmd: "⌘",
	super: "⌘",
	control: "⌃",
	ctrl: "⌃",
	alt: "⌥",
	option: "⌥",
	shift: "⇧",
};

const OTHER_KEYS: Record<string, string> = {
	commandorcontrol: "Ctrl",
	cmdorctrl: "Ctrl",
	command: "Cmd",
	cmd: "Cmd",
	super: "Super",
	control: "Ctrl",
	ctrl: "Ctrl",
	alt: "Alt",
	option: "Alt",
	shift: "Shift",
};

/** An Electron accelerator as a person reads it: `⌥⌘O` on macOS, `Ctrl+Alt+O` elsewhere. */
export function acceleratorLabel(accelerator: string, platform: NodeJS.Platform): string {
	const mac = platform === "darwin";
	const table = mac ? MAC_KEYS : OTHER_KEYS;
	const parts = accelerator.split("+").map(part => {
		const key = part.trim();
		const mapped = table[key.toLowerCase()];
		return mapped ?? (key.length === 1 ? key.toUpperCase() : key);
	});
	if (!mac) return parts.join("+");
	// macOS lists the modifiers in the order ⌃⌥⇧⌘, then the key.
	const order = ["⌃", "⌥", "⇧", "⌘"];
	const mods = parts.filter(part => order.includes(part)).sort((a, b) => order.indexOf(a) - order.indexOf(b));
	return [...mods, ...parts.filter(part => !order.includes(part))].join("");
}
