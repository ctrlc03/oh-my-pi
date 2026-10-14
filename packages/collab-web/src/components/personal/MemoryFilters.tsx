import { Pin, Search, X } from "lucide-react";
import type { ReactNode } from "react";
import { originLabel } from "../../lib/personal";
import { type MemoryFilters, ORIGIN_ORDER, toggleOrigin } from "../../lib/personal-memory";
import "./memory.css";

/** The Memory screen's search box and filters. `filters.q` is what is typed; the caller decides when it takes effect. */
export function MemoryFilterBar({
	filters,
	onChange,
}: {
	filters: MemoryFilters;
	onChange(filters: MemoryFilters): void;
}): ReactNode {
	return (
		<div className="pa-filters">
			<label className="pa-search">
				<Search size={14} aria-hidden="true" />
				<input
					className="sh-input"
					type="search"
					value={filters.q}
					onChange={e => onChange({ ...filters, q: e.currentTarget.value })}
					placeholder="Search memories"
					aria-label="Search memories"
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
				/>
				{filters.q !== "" && (
					<button
						type="button"
						className="sh-btn sh-btn-icon pa-search-clear"
						aria-label="Clear the search"
						onClick={() => onChange({ ...filters, q: "" })}
					>
						<X size={14} aria-hidden="true" />
					</button>
				)}
			</label>
			<div className="pa-chips" role="group" aria-label="Filter memories">
				{ORIGIN_ORDER.map(origin => {
					const { label, hint } = originLabel({ origin, authorId: origin });
					return (
						<button
							key={origin}
							type="button"
							className="sh-quick-chip pa-chip"
							aria-pressed={filters.origins.includes(origin)}
							title={hint}
							onClick={() => onChange(toggleOrigin(filters, origin))}
						>
							{label}
						</button>
					);
				})}
				<button
					type="button"
					className="sh-quick-chip pa-chip"
					aria-pressed={filters.pinnedOnly}
					onClick={() => onChange({ ...filters, pinnedOnly: !filters.pinnedOnly })}
				>
					<Pin size={12} aria-hidden="true" /> Pinned only
				</button>
				<button
					type="button"
					className="sh-quick-chip pa-chip"
					aria-pressed={filters.includeInvalid}
					onClick={() => onChange({ ...filters, includeInvalid: !filters.includeInvalid })}
				>
					Show retracted and replaced
				</button>
			</div>
			<p className="sh-field-hint pa-legend">
				You: said by you · Agent: its own conclusions · External: from the web, GitHub, email or events, only used
				when you ask
			</p>
		</div>
	);
}
