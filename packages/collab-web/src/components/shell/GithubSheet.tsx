import {
	ChevronLeft,
	Boxes,
	CircleCheck,
	CircleDashed,
	CircleDot,
	CircleX,
	ExternalLink,
	GitMerge,
	GitPullRequest,
	GitPullRequestClosed,
	GitPullRequestDraft,
	LoaderCircle,
	RefreshCw,
	SendHorizontal,
	Wrench,
	X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useRef, useState } from "react";
import type {
	CompanionClient,
	GithubCheckState,
	GithubFilter,
	GithubItem,
	GithubItemDetail,
	GithubKind,
} from "../../lib/companion";
import { relTime } from "../../lib/format";
import { fixRoute, prRepo } from "../../lib/fix-route";
import { emitRoute } from "../../lib/notify-route";
import { useRequest } from "../../lib/use-request";
import { Markdown } from "../transcript/Markdown";
import { PrFiles } from "./PrFiles";
import { PrMergeSheet } from "./PrMergeSheet";
import { Sheet } from "./Sheet";
import "./stats.css";
import "./github.css";
import "./pr-review.css";

export interface GithubSheetProps {
	client: CompanionClient;
	instanceId: string;
	/** Put a prompt about an issue or pull request into the composer; null when this device cannot prompt. */
	onSendToAgent: ((prompt: string) => void) | null;
	/** The companion answers the pull request review requests (`canPrReview`): pull requests get a Files tab and Merge. */
	canReview?: boolean;
	/** The session is sandboxed: reviews and merges are not posted from it. */
	sandboxed?: boolean;
	/** The companion answers `ci-log` (`canFixIt`): a pull request with failing checks gets a Fix it button. */
	canFixIt?: boolean;
	/** Start an architecture map of a pull request; null unless the paired computer can make maps. */
	onMapPr?: ((pr: { number: number; title: string }) => void) | null;
	onClose(): void;
}

const KINDS: { value: GithubKind; label: string }[] = [
	{ value: "issue", label: "Issues" },
	{ value: "pr", label: "Pull requests" },
];

const FILTERS: Record<GithubKind, { value: GithubFilter; label: string }[]> = {
	issue: [
		{ value: "open", label: "Open" },
		{ value: "mine", label: "Assigned to me" },
	],
	pr: [
		{ value: "open", label: "Open" },
		{ value: "mine", label: "Mine" },
		{ value: "review", label: "Review requested" },
	],
};

const EMPTY: Record<GithubFilter, string> = {
	open: "Nothing open.",
	mine: "Nothing of yours is open.",
	review: "No pull request waits on your review.",
};

/** How much of a description goes into the prompt; the agent can read the rest with `gh`. */
const PROMPT_BODY_CHARS = 4000;

/**
 * Issues and pull requests of the session's GitHub repository, read through the
 * computer's signed-in `gh`. Read-only; an item can be handed to the agent as a
 * prompt in the composer, for the user to edit and send.
 */
export function GithubSheet({
	client,
	instanceId,
	onSendToAgent,
	canReview,
	sandboxed,
	canFixIt,
	onMapPr,
	onClose,
}: GithubSheetProps): ReactNode {
	const [kind, setKind] = useState<GithubKind>("issue");
	const [filter, setFilter] = useState<GithubFilter>("open");
	const [opened, setOpened] = useState<GithubItem | null>(null);

	const pickKind = (next: GithubKind): void => {
		setKind(next);
		if (!FILTERS[next].some(f => f.value === filter)) setFilter("open");
	};

	return (
		<Sheet label="github" size="wide" onClose={onClose}>
			{/* The list stays mounted under an opened item, so going back keeps it without a reload. */}
			<div className="sh-gh-pane" hidden={opened !== null}>
				<ItemList
					client={client}
					instanceId={instanceId}
					kind={kind}
					filter={filter}
					onKind={pickKind}
					onFilter={setFilter}
					onOpen={setOpened}
					onClose={onClose}
				/>
			</div>
			{opened !== null && (
				<ItemDetail
					key={`${opened.kind}#${opened.number}`}
					client={client}
					instanceId={instanceId}
					item={opened}
					onBack={() => setOpened(null)}
					onSendToAgent={onSendToAgent}
					canReview={canReview === true}
					sandboxed={sandboxed === true}
					canFixIt={canFixIt === true}
					onMapPr={onMapPr ?? null}
					onClose={onClose}
				/>
			)}
		</Sheet>
	);
}

