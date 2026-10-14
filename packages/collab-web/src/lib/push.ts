/**
 * Web Push through the paired computers: the browser subscribes with a companion's VAPID key and hands it
 * the subscription; the companion pushes on needs-input and turn-finished edges. iOS offers push only to
 * an installed (home-screen) app, from 16.4 on.
 *
 * A browser ties one push subscription to one server key, and every companion has its own key. So each computer
 * subscribes through its own service worker registration (scope `push/<computer id>/`, see scripts/build-sw.ts),
 * and this device is subscribed with every computer that offers Web Push. A device that subscribed before there
 * could be several computers keeps its subscription on the page's own registration, for the computer that
 * key belongs to.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { PushSubscriptionJson } from "./companion";
import type { ComputerHandle } from "./computers";
import { getDesktop } from "./desktop";
import { decodeBase64Url, encodeBase64Url } from "./link";
import { readJson, writeJson } from "./storage";

export type PushStatus = "unsupported" | "off" | "on" | "busy" | "denied";

export interface PushControl {
	status: PushStatus;
	/** Endpoint of this device's live subscription with the computer, for its presence. */
	endpoint: string | null;
	error: string | null;
	toggle(): void;
}

/** Computers whose notifications the user turned off on this device: a new subscription is never made for them unasked. */
const OFF_KEY = "omp.collab.push-off";

