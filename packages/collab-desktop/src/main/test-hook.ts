import type { CompanionStatus } from "./companion-supervisor";
import type { UpdateStatus } from "./update-status";

export interface Diagnostics {
	companion: CompanionStatus;
	appOrigin: string | null;
	tray: { state: string; tooltip: string; waiting: number };
	notifications: { title: string; body: string }[];
	shortcut: { accelerator: string; registered: boolean };
	window: { visible: boolean; focused: boolean; url: string } | null;
	update: UpdateStatus;
	paths: { dataDir: string; configDir: string; companionLog: string };
}

/** What `OMP_DESKTOP_TEST=1` exposes on `globalThis.__ompDesktop` for the end-to-end smoke test. */
export interface TestHook {
	diagnostics(): Diagnostics;
	toggleWindow(): void;
	checkForUpdates(): Promise<void>;
	trayMenu(): string[];
}

declare global {
	var __ompDesktop: TestHook | undefined;
	/** Set by the smoke test: URLs the app asked the system to open, and the options of the last save dialog. */
	var __opened: string[] | undefined;
	var __saveOptions: unknown;
}