interface ItemListProps {
	client: CompanionClient;
	instanceId: string;
	kind: GithubKind;
	filter: GithubFilter;
	onKind(kind: GithubKind): void;
	onFilter(filter: GithubFilter): void;
	onOpen(item: GithubItem): void;
	onClose(): void;
}

function ItemList({ client, instanceId, kind, filter, onKind, onFilter, onOpen, onClose }: ItemListProps): ReactNode {
	const load = useCallback(() => client.requestGithub(instanceId, kind, filter), [client, instanceId, kind, filter]);
	const { state, reload } = useRequest(load);
	// Keep the previous list on screen (dimmed) while another tab or filter loads.
	const shown = useRef<{ repo: string; items: GithubItem[] } | null>(null);
	if (state.status === "ready") shown.current = state.value;
	const list = shown.current;
	const loading = state.status === "loading";

	return (
		<>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title">
					GitHub
					{list?.repo && <span className="sh-gh-repo">{list.repo}</span>}
				</div>
				<span className="sh-stats-head-actions">
					<RefreshButton loading={loading} onClick={reload} />
					<CloseButton onClick={onClose} />
				</span>
			</div>
			<div className="sh-gh-controls">
				<div className="sh-segmented" role="radiogroup" aria-label="List">
					{KINDS.map(k => (
						<button
							key={k.value}
							type="button"
							role="radio"
							aria-checked={kind === k.value}
							className={kind === k.value ? "sh-segment sh-segment-on" : "sh-segment"}
							onClick={() => onKind(k.value)}
						>
							{k.label}
						</button>
					))}
				</div>
				<div className="sh-gh-filters" role="radiogroup" aria-label="Filter">
					{FILTERS[kind].map(f => (
						<button
							key={f.value}
							type="button"
							role="radio"
							aria-checked={filter === f.value}
							className={filter === f.value ? "sh-gh-filter sh-gh-filter-on" : "sh-gh-filter"}
							onClick={() => onFilter(f.value)}
						>
							{f.label}
						</button>
					))}
				</div>
			</div>
			{state.status === "error" && (
				<div className="sh-tree-error">
					<div className="sh-connect-error">{state.message}</div>
					<button type="button" className="sh-btn" onClick={reload}>
						<RefreshCw size={14} /> Retry
					</button>
				</div>
			)}
			{list === null
				? loading && (
						<div className="sh-companion-empty sh-file-status">
							<LoaderCircle size={14} className="sh-spin" /> Asking GitHub…
						</div>
					)
				: state.status !== "error" &&
					(list.items.length === 0 && !loading ? (
						<div className="sh-companion-empty">{EMPTY[filter]}</div>
					) : (
						<ul className={loading ? "sh-gh-list sh-stats-stale" : "sh-gh-list"}>
							{list.items.map(item => (
								<li key={`${item.kind}#${item.number}`}>
									<button type="button" className="sh-gh-row" onClick={() => onOpen(item)}>
										<StateIcon item={item} />
										<span className="sh-gh-row-main">
											<span className="sh-gh-row-title">{item.title}</span>
											<span className="sh-gh-row-meta">
												<span>#{item.number}</span>
												<span>{item.author}</span>
												<span>{relTime(item.updatedAt)}</span>
												{item.checks && <ChecksBadge state={item.checks} />}
												{item.review && <ReviewBadge review={item.review} />}
											</span>
											{item.labels.length > 0 && <Labels labels={item.labels} />}
										</span>
									</button>
								</li>
							))}
						</ul>
					))}
		</>
	);
}

