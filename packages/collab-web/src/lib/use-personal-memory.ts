/** The Memory screen's list: a filtered, paged view of the home computer's memory that follows its pushes. */

import type { PersonalMemory } from "@oh-my-pi/pi-wire/personal";
import { useCallback, useEffect, useRef, useState } from "react";
import { applyMemory, filtersKey, MEMORY_PAGE, type MemoryFilters, memoryQuery, mergePage } from "./personal-memory";
import type { PersonalControl } from "./use-personal";

export interface MemoryList {
	items: readonly PersonalMemory[];
	/** Matches on the computer, shown or not. */
	total: number;
	/** False until the first answer for any filter state. */
	loaded: boolean;
	/** The list for the current filters is being fetched; what is shown is the previous answer. */
	refreshing: boolean;
	loadingMore: boolean;
	/** The last failure; cleared by the next answer. */
	error: string | null;
	more(): void;
	reload(): void;
	/** Show a memory the computer just changed without waiting for the next fetch. */
	apply(memory: PersonalMemory): void;
}

/**
 * Asks for the first page whenever the filters change or the computer says memory moved, and keeps the previous answer on
 * screen until the new one lands. A refetch asks for as much as is shown (up to the page limit) so a pushed change does not
 * collapse a list the owner has paged through. Answers to superseded requests are dropped.
 */
export function usePersonalMemory(personal: PersonalControl, filters: MemoryFilters): MemoryList {
	const [items, setItems] = useState<readonly PersonalMemory[]>([]);
	const [total, setTotal] = useState(0);
	const [loaded, setLoaded] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const [loadingMore, setLoadingMore] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [tick, setTick] = useState(0);
	const latest = useRef({ items, filters });
	latest.current = { items, filters };
	const seq = useRef(0);
	const shownKey = useRef<string | null>(null);
	const key = filtersKey(filters);
	const reachable = personal.client !== null;
	const { call } = personal;
	const memoryTick = personal.ticks.memory;

	useEffect(() => {
		if (!reachable) return;
		const mine = ++seq.current;
		const sameList = shownKey.current === key;
		const limit = sameList ? Math.min(100, Math.max(MEMORY_PAGE, latest.current.items.length)) : MEMORY_PAGE;
		setRefreshing(true);
		setLoadingMore(false);
		call({ t: "personal-memory-search", query: memoryQuery(latest.current.filters, 0, limit) }).then(
			answer => {
				if (seq.current !== mine) return;
				shownKey.current = key;
				setItems(answer.items);
				setTotal(answer.total);
				setLoaded(true);
				setError(null);
				setRefreshing(false);
			},
			(err: unknown) => {
				if (seq.current !== mine) return;
				setError(err instanceof Error ? err.message : String(err));
				setRefreshing(false);
			},
		);
	}, [reachable, call, key, memoryTick, tick]);

	const more = useCallback(() => {
		const mine = ++seq.current;
		setLoadingMore(true);
		setError(null);
		const { items: shown, filters: current } = latest.current;
		call({ t: "personal-memory-search", query: memoryQuery(current, shown.length) }).then(
			answer => {
				if (seq.current !== mine) return;
				setItems(prev => mergePage(prev, answer.items));
				setTotal(answer.total);
				setLoadingMore(false);
			},
			(err: unknown) => {
				if (seq.current !== mine) return;
				setError(err instanceof Error ? err.message : String(err));
				setLoadingMore(false);
			},
		);
	}, [call]);

	const reload = useCallback(() => setTick(n => n + 1), []);

	const apply = useCallback(
		(memory: PersonalMemory) => {
			const next = applyMemory(latest.current.items, total, memory, latest.current.filters.includeInvalid);
			setItems(next.items);
			setTotal(next.total);
		},
		[total],
	);

	return { items, total, loaded, refreshing, loadingMore, error, more, reload, apply };
}
