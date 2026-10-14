/**
 * The desktop app (`packages/collab-desktop`) shows this same web app in its own window and hands it
 * `window.ompDesktop`: a save dialog, and a way to tell the shell what the sessions are doing (menu-bar icon,
 * native notifications) and to be told which session to open. Everything here is gated on that object being there, so
 * a browser tab runs exactly as before. The shape below is the part of the desktop package's bridge this app uses
 * (`packages/collab-desktop/src/shared/bridge.ts`); the shell validates whatever it receives.
 */
import type { ComputerHandle } from "./computers";

export type DesktopActivity = "input" | "working" | "idle";

export interface DesktopSession {
	computerId: string;
	instanceId: string;
	title: string;
	computerName: string | null;
	activity: DesktopActivity;
}

export interface DesktopReport {
	sessions: DesktopSession[];
	/** Paired computers whose session list is current. */
	computersLive: number;
	/** The ids of those computers. */
	liveComputerIds?: string[];
	computersTotal: number;
}

export interface DesktopBridge {
	saveFile(name: string, data: Uint8Array): Promise<"saved" | "cancelled">;
	reportSessions(report: DesktopReport): void;
	onOpenSession(handler: (target: { computerId: string; instanceId: string }) => void): () => void;
}

/** The bridge the desktop shell exposes, or null in a browser. `host` is where `ompDesktop` lives (the window). */
export function getDesktop(host: object = globalThis): DesktopBridge | null {
	const bridge: unknown = Reflect.get(host, "ompDesktop");
	if (typeof bridge !== "object" || bridge === null) return null;
	const saveFile = Reflect.get(bridge, "saveFile");
	const reportSessions = Reflect.get(bridge, "reportSessions");
	const onOpenSession = Reflect.get(bridge, "onOpenSession");
	if (typeof saveFile !== "function" || typeof reportSessions !== "function" || typeof onOpenSession !== "function")
		return null;
	return {
		saveFile: (name, data) => saveFile.call(bridge, name, data),
		reportSessions: report => reportSessions.call(bridge, report),
		onOpenSession: handler => onOpenSession.call(bridge, handler),
	};
}

/**
 * What the shell is told: every session of the computers whose list is current, as needing input, working or idle,
 * with the title the app shows for it (`titleOf`).
 */
export function desktopReport(
	computers: readonly ComputerHandle[],
	titleOf: (host: ComputerHandle["snap"]["hosts"][number]) => string,
): DesktopReport {
	const sessions: DesktopSession[] = [];
	const liveComputerIds: string[] = [];
	for (const computer of computers) {
		if (computer.snap.phase !== "live") continue;
		liveComputerIds.push(computer.id);
		for (const host of computer.snap.hosts) {
			sessions.push({
				computerId: computer.id,
				instanceId: host.instanceId,
				title: titleOf(host),
				computerName: computer.name,
				activity: host.inputRequired ? "input" : host.busy === true ? "working" : "idle",
			});
		}
	}
	return { sessions, computersLive: liveComputerIds.length, liveComputerIds, computersTotal: computers.length };
}