interface ItemDetailProps {
	client: CompanionClient;
	instanceId: string;
	/** The listed item, shown while its details load. */
	item: GithubItem;
	onBack(): void;
	onSendToAgent: ((prompt: string) => void) | null;
	canReview: boolean;
	sandboxed: boolean;
	canFixIt: boolean;
	onMapPr: ((pr: { number: number; title: string }) => void) | null;
	onClose(): void;
}

function ItemDetail({
	client,
	instanceId,
	item,
	onBack,
	onSendToAgent,
	canReview,
	sandboxed,
	canFixIt,
	onMapPr,
	onClose,
}: ItemDetailProps): ReactNode {
	const load = useCallback(
		() => client.requestGithubItem(instanceId, item.kind, item.number),
		[client, instanceId, item.kind, item.number],
	);
	const { state, reload } = useRequest(load);
	const shown = useRef<GithubItemDetail | null>(null);
	if (state.status === "ready") shown.current = state.value;
	const detail = shown.current;
	const loading = state.status === "loading";
	const head = detail ?? item;
	const reviewable = item.kind === "pr" && canReview;
	const [tab, setTab] = useState<"overview" | "files">("overview");
	// Files stays mounted once opened, so its expanded diffs and half-written comments survive a look at the overview.
	const [filesOpened, setFilesOpened] = useState(false);
	const [merging, setMerging] = useState(false);
	// Merging and posting reviews act on GitHub as the user: not from a view-only link, not from a sandboxed session.
	const canWrite = onSendToAgent !== null && !sandboxed;
	// Fix it opens another session with a draft; not offered on a view-only link, and `checks` is the rollup of the head commit.
	const fixRepo =
		canFixIt && onSendToAgent !== null && item.kind === "pr" && head.checks === "fail" ? prRepo(head.url) : null;

	return (
		<div className="sh-gh-pane">
			<div className="sh-sheet-head">
				<button type="button" className="sh-btn sh-gh-back" onClick={onBack}>
					<ChevronLeft size={16} /> {item.kind === "pr" ? "Pull requests" : "Issues"}
				</button>
				<span className="sh-stats-head-actions">
					<RefreshButton loading={loading} onClick={reload} />
					<CloseButton onClick={onClose} />
				</span>
			</div>
			<div className="sh-gh-detail-head">
				<h2 className="sh-gh-title">
					{head.title} <span className="sh-gh-number">#{head.number}</span>
				</h2>
				<div className="sh-gh-row-meta">
					<StateChip item={head} />
					<span>{head.author}</span>
					<span>updated {relTime(head.updatedAt)}</span>
					{detail?.size && (
						<span>
							<span className="sh-gh-add">+{detail.size.additions}</span>{" "}
							<span className="sh-gh-del">−{detail.size.deletions}</span> · {detail.size.files}{" "}
							{detail.size.files === 1 ? "file" : "files"}
						</span>
					)}
				</div>
				{detail?.branch && (
					<div className="sh-gh-branch">
						<code>{detail.branch.head}</code> → <code>{detail.branch.base}</code>
					</div>
				)}
				{head.labels.length > 0 && <Labels labels={head.labels} />}
				<div className="sh-gh-actions">
					{onSendToAgent && (
						<button
							type="button"
							className="sh-btn sh-btn-primary"
							disabled={detail === null}
							onClick={() => detail && onSendToAgent(agentPrompt(detail))}
							title="Put this into the message box, to edit and send"
						>
							<SendHorizontal size={15} /> Send to agent
						</button>
					)}
					{fixRepo !== null && (
						<button
							type="button"
							className="sh-btn"
							onClick={() => emitRoute(fixRoute(fixRepo, head.number), client.computerId)}
							title="Read the failing checks' logs and open a session with a prompt to fix them"
						>
							<Wrench size={14} /> Fix it
						</button>
					)}
					{reviewable && canWrite && tab === "overview" && detail !== null && detail.state === "open" && (
						<button type="button" className="sh-btn" onClick={() => setMerging(true)}>
							<GitMerge size={14} /> Merge…
						</button>
					)}
					{item.kind === "pr" && onMapPr !== null && (
						<button
							type="button"
							className="sh-btn"
							onClick={() => onMapPr({ number: head.number, title: head.title })}
						>
							<Boxes size={14} /> Map this PR
						</button>
					)}
					{head.url && (
						<a className="sh-btn" href={head.url} target="_blank" rel="noopener noreferrer">
							<ExternalLink size={14} /> Open on GitHub
						</a>
					)}
				</div>
			</div>
			{reviewable && (
				<div className="sh-segmented sh-prr-tabs" role="radiogroup" aria-label="Pull request view">
					{(["overview", "files"] as const).map(value => (
						<button
							key={value}
							type="button"
							role="radio"
							aria-checked={tab === value}
							className={tab === value ? "sh-segment sh-segment-on" : "sh-segment"}
							onClick={() => {
								setTab(value);
								if (value === "files") setFilesOpened(true);
							}}
						>
							{value === "files" ? "Files" : "Overview"}
						</button>
					))}
				</div>
			)}
			{reviewable && filesOpened && (
				<div hidden={tab !== "files"}>
					<PrFiles
						client={client}
						instanceId={instanceId}
						number={item.number}
						url={item.url}
						onSendToAgent={onSendToAgent}
						canSubmit={canWrite}
					/>
				</div>
			)}
			{state.status === "error" && (
				<div className="sh-tree-error">
					<div className="sh-connect-error">{state.message}</div>
					<button type="button" className="sh-btn" onClick={reload}>
						<RefreshCw size={14} /> Retry
					</button>
				</div>
			)}
			{detail === null ? (
				loading && (
					<div className="sh-companion-empty sh-file-status">
						<LoaderCircle size={14} className="sh-spin" /> Loading…
					</div>
				)
			) : (
				<div className={loading ? "sh-gh-body sh-stats-stale" : "sh-gh-body"} hidden={tab === "files"}>
					{detail.checkList.length > 0 && (
						<section aria-label="Checks">
							<h3 className="sh-recents-title">Checks</h3>
							<ul className="sh-gh-checks">
								{detail.checkList.map((check, i) => (
									<li key={`${check.name}:${i}`} className="sh-gh-check">
										<CheckIcon state={check.state} />
										{check.url ? (
											<a href={check.url} target="_blank" rel="noopener noreferrer">
												{check.name}
											</a>
										) : (
											<span>{check.name}</span>
										)}
									</li>
								))}
							</ul>
						</section>
					)}
					<section aria-label="Description" className="sh-gh-post">
						{detail.body.trim() ? (
							<Markdown text={detail.body} />
						) : (
							<div className="sh-gh-muted">No description.</div>
						)}
					</section>
					{(detail.comments.length > 0 || detail.olderComments > 0) && (
						<section aria-label="Comments">
							<h3 className="sh-recents-title">Comments</h3>
							{detail.olderComments > 0 && (
								<a className="sh-gh-older" href={detail.url} target="_blank" rel="noopener noreferrer">
									{detail.olderComments} earlier {detail.olderComments === 1 ? "comment" : "comments"} on
									GitHub
								</a>
							)}
							<ul className="sh-gh-comments">
								{detail.comments.map((comment, i) => (
									<li key={`${comment.createdAt}:${i}`} className="sh-gh-post">
										<div className="sh-gh-row-meta">
											<span className="sh-gh-author">{comment.author}</span>
											<span>{relTime(comment.createdAt)}</span>
										</div>
										<Markdown text={comment.body} />
									</li>
								))}
							</ul>
						</section>
					)}
				</div>
			)}
			{merging && detail !== null && (
				<PrMergeSheet
					client={client}
					instanceId={instanceId}
					pr={detail}
					onMerged={() => {
						setMerging(false);
						reload();
					}}
					onClose={() => setMerging(false)}
				/>
			)}
		</div>
	);
}

