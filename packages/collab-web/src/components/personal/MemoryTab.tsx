import type { PersonalMemory } from "@oh-my-pi/pi-wire/personal";
import { LoaderCircle, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { isFiltered, type MemoryFilters, NO_FILTERS } from "../../lib/personal-memory";
import { usePersonal } from "../../lib/use-personal";
import { usePersonalMemory } from "../../lib/use-personal-memory";
import { MemoryExport } from "./MemoryExport";
import { MemoryFilterBar } from "./MemoryFilters";
import { MemoryRow } from "./MemoryRow";
import { HomeGate } from "./shared";
import "./memory.css";

const SEARCH_DEBOUNCE_MS = 250;

/** Settings → Personal agent → Memory: what the agent remembers, and what the owner may do about it. */
export function MemoryTab(): ReactNode {
	return (
		<HomeGate>
			<MemoryScreen />
		</HomeGate>
	);
}

function MemoryScreen(): ReactNode {
	const personal = usePersonal();
	const [filters, setFilters] = useState<MemoryFilters>(NO_FILTERS);
	const [typed, setTyped] = useState(filters.q);
	const [notice, setNotice] = useState<string | null>(null);

	useEffect(() => {
		const timer = setTimeout(() => setTyped(filters.q), SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [filters.q]);
	const effective = useMemo(() => ({ ...filters, q: typed }), [filters, typed]);
	const list = usePersonalMemory(personal, effective);

	const onChange = (memory: PersonalMemory): void => {
		list.apply(memory);
		setNotice(
			memory.invalid && !filters.includeInvalid
				? "Retracted. The agent stops recalling it. It is kept: turn on “Show retracted and replaced” to see it."
				: null,
		);
	};

	return (
		<div className="pa-memory">
			<MemoryFilterBar
				filters={filters}
				onChange={next => {
					setNotice(null);
					setFilters(next);
				}}
			/>
			{!list.loaded ? (
				list.error === null ? (
					<div className="sh-companion-empty sh-file-status" role="status">
						<LoaderCircle size={14} className="sh-spin" /> Loading memories…
					</div>
				) : (
					<Failure message={list.error} onRetry={list.reload} />
				)
			) : (
				<>
					<div className="pa-mem-summary" role="status">
						<span>
							{list.total} {list.total === 1 ? "memory" : "memories"}
						</span>
						{list.refreshing && <LoaderCircle size={13} className="sh-spin" aria-label="Updating" />}
					</div>
					{notice !== null && (
						<div className="pa-note" role="status">
							{notice}
						</div>
					)}
					{list.error !== null && <Failure message={list.error} onRetry={list.reload} />}
					{list.items.length === 0 ? (
						<div className="sh-companion-empty">
							{isFiltered(effective)
								? "No memories match these filters."
								: "Nothing remembered yet. What you tell the agent, and what it learns, shows up here."}
						</div>
					) : (
						<ul className="pa-mem-list" aria-busy={list.refreshing}>
							{list.items.map(memory => (
								<MemoryRow key={memory.id} memory={memory} onChange={onChange} />
							))}
						</ul>
					)}
					{list.items.length < list.total && (
						<button
							type="button"
							className="sh-btn pa-more"
							disabled={list.loadingMore || list.refreshing}
							onClick={list.more}
						>
							{list.loadingMore && <LoaderCircle size={14} className="sh-spin" aria-hidden="true" />} Show more
						</button>
					)}
				</>
			)}
			<MemoryExport />
		</div>
	);
}

function Failure({ message, onRetry }: { message: string; onRetry(): void }): ReactNode {
	return (
		<div className="sh-tree-error">
			<div className="sh-connect-error">{message}</div>
			<button type="button" className="sh-btn" onClick={onRetry}>
				<RefreshCw size={14} /> Retry
			</button>
		</div>
	);
}
