/**
 * Runs before the page, in the sandbox, and exposes the whole of the page's reach into the shell as
 * `window.ompDesktop` (see `../shared/bridge.ts`). Three calls; the main process checks who is calling and what
 * they sent, so this file only forwards.
 */
import { contextBridge, ipcRenderer } from "electron";
import {
	BRIDGE_VERSION,
	CHANNELS,
	type OmpDesktopBridge,
	type OpenSessionTarget,
	type SaveOutcome,
	type SessionReport,
} from "../shared/bridge";

const handlers = new Set<(target: OpenSessionTarget) => void>();

ipcRenderer.on(CHANNELS.openSession, (_event, target: OpenSessionTarget) => {
	for (const handler of handlers) handler(target);
});

const bridge: OmpDesktopBridge = {
	version: BRIDGE_VERSION,
	platform: process.platform,
	saveFile: (name: string, data: Uint8Array): Promise<SaveOutcome> =>
		ipcRenderer.invoke(CHANNELS.saveFile, name, data),
	reportSessions: (report: SessionReport): void => {
		ipcRenderer.send(CHANNELS.reportSessions, report);
	},
	onOpenSession: handler => {
		handlers.add(handler);
		return () => {
			handlers.delete(handler);
		};
	},
};

contextBridge.exposeInMainWorld("ompDesktop", bridge);