/** The composer prompt for an item: what it is, where, its description, and a pull request's failing checks. */
export function agentPrompt(item: GithubItemDetail): string {
	const what = item.kind === "pr" ? "pull request" : "issue";
	const lines = [`GitHub ${what} #${item.number}: ${item.title}`, item.url];
	if (item.branch) lines.push(`Branch: ${item.branch.head} → ${item.branch.base}`);
	const failing = item.checkList.filter(check => check.state === "fail").map(check => check.name);
	if (failing.length > 0) lines.push(`Failing checks: ${failing.join(", ")}`);
	const body = item.body.trim();
	if (body) {
		const clipped = body.length > PROMPT_BODY_CHARS ? `${body.slice(0, PROMPT_BODY_CHARS)}…` : body;
		lines.push("", clipped);
	}
	return lines.join("\n");
}

function RefreshButton({ loading, onClick }: { loading: boolean; onClick(): void }): ReactNode {
	return (
		<button
			type="button"
			className="sh-btn sh-btn-icon"
			onClick={onClick}
			disabled={loading}
			aria-label="Refresh"
			title="Refresh"
		>
			{loading ? <LoaderCircle size={15} className="sh-spin" /> : <RefreshCw size={15} />}
		</button>
	);
}

function CloseButton({ onClick }: { onClick(): void }): ReactNode {
	return (
		<button type="button" className="sh-btn sh-btn-icon" onClick={onClick} aria-label="Close">
			<X size={16} />
		</button>
	);
}

