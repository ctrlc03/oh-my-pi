/**
 * Web Push through the paired companion: the browser subscribes with the
 * companion's VAPID key and hands it the subscription; the companion pushes on
 * needs-input and turn-finished edges. iOS offers push only to an installed
 * (home-screen) app, from 16.4 on.
 */

import { useCallback, useEffect, useState } from "react";
import type { CompanionClient, PushSubscriptionJson } from "./companion";
import { decodeBase64Url, encodeBase64Url } from "./link";

export type PushStatus = "unsupported" | "off" | "on" | "busy" | "denied";

export interface PushControl {
	status: PushStatus;
	/** Endpoint of this device's live subscription, for companion presence. */
	endpoint: string | null;
	error: string | null;
	toggle(): void;
}

function supported(): boolean {
	return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function subscriptionJson(sub: PushSubscription): PushSubscriptionJson {
	return sub.toJSON() as PushSubscriptionJson;
}

function keyOf(sub: PushSubscription): string | null {
	const key = sub.options.applicationServerKey;
	return key ? encodeBase64Url(new Uint8Array(key)) : null;
}

export function usePush(client: CompanionClient | null, vapidKey: string | null): PushControl {
	const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
	const [subscription, setSubscription] = useState<PushSubscription | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// `ready` settles once the worker activates (first launch included) and never
	// in dev, where the Bun dev server serves no worker: push stays unsupported there.
	useEffect(() => {
		if (!supported()) return;
		void navigator.serviceWorker.ready.then(setRegistration);
	}, []);

	// Pick up an existing subscription. One made under a since-rotated companion
	// key can never be delivered: drop it. A current one is re-registered, so a
	// companion that lost its state file learns it again.
	useEffect(() => {
		if (!registration || !client || !vapidKey) return;
		let cancelled = false;
		void registration.pushManager.getSubscription().then(async sub => {
			if (cancelled) return;
			if (sub && keyOf(sub) !== vapidKey) {
				await sub.unsubscribe();
				sub = null;
			}
			setSubscription(sub);
			if (sub) client.setPush(subscriptionJson(sub), true).catch(() => {});
		});
		return () => {
			cancelled = true;
		};
	}, [registration, client, vapidKey]);

	const toggle = useCallback((): void => {
		if (!registration || !client || !vapidKey || busy) return;
		setBusy(true);
		setError(null);
		const run = async (): Promise<void> => {
			if (subscription) {
				await client.setPush(subscriptionJson(subscription), false).catch(() => {});
				await subscription.unsubscribe();
				setSubscription(null);
				return;
			}
			// First await: the permission prompt needs the tap's user activation.
			if ((await Notification.requestPermission()) !== "granted") return;
			const sub = await registration.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: new Uint8Array(decodeBase64Url(vapidKey) as Uint8Array),
			});
			try {
				await client.setPush(subscriptionJson(sub), true);
			} catch (err) {
				await sub.unsubscribe();
				throw err;
			}
			setSubscription(sub);
		};
		run()
			.catch(err => setError(err instanceof Error ? err.message : String(err)))
			.finally(() => setBusy(false));
	}, [registration, client, vapidKey, busy, subscription]);

	let status: PushStatus;
	if (!registration || !client || !vapidKey) status = "unsupported";
	else if (busy) status = "busy";
	else if (subscription) status = "on";
	else if (Notification.permission === "denied") status = "denied";
	else status = "off";
	return { status, endpoint: subscription?.endpoint ?? null, error, toggle };
}