/** The desktop app has no push service to subscribe to; its shell shows notifications itself (see `./desktop`). */
function supported(): boolean {
	return getDesktop() === null && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function subscriptionJson(sub: PushSubscription): PushSubscriptionJson {
	return sub.toJSON() as PushSubscriptionJson;
}

function keyOf(sub: PushSubscription): string | null {
	const key = sub.options.applicationServerKey;
	return key ? encodeBase64Url(new Uint8Array(key)) : null;
}

function loadOff(): string[] {
	const raw = readJson(OFF_KEY);
	return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
}

function setOff(id: string, off: boolean): void {
	const rest = loadOff().filter(other => other !== id);
	writeJson(OFF_KEY, off ? [...rest, id] : rest.length > 0 ? rest : null);
}

/** The registration that is active (a fresh one installs first); subscribing needs an active worker. */
async function active(registration: ServiceWorkerRegistration): Promise<ServiceWorkerRegistration> {
	const worker = registration.installing ?? registration.waiting ?? registration.active;
	if (worker === null || worker.state === "activated") return registration;
	const { promise, resolve } = Promise.withResolvers<void>();
	worker.addEventListener("statechange", () => {
		if (worker.state === "activated") resolve();
	});
	await promise;
	return registration;
}

/**
 * The registration this computer's subscription lives on: the page's own when a subscription made under this
 * computer's key is already there, else this computer's own scope.
 */
export async function registrationFor(
	own: ServiceWorkerRegistration,
	computerId: string,
	vapidKey: string,
): Promise<ServiceWorkerRegistration> {
	const legacy = await own.pushManager.getSubscription();
	if (legacy !== null && keyOf(legacy) === vapidKey) return own;
	const scoped = await navigator.serviceWorker.register("./sw.js", {
		scope: `./push/${computerId}/`,
		updateViaCache: "none",
	});
	return active(scoped);
}

interface Entry {
	subscription: PushSubscription | null;
	busy: boolean;
	error: string | null;
}

const NONE: Entry = { subscription: null, busy: false, error: null };

export interface PushControls {
	of(computerId: string): PushControl;
}

/** What a computer needs for push: its connection and its application server key, once it has listed hosts. */
function pushable(
	computer: ComputerHandle,
): computer is ComputerHandle & { client: NonNullable<ComputerHandle["client"]> } {
	return computer.client !== null && computer.snap.vapidKey !== null;
}

export function usePush(computers: readonly ComputerHandle[]): PushControls {
	const [own, setOwn] = useState<ServiceWorkerRegistration | null>(null);
	const [entries, setEntries] = useState<Record<string, Entry>>({});
	const entryOf = (id: string): Entry => (Object.hasOwn(entries, id) ? entries[id]! : NONE);
	const patch = useCallback((id: string, next: Partial<Entry>): void => {
		setEntries(prev => ({ ...prev, [id]: { ...(Object.hasOwn(prev, id) ? prev[id]! : NONE), ...next } }));
	}, []);

	// `ready` settles once the worker activates (first launch included) and never
	// in dev, where the Bun dev server serves no worker: push stays unsupported there.
	useEffect(() => {
		if (!supported()) return;
		void navigator.serviceWorker.ready.then(setOwn);
	}, []);

	// What each computer's subscription is: an existing one made under a since-rotated key can never be
	// delivered, so it goes; a current one is registered again, so a companion that lost its state file learns it.
	// A computer the user never turned off is subscribed when another one is: notifications are then on for this device.
	const keys = computers
		.filter(pushable)
		.map(computer => `${computer.id}:${computer.snap.vapidKey}`)
		.join(" ");
	useEffect(() => {
		if (own === null) return;
		let cancelled = false;
		const known = computers.filter(pushable);
		void (async () => {
			for (const computer of known) {
				const vapidKey = computer.snap.vapidKey!;
				const registration = await registrationFor(own, computer.id, vapidKey).catch(() => null);
				if (cancelled || registration === null) continue;
				let sub = await registration.pushManager.getSubscription();
				if (sub !== null && keyOf(sub) !== vapidKey) {
					await sub.unsubscribe();
					sub = null;
				}
				if (cancelled) return;
				patch(computer.id, { subscription: sub });
				if (sub !== null) computer.client.setPush(subscriptionJson(sub), true).catch(() => {});
			}
		})();
		return () => {
			cancelled = true;
		};
		// `keys` stands for the computers that can push: the list also changes with every host update.
	}, [own, keys, patch]);

	const subscribe = useCallback(
		async (computer: ComputerHandle & { client: NonNullable<ComputerHandle["client"]> }): Promise<void> => {
			if (own === null) return;
			const vapidKey = computer.snap.vapidKey!;
			const registration = await registrationFor(own, computer.id, vapidKey);
			const sub = await registration.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: new Uint8Array(decodeBase64Url(vapidKey) as Uint8Array),
			});
			try {
				await computer.client.setPush(subscriptionJson(sub), true);
			} catch (err) {
				await sub.unsubscribe();
				throw err;
			}
			patch(computer.id, { subscription: sub });
		},
		[own, patch],
	);

	// Notifications on for this device: a computer paired later joins them (permission is already granted, so nothing is asked).
	const anyOn = computers.some(computer => entryOf(computer.id).subscription !== null);
	useEffect(() => {
		if (own === null || !anyOn || Notification.permission !== "granted") return;
		const off = loadOff();
		for (const computer of computers.filter(pushable)) {
			const entry = Object.hasOwn(entries, computer.id) ? entries[computer.id]! : null;
			// `null`: not looked at yet; the effect above sets it once it has.
			if (entry === null || entry.subscription !== null || entry.busy || entry.error !== null) continue;
			if (off.includes(computer.id)) continue;
			patch(computer.id, { busy: true });
			subscribe(computer)
				.catch(err => patch(computer.id, { error: err instanceof Error ? err.message : String(err) }))
				.finally(() => patch(computer.id, { busy: false }));
		}
	}, [own, anyOn, computers, entries, subscribe, patch]);

	const toggle = useCallback(
		(computer: ComputerHandle): void => {
			const entry = Object.hasOwn(entries, computer.id) ? entries[computer.id]! : NONE;
			if (own === null || !pushable(computer) || entry.busy) return;
			patch(computer.id, { busy: true, error: null });
			const run = async (): Promise<void> => {
				const sub = entry.subscription;
				if (sub !== null) {
					await computer.client.setPush(subscriptionJson(sub), false).catch(() => {});
					await sub.unsubscribe();
					setOff(computer.id, true);
					patch(computer.id, { subscription: null });
					return;
				}
				// First await: the permission prompt needs the tap's user activation.
				if ((await Notification.requestPermission()) !== "granted") return;
				setOff(computer.id, false);
				await subscribe(computer);
			};
			run()
				.catch(err => patch(computer.id, { error: err instanceof Error ? err.message : String(err) }))
				.finally(() => patch(computer.id, { busy: false }));
		},
		[own, entries, patch, subscribe],
	);

	return useMemo(
		(): PushControls => ({
			of: (computerId: string): PushControl => {
				const computer = computers.find(candidate => candidate.id === computerId);
				const entry = Object.hasOwn(entries, computerId) ? entries[computerId]! : NONE;
				let status: PushStatus;
				if (own === null || computer === undefined || !pushable(computer)) status = "unsupported";
				else if (entry.busy) status = "busy";
				else if (entry.subscription !== null) status = "on";
				else if (Notification.permission === "denied") status = "denied";
				else status = "off";
				return {
					status,
					endpoint: entry.subscription?.endpoint ?? null,
					error: entry.error,
					toggle: () => {
						if (computer !== undefined) toggle(computer);
					},
				};
			},
		}),
		[computers, entries, own, toggle],
	);
}
