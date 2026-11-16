import { GitPullRequest, LoaderCircle, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import type { CompanionClient, GithubFilter } from "../../lib/companion";
import { relTime } from "../../lib/format";
import { useRequest } from "../../lib/use-request";

const FILTERS: Array<{ id: GithubFilter; label: string }> = [
	{ id: "open", label: "Open" },
	{ id: "mine", label: "Mine" },
	{ id: "review", label: "To review" },
];

export interface PrPickerProps {
	client: CompanionClient;
	instanceId: string;
	onPick(number: number): void;
}

/** Which pull request to review: the repository's open ones, or a number typed in. */
export function PrPicker({ client, instanceId, onPick }: PrPickerProps): ReactNode {
	const [filter, setFilter] = useState<GithubFilter>("open");
	const [typed, setTyped] = useState("");
	const load = useCallback(() => client.requestGithub(instanceId, "pr", filter), [client, instanceId, filter]);
	const { state, reload } = useRequest(load);
	const typedNumber = /^#?(\d+)$/.exec(typed.trim());
	return (
		<div className="rb-picker">
			<div className="rb-picker-head">
				<div className="sh-segmented" role="radiogroup" aria-label="Pull request filter">
					{FILTERS.map(entry => (
						<button
							key={entry.id}
							type="button"
							role="radio"
							aria-checked={filter === entry.id}
							className={filter === entry.id ? "sh-segment sh-segment-on" : "sh-segment"}
							onClick={() => setFilter(entry.id)}
						>
							{entry.label}
						</button>
					))}
				</div>
				<form
					className="rb-picker-number"
					onSubmit={e => {
						e.preventDefault();
						if (typedNumber !== null) onPick(Number(typedNumber[1]));
					}}
				>
					<input
						className="sh-input"
						inputMode="numeric"
						placeholder="PR number"
						aria-label="Pull request number"
						value={typed}
						onChange={e => setTyped(e.currentTarget.value)}
					/>
					<button type="submit" className="sh-btn" disabled={typedNumber === null}>
						Open
					</button>
				</form>
				<button type="button" className="sh-btn sh-btn-icon" aria-label="Refresh" onClick={reload}>
					<RefreshCw size={16} />
				</button>
			</div>
			{state.status === "loading" && (
				<div className="sh-companion-empty sh-file-status">
					<LoaderCircle size={14} className="sh-spin" /> Loading pull requests…
				</div>
			)}
			{state.status === "error" && <div className="sh-connect-error">{state.message}</div>}
			{state.status === "ready" &&
				(state.value.items.length === 0 ? (
					<div className="sh-companion-empty">No pull requests here.</div>
				) : (
					<ul className="rb-picker-list">
						{state.value.items.map(item => (
							<li key={item.number}>
								<button type="button" className="rb-picker-item" onClick={() => onPick(item.number)}>
									<GitPullRequest size={15} />
									<span className="rb-picker-title">
										{item.title} <span className="sh-gh-number">#{item.number}</span>
									</span>
									<span className="rb-picker-meta">
										{item.author} · {relTime(item.updatedAt)}
									</span>
								</button>
							</li>
						))}
					</ul>
				))}
		</div>
	);
}
