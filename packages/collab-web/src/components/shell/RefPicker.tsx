import type { BlueprintRefsAnswer } from "@oh-my-pi/pi-wire/blueprint";
import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { getBlueprintRefs } from "../architecture/blueprint-api";
import type { CompanionClient } from "../../lib/companion";
import { useRequest } from "../../lib/use-request";
import "./ref-picker.css";

const FILTER_DEBOUNCE_MS = 250;
const NO_REFS: BlueprintRefsAnswer = { branches: [] };

/** A pull request as the picker lists it; `head` and `base` are empty for one that is known only by number and title. */
export type RefPr = NonNullable<BlueprintRefsAnswer["prs"]>[number];

/** `value`, but only once it has stayed the same for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
	const [settled, setSettled] = useState(value);
	useEffect(() => {
		const timer = setTimeout(() => setSettled(value), ms);
		return () => clearTimeout(timer);
	}, [value, ms]);
	return settled;
}

export interface RepoRefs {
	/** The filter box as typed. */
	filter: string;
	setFilter(text: string): void;
	/** The filter the lists below were asked with (trimmed, after the typing pause). */
	query: string;
	status: "loading" | "ready" | "error";
	/** Why the lists could not be read; null unless `status` is "error". */
	message: string | null;
	/** What the repository offers; empty until the first answer. */
	answer: BlueprintRefsAnswer;
}

/** The branches and open pull requests of the repository holding `repo` on `client`, narrowed by a filter box. */
export function useRepoRefs(client: CompanionClient | null, repo: string): RepoRefs {
	const [filter, setFilter] = useState("");
	const query = useDebounced(filter.trim(), FILTER_DEBOUNCE_MS);
	const load = useCallback(
		(): Promise<BlueprintRefsAnswer> =>
			repo === "" || client === null ? Promise.resolve(NO_REFS) : getBlueprintRefs(client, repo, query || undefined),
		[client, repo, query],
	);
	const { state } = useRequest(load);
	return {
		filter,
		setFilter,
		query,
		status: state.status,
		message: state.status === "error" ? state.message : null,
		answer: state.status === "ready" ? state.value : NO_REFS,
	};
}

/** `prs` with `given` first when the listing lacks it (a pull request opened from elsewhere may not be among the open ones). */
export function withGivenPr(prs: readonly RefPr[], given: { number: number; title: string } | undefined): RefPr[] {
	if (given === undefined || prs.some(item => item.number === given.number)) return [...prs];
	return [{ number: given.number, title: given.title, head: "", base: "" }, ...prs];
}

export function RefFilter({
	kind,
	value,
	onChange,
}: {
	kind: "branch" | "pr";
	value: string;
	onChange(text: string): void;
}): ReactNode {
	const label = kind === "branch" ? "Filter branches" : "Filter pull requests";
	return (
		<div className="sh-field">
			<input
				className="sh-input"
				type="search"
				placeholder={label}
				aria-label={label}
				value={value}
				onChange={e => onChange(e.target.value)}
			/>
		</div>
	);
}

/** "Reading the repository…" while the lists load. */
export function RefsLoading(): ReactNode {
	return (
		<span className="sh-field-hint">
			<LoaderCircle size={12} className="sh-spin" /> Reading the repository…
		</span>
	);
}

export function BranchSelect({
	branches,
	current,
	value,
	disabled,
	onChange,
}: {
	branches: readonly string[];
	/** The checked-out branch, marked in the list. */
	current: string | undefined;
	value: string;
	disabled?: boolean;
	onChange(name: string): void;
}): ReactNode {
	return (
		<select
			className="sh-input sh-branches"
			size={Math.min(8, Math.max(3, branches.length))}
			value={value}
			onChange={e => onChange(e.target.value)}
			aria-label="Branch"
			disabled={disabled}
		>
			{branches.map(name => (
				<option key={name} value={name}>
					{name}
					{name === current ? " (checked out)" : ""}
				</option>
			))}
		</select>
	);
}

export function PrList({
	prs,
	value,
	onChange,
}: {
	prs: readonly RefPr[];
	value: number | null;
	onChange(number: number): void;
}): ReactNode {
	return (
		<ul className="sh-prs" role="radiogroup" aria-label="Pull request">
			{prs.map(item => (
				<li key={item.number}>
					<button
						type="button"
						role="radio"
						aria-checked={value === item.number}
						className={value === item.number ? "sh-pr sh-pr-on" : "sh-pr"}
						onClick={() => onChange(item.number)}
					>
						<span className="sh-pr-title">
							#{item.number} {item.title}
						</span>
						{item.head !== "" && (
							<span className="sh-pr-branches">
								{item.head} → {item.base}
							</span>
						)}
					</button>
				</li>
			))}
		</ul>
	);
}
