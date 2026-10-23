import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { CompanionClient, INITIAL_SNAPSHOT, type PairingLink } from "./companion";
import {
	type Computer,
	type ComputerHandle,
	type FreshComputer,
	computerNames,
	loadComputers,
	loadLastComputer,
	pairComputer,
	rememberPairing,
	saveLastComputer,
	unpairComputer,
} from "./computers";
import { dropOrg } from "./org-storage";
import { forgetComputerRooms, type RecentRoom } from "./rooms";
import { suspendsHiddenPages } from "./socket";

interface Connection {
	computer: Computer;
	client: CompanionClient | null;
	error: string | null;
	unsubscribe: () => void;
}

/**
 * One connection per paired computer, as the `useSyncExternalStore` source the app reads. Connections are made
 * in {@link attach} (an effect, never during render), so each computer keeps its own socket for as long as it is
 * paired: a laptop going offline changes nothing about the connection to a server.
 */
class ComputerStore {
	#list: readonly Computer[];
	readonly #connections = new Map<string, Connection>();
	readonly #listeners = new Set<() => void>();
	#handles: readonly ComputerHandle[] = [];
	/** Handles by id, as last built: a computer that did not change keeps its handle, so what reads it does not re-render. */
	#built: Record<string, ComputerHandle> = {};
	#stale = true;

	constructor(list: readonly Computer[]) {
		this.#list = list;
	}

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	};

	getSnapshot = (): readonly ComputerHandle[] => {
		if (this.#stale) this.#rebuild();
		return this.#handles;
	};

	/** Make the connections match `list`: new computers connect, removed ones close, one whose link changed reconnects. */
	sync(list: readonly Computer[]): void {
		this.#list = list;
		const ids = new Set(list.map(computer => computer.id));
		for (const [id, connection] of this.#connections) {
			const next = list.find(computer => computer.id === id);
			if (next !== undefined && next.link === connection.computer.link) continue;
			this.#drop(id, connection);
		}
		for (const computer of list)
			if (ids.has(computer.id) && !this.#connections.has(computer.id)) this.#open(computer);
		this.#invalidate();
	}

	/** Called by the page's lifecycle: foreground resumes the sockets, a hidden page suspends them where the platform kills them anyway. */
	wake = (): void => {
		for (const { client } of this.#connections.values()) {
			if (document.visibilityState === "visible") client?.resume();
			else if (suspendsHiddenPages()) client?.suspend();
		}
	};

	online = (): void => {
		for (const { client } of this.#connections.values()) client?.resume("online");
	};

	attach(): void {
		this.sync(this.#list);
		document.addEventListener("visibilitychange", this.wake);
		window.addEventListener("online", this.online);
	}

	detach(): void {
		document.removeEventListener("visibilitychange", this.wake);
		window.removeEventListener("online", this.online);
		for (const [id, connection] of this.#connections) this.#drop(id, connection);
	}

	#open(computer: Computer): void {
		let client: CompanionClient | null = null;
		let error: string | null = null;
		// From storage: a connection since the list was read may have stored the credentials its invite bought.
		const stored = loadComputers().find(candidate => candidate.id === computer.id) ?? computer;
		try {
			client = new CompanionClient(stored, pairing => rememberPairing(computer.id, pairing));
			client.connect();
		} catch (err) {
			client = null;
			error = err instanceof Error ? err.message : String(err);
		}
		const unsubscribe = client?.subscribe(() => this.#invalidate()) ?? (() => {});
		this.#connections.set(computer.id, { computer, client, error, unsubscribe });
	}

	#drop(id: string, connection: Connection): void {
		connection.unsubscribe();
		connection.client?.close();
		this.#connections.delete(id);
	}

	#invalidate(): void {
		this.#stale = true;
		for (const listener of this.#listeners) listener();
	}

	#rebuild(): void {
		this.#stale = false;
		const snaps = this.#list.map(computer => {
			const connection = this.#connections.get(computer.id);
			const snap = connection?.client?.getSnapshot() ?? { ...INITIAL_SNAPSHOT, machine: computer.machine ?? null };
			return { computer, connection, snap };
		});
		const names = computerNames(snaps.map(({ computer, snap }) => ({ id: computer.id, machine: snap.machine })));
		const built: Record<string, ComputerHandle> = {};
		const handles = snaps.map(({ computer, connection, snap }): ComputerHandle => {
			const client = connection?.client ?? null;
			const error = connection?.error ?? null;
			const name = names[computer.id]!;
			const fresh = computer.fresh;
			const before = Object.hasOwn(this.#built, computer.id) ? this.#built[computer.id]! : null;
			const handle =
				before !== null &&
				before.snap === snap &&
				before.client === client &&
				before.error === error &&
				before.name === name &&
				before.fresh?.name === fresh?.name &&
				before.fresh?.hostComputerId === fresh?.hostComputerId
					? before
					: { id: computer.id, name, client, snap, error, ...(fresh === undefined ? {} : { fresh }) };
			built[computer.id] = handle;
			return handle;
		});
		this.#built = built;
		// A new array only when a handle changed, so memoized readers of the list stay put.
		if (handles.length !== this.#handles.length || handles.some((handle, i) => handle !== this.#handles[i])) {
			this.#handles = handles;
		}
	}
}

export interface ComputersControl {
	/** Every paired computer, in the order they were paired. */
	computers: readonly ComputerHandle[];
	/** Pair with the computer a link names: a new one is added, one already paired takes the link's invite. `fresh` marks it as a fresh VM. Its id; null when the link does not parse. */
	pair(link: PairingLink, fresh?: FreshComputer): string | null;
	/**
	 * Take a computer off this device: this device is revoked on the computer when it answers (the computer stops
	 * listing it among its devices), then the pairing and what this device kept for it are dropped. Resolves with the
	 * rooms still remembered.
	 */
	remove(id: string): Promise<RecentRoom[]>;
}

/**
 * The paired computers and a connection to each, for the whole app: the sidebar, the all-sessions list, the
 * start sheet and the open session all read the same handles.
 */
export function useComputers(): ComputersControl {
	const [store] = useState(() => new ComputerStore(loadComputers()));
	const computers = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
	useEffect(() => {
		store.attach();
		return () => store.detach();
	}, [store]);

	const pair = useCallback(
		(link: PairingLink, fresh?: FreshComputer): string | null => {
			const added = pairComputer(link, fresh);
			if (added === null) return null;
			store.sync(added.list);
			return added.id;
		},
		[store],
	);

	const remove = useCallback(
		async (id: string): Promise<RecentRoom[]> => {
			const handle = store.getSnapshot().find(computer => computer.id === id);
			const deviceId = handle?.snap.phase === "live" ? handle.snap.deviceId : null;
			if (handle?.client && deviceId !== null) await handle.client.removeDevice(deviceId).catch(() => {});
			store.sync(unpairComputer(id));
			dropOrg(id);
			if (loadLastComputer() === id) saveLastComputer(null);
			return forgetComputerRooms(id);
		},
		[store],
	);

	return { computers, pair, remove };
}
