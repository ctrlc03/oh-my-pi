import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { ComputerHandle } from "../../lib/computers";
import { subscribeRoute } from "../../lib/notify-route";
import { type PersonalRoute, parsePersonalRoute, personalHostOf } from "../../lib/personal";
import { openPersonalSettings, ROUTE_TABS } from "../../lib/personal-ui";
import { usePersonal } from "../../lib/use-personal";
import { InboxSheet } from "./InboxSheet";

/** A route that arrived before the home computer was known is held this long (a cold launch from a notification). */
const PENDING_MS = 15_000;

export interface PersonalRoutesProps {
	computers: readonly ComputerHandle[];
	onOpenHost(computerId: string, instanceId: string): Promise<void>;
}

/**
 * Where the Personal agent's routes go (`#personal`, `#personal/inbox`, `#personal/memory`, `#personal/about`,
 * `#personal/settings`: a Web Push names one in its `open`). The thread opens the live Personal session, the inbox opens
 * the merged inbox, the rest land on a tab of Settings → Personal agent. Renders nothing until a route arrives, and
 * does nothing without a Personal agent.
 */
export function PersonalRoutes({ computers, onOpenHost }: PersonalRoutesProps): ReactNode {
	const personal = usePersonal();
	const [pending, setPending] = useState<PersonalRoute | null>(null);
	const [inbox, setInbox] = useState(false);
	const homeId = personal.home.computer?.id ?? null;
	const host = personal.home.computer === null ? null : personalHostOf(personal.home.computer.snap.hosts);

	useEffect(
		() =>
			subscribeRoute(route => {
				const parsed = parsePersonalRoute(route);
				if (parsed !== null) setPending(parsed);
			}),
		[],
	);

	useEffect(() => {
		if (pending === null) return;
		if (homeId === null) {
			const timer = setTimeout(() => setPending(null), PENDING_MS);
			return () => clearTimeout(timer);
		}
		if (pending === "inbox") {
			setInbox(true);
			setPending(null);
		} else if (pending === "thread") {
			// The live session is listed once the computer answers; until then keep waiting, and settle for the tab on timeout.
			if (host !== null) {
				setPending(null);
				void onOpenHost(homeId, host.instanceId).catch(() => openPersonalSettings("agent"));
				return;
			}
			const timer = setTimeout(() => {
				setPending(null);
				openPersonalSettings("agent");
			}, 3_000);
			return () => clearTimeout(timer);
		} else {
			setPending(null);
			openPersonalSettings(ROUTE_TABS[pending] ?? "agent");
		}
	}, [pending, homeId, host, onOpenHost]);

	return inbox ? <InboxSheet computers={computers} onOpenHost={onOpenHost} onClose={() => setInbox(false)} /> : null;
}
