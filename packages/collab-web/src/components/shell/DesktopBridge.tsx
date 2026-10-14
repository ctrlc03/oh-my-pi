import type { ReactNode } from "react";
import { useEffect, useMemo } from "react";
import type { ComputerHandle } from "../../lib/computers";
import { desktopReport, getDesktop } from "../../lib/desktop";
import { hostTitle } from "./CompanionCard";

export interface DesktopBridgeProps {
	computers: readonly ComputerHandle[];
	/** The shell asks for a session (menu-bar item, notification click). */
	onOpen(computerId: string, instanceId: string): void;
}

/**
 * Renders nothing. In the desktop app it reports what the sessions are doing to the shell, which shows it in the
 * menu-bar icon and in native notifications, and opens the session the shell asks for. In a browser it does nothing.
 */
export function DesktopBridge({ computers, onOpen }: DesktopBridgeProps): ReactNode {
	const desktop = useMemo(() => getDesktop(), []);
	const report = useMemo(() => (desktop === null ? null : desktopReport(computers, hostTitle)), [desktop, computers]);
	// The host list changes with every poll; the shell only needs to hear when the picture does.
	const signature = report === null ? "" : JSON.stringify(report);

	useEffect(() => {
		if (desktop === null || report === null) return;
		desktop.reportSessions(report);
		// `signature` stands for `report`: a new array with the same content is not a change.
	}, [desktop, signature]);

	useEffect(() => desktop?.onOpenSession(target => onOpen(target.computerId, target.instanceId)), [desktop, onOpen]);

	return null;
}
