import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { findEntryMatches } from "../transcript/search";

export interface SearchBarProps {
	entries: readonly SessionEntry[];
	/** Current query and the entry to bring into view (null: no match). */
	onSearch(query: string, target: string | null): void;
	onClose(): void;
}

/** Find in session: starts at the newest match; up walks back in time. */
export function SearchBar({ entries, onSearch, onClose }: SearchBarProps): ReactNode {
	const [query, setQuery] = useState("");
	/** Position counted from the newest match, so new entries do not move the cursor. */
	const [fromNewest, setFromNewest] = useState(0);
	const matches = useMemo(() => findEntryMatches(entries, query), [entries, query]);
	const index = matches.length === 0 ? -1 : Math.max(0, matches.length - 1 - fromNewest);
	const target = index >= 0 ? (matches[index] ?? null) : null;

	useEffect(() => {
		onSearch(query, target);
	}, [query, target, onSearch]);

	const step = (older: boolean): void => {
		if (matches.length === 0) return;
		setFromNewest(n => (older ? (n + 1) % matches.length : (n - 1 + matches.length) % matches.length));
	};

	const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
		if (e.key === "Enter") {
			e.preventDefault();
			step(!e.shiftKey);
		} else if (e.key === "Escape") {
			onClose();
		}
	};

	return (
		<div className="sh-search" role="search">
			<input
				className="sh-input sh-search-input"
				type="search"
				value={query}
				onChange={e => {
					setQuery(e.target.value);
					setFromNewest(0);
				}}
				onKeyDown={onKeyDown}
				placeholder="Find in prompts and replies"
				enterKeyHint="search"
				aria-label="find in session"
				autoFocus
			/>
			<span className="sh-search-count">{query.trim() ? `${index + 1}/${matches.length}` : ""}</span>
			<button
				type="button"
				className="sh-btn sh-btn-icon"
				onClick={() => step(true)}
				disabled={matches.length < 2}
				aria-label="older match"
			>
				<ChevronUp size={16} />
			</button>
			<button
				type="button"
				className="sh-btn sh-btn-icon"
				onClick={() => step(false)}
				disabled={matches.length < 2}
				aria-label="newer match"
			>
				<ChevronDown size={16} />
			</button>
			<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="close search">
				<X size={16} />
			</button>
		</div>
	);
}
