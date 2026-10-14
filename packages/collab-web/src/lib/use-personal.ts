/**
 * The Personal agent for the whole app: which computer is its home, that computer's status, and a typed call to it.
 * Provided once at the app's top ({@link usePersonalProvider} in `App`, read through {@link usePersonal}), so the
 * sidebar entry, the inbox and the Settings screens agree on one home computer.
 *
 * Opt-in: nothing is asked of a computer that does not advertise `canPersonal`, and with no computer set up nothing
 * here renders. A computer that is not reachable is a calm state (`offline`), never an error to retry in a loop.
 */

import type {
	PersonalAnswer,
	PersonalCall,
	PersonalChangeKind,
	PersonalChanged,
	PersonalStatus,
} from "@oh-my-pi/pi-wire/personal";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { CompanionClient } from "./companion";
import type { ComputerHandle } from "./computers";
import {
	chooseHome,
	type HomeChoice,
	hostableComputers,
	loadRememberedHome,
	type RememberedHome,
	saveRememberedHome,
} from "./personal";
import type { RequestState } from "./use-request";

/** How long a Personal request may take before the app gives up on it (memory search and export are the slow ones). */
export const PERSONAL_TIMEOUT_MS = 20_000;
const STATUS_TIMEOUT_MS = 10_000;

export const HOME_OFFLINE = "The home computer is offline.";

/** Counters bumped when the companion pushes that something moved; a screen refetches when its kind's counter does. */
export type PersonalTicks = Readonly<Record<PersonalChangeKind, number>>;

const KINDS: readonly PersonalChangeKind[] = [
	"status",
	"inbox",
	"about",
	"proposals",
	"digests",
	"memory",
	"events",
	"settings",
];

const NO_TICKS: PersonalTicks = Object.fromEntries(KINDS.map(kind => [kind, 0])) as Record<PersonalChangeKind, number>;

export interface PersonalControl {
	/** Where Personal lives (or null). */
	home: HomeChoice;
	/** Reachable computers that can host Personal: the setup flow picks among them. */
	hostable: readonly ComputerHandle[];
	/** The home computer's connection while it is reachable. */
	client: CompanionClient | null;
	ticks: PersonalTicks;
	/** A request to the home computer; rejects with {@link HOME_OFFLINE} when it is not reachable. */
	call<C extends PersonalCall>(call: C): Promise<PersonalAnswer<C["t"]>>;
	/** A request to any computer that can host Personal (setup, before there is a home); rejects when it is not reachable. */
	callOn<C extends PersonalCall>(computerId: string, call: C): Promise<PersonalAnswer<C["t"]>>;
	/** A reply carried the computer's newer status (setup, enable, control): show it without waiting for the push. */
	adopt(computerId: string, status: PersonalStatus): void;
}

const NO_HOME: HomeChoice = { computer: null, status: null, offline: false, duplicates: [] };

/** What a component outside the provider (and the app while no computer can host Personal) sees: no Personal. */
export const NO_PERSONAL: PersonalControl = {
	home: NO_HOME,
	hostable: [],
	client: null,
	ticks: NO_TICKS,
	call: () => Promise.reject(new Error(HOME_OFFLINE)),
	callOn: () => Promise.reject(new Error(HOME_OFFLINE)),
	adopt: () => {},
};

export const PersonalContext = createContext<PersonalControl>(NO_PERSONAL);

/** The app's Personal state (see {@link usePersonalProvider}). */
export function usePersonal(): PersonalControl {
	return useContext(PersonalContext);
}

/**
 * Builds the app's {@link PersonalControl} from the paired computers. Asks `personal-status` of every reachable computer
 * that advertises `canPersonal`, once, and again whenever its `hosts` frame carries a new `personalRev` or it pushes
 * `personal-changed`. Call it once, in `App`.
 */