function Labels({ labels }: { labels: string[] }): ReactNode {
	return (
		<span className="sh-gh-labels">
			{labels.map(label => (
				<span key={label} className="sh-gh-label">
					{label}
				</span>
			))}
		</span>
	);
}

function stateLook(item: GithubItem): { Icon: typeof CircleDot; tone: string; label: string } {
	if (item.kind === "issue") {
		return item.state === "open"
			? { Icon: CircleDot, tone: "open", label: "Open" }
			: { Icon: CircleCheck, tone: "done", label: "Closed" };
	}
	if (item.state === "merged") return { Icon: GitMerge, tone: "done", label: "Merged" };
	if (item.state === "closed") return { Icon: GitPullRequestClosed, tone: "closed", label: "Closed" };
	return item.draft
		? { Icon: GitPullRequestDraft, tone: "draft", label: "Draft" }
		: { Icon: GitPullRequest, tone: "open", label: "Open" };
}

function StateIcon({ item }: { item: GithubItem }): ReactNode {
	const { Icon, tone, label } = stateLook(item);
	return <Icon size={16} className={`sh-gh-state sh-gh-${tone}`} aria-label={label} />;
}

function StateChip({ item }: { item: GithubItem }): ReactNode {
	const { Icon, tone, label } = stateLook(item);
	return (
		<span className={`sh-gh-chip sh-gh-${tone}`}>
			<Icon size={12} /> {label}
		</span>
	);
}

const CHECK_LOOK: Record<GithubCheckState, { Icon: typeof CircleDot; label: string }> = {
	pass: { Icon: CircleCheck, label: "checks pass" },
	fail: { Icon: CircleX, label: "checks fail" },
	pending: { Icon: CircleDashed, label: "checks running" },
};

function CheckIcon({ state }: { state: GithubCheckState }): ReactNode {
	const { Icon, label } = CHECK_LOOK[state];
	return <Icon size={14} className={`sh-gh-check-${state}`} aria-label={label} />;
}

function ChecksBadge({ state }: { state: GithubCheckState }): ReactNode {
	return (
		<span className={`sh-gh-checks-badge sh-gh-check-${state}`} title={CHECK_LOOK[state].label}>
			<CheckIcon state={state} />
		</span>
	);
}

const REVIEW_LABEL: Record<NonNullable<GithubItem["review"]>, string> = {
	approved: "approved",
	changes: "changes requested",
	required: "review required",
};

function ReviewBadge({ review }: { review: NonNullable<GithubItem["review"]> }): ReactNode {
	return <span className={`sh-gh-review sh-gh-review-${review}`}>{REVIEW_LABEL[review]}</span>;
}