export function usePersonalProvider(computers: readonly ComputerHandle[]): PersonalControl {
	const [statuses, setStatuses] = useState<Record<string, PersonalStatus>>({});
	const [ticks, setTicks] = useState<PersonalTicks>(NO_TICKS);
	const [remembered, setRemembered] = useState<RememberedHome | null>(loadRememberedHome);
	const hostable = useMemo(() => hostableComputers(computers), [computers]);
	const latest = useRef(hostable);
	latest.current = hostable;
	/** Highest `PersonalStatus.rev` seen per computer, so one change moves the ticks once however it arrives. */
	const seenRev = useRef<Record<string, number>>({});

	const adopt = useCallback((computerId: string, status: PersonalStatus): void => {
		setStatuses(prev => (prev[computerId] === status ? prev : { ...prev, [computerId]: status }));
	}, []);

	const bump = useCallback((what: readonly PersonalChangeKind[]): void => {
		setTicks(prev => {
			const next = { ...prev };
			for (const kind of what) next[kind] += 1;
			return next;
		});
	}, []);

	/** Ask one computer for its status; a rev newer than the last seen moves every counter (a missed push is caught here). */
	const refresh = useCallback(
		(computerId: string): void => {
			const client = latest.current.find(computer => computer.id === computerId)?.client;
			if (client === null || client === undefined) return;
			client.requestPersonal({ t: "personal-status" }, STATUS_TIMEOUT_MS).then(
				reply => {
					adopt(computerId, reply.status);
					const seen = Object.hasOwn(seenRev.current, computerId) ? seenRev.current[computerId]! : null;
					seenRev.current[computerId] = Math.max(seen ?? 0, reply.status.rev);
					if (seen !== null && reply.status.rev > seen) bump(KINDS);
				},
				() => {},
			);
		},
		[adopt, bump],
	);

	const watch = hostable.map(computer => `${computer.id}:${computer.snap.personalRev ?? ""}`).join("|");
	useEffect(() => {
		for (const computer of latest.current) refresh(computer.id);
	}, [watch, refresh]);

	const subscribed = hostable.map(computer => computer.id).join("|");
	useEffect(() => {
		const stops = latest.current.flatMap(computer =>
			computer.client === null
				? []
				: [
						computer.client.onPersonalChanged((frame: PersonalChanged) => {
							const seen = Object.hasOwn(seenRev.current, computer.id) ? seenRev.current[computer.id]! : 0;
							seenRev.current[computer.id] = Math.max(seen, frame.rev);
							bump(frame.what);
							if (frame.what.includes("status")) refresh(computer.id);
						}),
					],
		);
		return () => {
			for (const stop of stops) stop();
		};
	}, [subscribed, bump, refresh]);

	const home = useMemo(() => chooseHome(computers, statuses, remembered), [computers, statuses, remembered]);
	const homeId = home.computer?.id ?? null;
	const homeEnabled = home.status?.enabled ?? null;
	useEffect(() => {
		if (homeId === null || homeEnabled === null) return;
		const next = { computerId: homeId, enabled: homeEnabled };
		setRemembered(prev => (prev?.computerId === homeId && prev.enabled === homeEnabled ? prev : next));
		saveRememberedHome(next);
	}, [homeId, homeEnabled]);

	const client = home.computer !== null && home.computer.snap.phase === "live" ? home.computer.client : null;
	const callOn = useCallback(
		<C extends PersonalCall>(computerId: string, call: C): Promise<PersonalAnswer<C["t"]>> => {
			const target = latest.current.find(computer => computer.id === computerId)?.client;
			if (target === null || target === undefined) return Promise.reject(new Error(HOME_OFFLINE));
			return target.requestPersonal(call, PERSONAL_TIMEOUT_MS);
		},
		[],
	);
	const call = useCallback(
		<C extends PersonalCall>(request: C): Promise<PersonalAnswer<C["t"]>> =>
			homeId === null ? Promise.reject(new Error(HOME_OFFLINE)) : callOn(homeId, request),
		[homeId, callOn],
	);

	return useMemo(
		() =>
			hostable.length === 0 && home.computer === null
				? NO_PERSONAL
				: { home, hostable, client, ticks, call, callOn, adopt },
		[hostable, home, client, ticks, call, callOn, adopt],
	);
}

/** What {@link usePersonalQuery} gives back. */
export interface PersonalQuery<T> {
	state: RequestState<T>;
	/** The answer being refreshed (after a push or `reload()`): the last one stays on screen meanwhile. */
	refreshing: boolean;
	reload(): void;
}

/**
 * Loads something from the home computer, and again when the companion pushes that one of `what` moved, when the home
 * computer comes back, and on `reload()`. The last answer stays while the next loads; a failure after an answer keeps the
 * answer. Nothing is asked while `enabled` is false or the home computer is not reachable.
 */
export function usePersonalQuery<T>(
	personal: PersonalControl,
	what: readonly PersonalChangeKind[],
	load: (call: PersonalControl["call"]) => Promise<T>,
	enabled = true,
): PersonalQuery<T> {
	const [state, setState] = useState<RequestState<T>>({ status: "loading" });
	const [refreshing, setRefreshing] = useState(false);
	const [tick, setTick] = useState(0);
	const latest = useRef(load);
	latest.current = load;
	const reachable = personal.client !== null;
	const key = what.map(kind => personal.ticks[kind]).join(",");
	const { call } = personal;

	useEffect(() => {
		if (!enabled || !reachable) return;
		let stale = false;
		setRefreshing(true);
		latest.current(call).then(
			value => {
				if (stale) return;
				setState({ status: "ready", value });
				setRefreshing(false);
			},
			(err: unknown) => {
				if (stale) return;
				const message = err instanceof Error ? err.message : String(err);
				setState(prev => (prev.status === "ready" ? prev : { status: "error", message }));
				setRefreshing(false);
			},
		);
		return () => {
			stale = true;
		};
	}, [enabled, reachable, key, tick, call]);

	const reload = useCallback(() => setTick(n => n + 1), []);
	return { state, refreshing, reload };
}
