import { LoaderCircle, RefreshCw, X } from "lucide-react";
import type { PointerEvent, ReactNode } from "react";
import { useState } from "react";
import type { UsageRange, UsageReport } from "../../lib/companion";
import type { ComputerHandle } from "../../lib/computers";
import { fmtCost, fmtTokens, relTime, shortenPath } from "../../lib/format";
import { readJson, writeJson } from "../../lib/storage";
import { combineUsage, seriesAligned } from "../../lib/usage-combine";
import { useComputerRequests } from "../../lib/use-computer-requests";
import { LimitWindows, type LimitWindowsProps } from "./LimitWindows";
import { Sheet } from "./Sheet";
import "./stats.css";

const RANGE_KEY = "omp.collab.usageRange";
const DEFAULT_RANGE: UsageRange = "7d";
const RANGES: { value: UsageRange; label: string }[] = [
	{ value: "24h", label: "24h" },
	{ value: "7d", label: "7d" },
	{ value: "30d", label: "30d" },
	{ value: "90d", label: "90d" },
	{ value: "all", label: "All" },
];

type Metric = "cost" | "tokens";
const METRICS: { value: Metric; label: string }[] = [
	{ value: "cost", label: "Cost" },
	{ value: "tokens", label: "Tokens" },
];

export interface UsageSheetProps {
	computers: readonly ComputerHandle[];
	/** The open session's subscription limit windows (host feature `usage-limits`); absent hides the Limits section. */
	limits?: LimitWindowsProps;
	/** The computer that hosts the open session, whose limits these are; limits show only where that computer's usage does. */
	limitsComputerId?: string;
	onClose(): void;
}

function storedRange(): UsageRange {
	const raw = readJson(RANGE_KEY);
	return RANGES.find(r => r.value === raw)?.value ?? DEFAULT_RANGE;
}

/** One computer's report. */
interface ComputerReport {
	computer: ComputerHandle;
	report: UsageReport;
}

/** Spend and token totals across every omp session on the paired computers, all together or one at a time. */
export function UsageSheet({ computers, limits, limitsComputerId, onClose }: UsageSheetProps): ReactNode {
	const [range, setRange] = useState(storedRange);
	const [metric, setMetric] = useState<Metric>("cost");
	// null: all computers together.
	const [picked, setPicked] = useState<string | null>(null);
	// Another range asks again; the last report of each computer stays on screen (dimmed) meanwhile.
	const { entries, loading, reload } = useComputerRequests(
		computers,
		null,
		client => client.requestUsage(range),
		range,
	);
	const several = computers.length > 1;
	const view = several
		? computers.some(computer => computer.id === picked)
			? picked
			: null
		: (computers[0]?.id ?? null);
	const shown = view === null ? entries : entries.filter(entry => entry.computer.id === view);
	const reports = shown.flatMap(({ computer, state }) =>
		state?.status === "ready" ? [{ computer, report: state.value }] : [],
	);
	const reading = shown.some(entry => entry.state?.status === "loading");
	// Limits belong to the computer that hosts the open session: with several, only where its usage is shown.
	const limitsHere =
		!several || limitsComputerId === undefined || shown.some(entry => entry.computer.id === limitsComputerId);
	const limitsHost = computers.find(computer => computer.id === limitsComputerId);

	const pickRange = (value: UsageRange): void => {
		setRange(value);
		writeJson(RANGE_KEY, value);
	};

	return (
		<Sheet label="Usage" size="wide" onClose={onClose}>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title">Usage</div>
				<span className="sh-stats-head-actions">
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={reload}
						disabled={loading}
						aria-label="Refresh"
					>
						{loading ? <LoaderCircle size={15} className="sh-spin" /> : <RefreshCw size={15} />}
					</button>
					<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="Close">
						<X size={16} />
					</button>
				</span>
			</div>
			{several && (
				<div className="sh-segmented sh-segmented-wrap" role="radiogroup" aria-label="Computer">
					<button
						type="button"
						role="radio"
						aria-checked={view === null}
						className={view === null ? "sh-segment sh-segment-on" : "sh-segment"}
						onClick={() => setPicked(null)}
					>
						All computers
					</button>
					{computers.map(computer => (
						<button
							key={computer.id}
							type="button"
							role="radio"
							aria-checked={view === computer.id}
							className={view === computer.id ? "sh-segment sh-segment-on" : "sh-segment"}
							onClick={() => setPicked(computer.id)}
						>
							{computer.name}
						</button>
					))}
				</div>
			)}
			{limits !== undefined && limitsHere && (
				<>
					{several && view === null && limitsHost !== undefined && (
						<div className="sh-field-hint">Limits of {limitsHost.name}</div>
					)}
					<LimitWindows {...limits} />
				</>
			)}
			<div className="sh-segmented sh-segmented-fill" role="radiogroup" aria-label="Time range">
				{RANGES.map(r => (
					<button
						key={r.value}
						type="button"
						role="radio"
						aria-checked={range === r.value}
						className={range === r.value ? "sh-segment sh-segment-on" : "sh-segment"}
						onClick={() => pickRange(r.value)}
					>
						{r.label}
					</button>
				))}
			</div>
			{shown.map(({ computer, state, reason }) => {
				const name = several ? `${computer.name}: ` : "";
				if (state?.status === "error")
					return (
						<div key={computer.id} className="sh-tree-error">
							<div className="sh-connect-error">
								{name}
								{state.message}
							</div>
							<button type="button" className="sh-btn" onClick={reload}>
								<RefreshCw size={14} /> Retry
							</button>
						</div>
					);
				return reason !== null ? (
					<div key={computer.id} className="sh-field-hint">
						{name}
						{reason}
					</div>
				) : null;
			})}
			{reports.length === 0 ? (
				reading && (
					<div className="sh-companion-empty sh-file-status">
						<LoaderCircle size={14} className="sh-spin" /> Reading usage… the first read can take a while.
					</div>
				)
			) : (
				<div className={loading ? "sh-stats-body sh-stats-stale" : "sh-stats-body"}>
					<UsageBody reports={reports} grouped={view === null} metric={metric} onMetric={setMetric} />
				</div>
			)}
		</Sheet>
	);
}

/** The report of one computer, or the totals of several (`grouped`: the computers are named where their data stays apart). */
function UsageBody({
	reports,
	grouped,
	metric,
	onMetric,
}: {
	reports: readonly ComputerReport[];
	grouped: boolean;
	metric: Metric;
	onMetric(metric: Metric): void;
}): ReactNode {
	const combined = combineUsage(reports.map(entry => entry.report));
	if (combined === null) return null;
	// One computer reports as itself; several are added up (the folder breakdown stays per computer).
	const named = grouped && reports.length > 1;
	const charts = named && !seriesAligned(reports.map(entry => entry.report)) ? reports : null;
	const projects = (entry: ComputerReport, title: string): ReactNode => (
		<Breakdown
			key={entry.computer.id}
			title={title}
			rows={entry.report.byProject.map(p => ({
				key: p.folder,
				name: shortenPath(p.folder),
				title: p.folder,
				cost: p.cost,
				tokens: p.tokens,
				requests: p.requests,
			}))}
		/>
	);
	return (
		<>
			<Headline report={combined} />
			<section className="sh-stats-section" aria-label="Usage over time">
				<div className="sh-stats-section-head">
					<h2 className="sh-recents-title">Over time</h2>
					<div className="sh-segmented" role="radiogroup" aria-label="Chart metric">
						{METRICS.map(m => (
							<button
								key={m.value}
								type="button"
								role="radio"
								aria-checked={metric === m.value}
								className={metric === m.value ? "sh-segment sh-segment-on" : "sh-segment"}
								onClick={() => onMetric(m.value)}
							>
								{m.label}
							</button>
						))}
					</div>
				</div>
				{charts === null ? (
					<BarChart key={`${combined.range}:${metric}`} report={combined} metric={metric} />
				) : (
					charts.map(entry => (
						<div key={entry.computer.id} className="sh-usage-computer">
							<div className="sh-field-hint">{entry.computer.name}</div>
							<BarChart key={`${entry.report.range}:${metric}`} report={entry.report} metric={metric} />
						</div>
					))
				)}
			</section>
			<Breakdown
				title="By model"
				rows={combined.byModel.map(m => ({
					key: `${m.provider}/${m.model}`,
					name: m.model,
					sub: m.provider,
					cost: m.cost,
					tokens: m.tokens,
					requests: m.requests,
				}))}
			/>
			{reports.map(entry => projects(entry, named ? `By project · ${entry.computer.name}` : "By project"))}
			{combined.overall.unpricedRequests > 0 && (
				<div className="sh-field-hint">
					{combined.overall.unpricedRequests} request
					{combined.overall.unpricedRequests === 1 ? " has" : "s have"} no known price (subscription models) and{" "}
					{combined.overall.unpricedRequests === 1 ? "counts" : "count"} as $0.
				</div>
			)}
			{reports.map(
				entry =>
					entry.report.syncedAt > 0 && (
						<div key={entry.computer.id} className="sh-stats-foot">
							{named ? `${entry.computer.name} · ` : ""}Synced {relTime(entry.report.syncedAt)}
						</div>
					),
			)}
		</>
	);
}

function Headline({ report }: { report: UsageReport }): ReactNode {
	const { overall } = report;
	const cells = [
		{ label: "Cost", value: fmtCost(overall.cost) },
		{ label: "Tokens", value: fmtTokens(overall.totalTokens) },
		{ label: "Requests", value: overall.requests.toLocaleString() },
		// One decimal: prompt caching keeps real sessions in the high 90s, where whole percents read "100%".
		{ label: "Cache hit", value: `${(Math.min(1, Math.max(0, overall.cacheRate)) * 100).toFixed(1)}%` },
	];
	return (
		<dl className="sh-stats-headline">
			{cells.map(cell => (
				<div key={cell.label} className="sh-stats-cell">
					<dd className="sh-stats-value">{cell.value}</dd>
					<dt className="sh-stats-label">{cell.label}</dt>
				</div>
			))}
		</dl>
	);
}

function bucketLabel(t: number, hourly: boolean): string {
	const date = new Date(t);
	return hourly
		? `${date.toLocaleDateString([], { weekday: "short" })} ${date.toLocaleTimeString([], { hour: "numeric" })}`
		: date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

/** One bar per bucket as stretched SVG rects; text stays in HTML so it never distorts. */
function BarChart({ report, metric }: { report: UsageReport; metric: Metric }): ReactNode {
	const { series } = report;
	const [picked, setPicked] = useState<number | null>(null);
	const hourly = report.range === "24h";
	const values = series.map(p => (metric === "cost" ? p.cost : p.tokens));
	const max = Math.max(...values, 0);
	const fmt = metric === "cost" ? fmtCost : fmtTokens;
	const point = picked === null ? null : series[picked];

	const pick = (e: PointerEvent<HTMLDivElement>): void => {
		const box = e.currentTarget.getBoundingClientRect();
		const at = Math.floor(((e.clientX - box.left) / box.width) * series.length);
		setPicked(Math.min(series.length - 1, Math.max(0, at)));
	};

	if (series.length === 0 || max === 0) return <div className="sh-companion-empty">No usage in this range.</div>;
	return (
		<div className="sh-stats-chart">
			<div className="sh-stats-readout" aria-live="polite">
				{point ? (
					<>
						<span>{bucketLabel(point.t, hourly)}</span>
						<span className="sh-stats-readout-num">
							{fmtCost(point.cost)} · {fmtTokens(point.tokens)} tokens · {point.requests} req
						</span>
					</>
				) : (
					<span className="sh-stats-hint">Tap a bar for details</span>
				)}
			</div>
			<div
				className="sh-stats-plot"
				onPointerDown={pick}
				onPointerMove={e => e.pointerType === "mouse" && pick(e)}
				onPointerLeave={e => e.pointerType === "mouse" && setPicked(null)}
			>
				<span className="sh-stats-axis-max">{fmt(max)}</span>
				<svg
					viewBox={`0 0 ${series.length} 100`}
					preserveAspectRatio="none"
					className="sh-stats-svg"
					role="img"
					aria-label={`${metric} per ${hourly ? "hour" : "day"}, peak ${fmt(max)}`}
				>
					{values.map((value, i) => {
						const h = Math.max(value > 0 ? 1.5 : 0, (value / max) * 100);
						return (
							<rect
								key={series[i].t}
								className={i === picked ? "sh-stats-bar sh-stats-bar-on" : "sh-stats-bar"}
								x={i + 0.1}
								y={100 - h}
								width={0.8}
								height={h}
							/>
						);
					})}
				</svg>
			</div>
			<div className="sh-stats-axis">
				<span>{bucketLabel(series[0].t, hourly)}</span>
				<span>{bucketLabel(series[series.length - 1].t, hourly)}</span>
			</div>
		</div>
	);
}

interface BreakdownRow {
	key: string;
	name: string;
	sub?: string;
	/** Full text for the hover title when `name` is shortened. */
	title?: string;
	cost: number;
	tokens: number;
	requests: number;
}

/** Rows ranked by spend, each with a bar sized against the largest. */
function Breakdown({ title, rows }: { title: string; rows: BreakdownRow[] }): ReactNode {
	if (rows.length === 0) return null;
	const max = Math.max(...rows.map(r => r.cost), 0);
	return (
		<section className="sh-stats-section" aria-label={title}>
			<h2 className="sh-recents-title">{title}</h2>
			<ul className="sh-stats-rows">
				{rows.map(row => (
					<li key={row.key} className="sh-stats-row" title={row.title ?? row.name}>
						<div className="sh-stats-row-line">
							<span className="sh-stats-row-name">
								{row.name}
								{row.sub && <span className="sh-stats-row-sub">{row.sub}</span>}
							</span>
							<span className="sh-stats-row-cost">{fmtCost(row.cost)}</span>
						</div>
						<div className="sh-stats-meter" aria-hidden>
							<span
								className="sh-stats-meter-fill"
								style={{ width: `${max > 0 ? (row.cost / max) * 100 : 0}%` }}
							/>
						</div>
						<div className="sh-stats-row-meta">
							{fmtTokens(row.tokens)} tokens · {row.requests.toLocaleString()} req
						</div>
					</li>
				))}
			</ul>
		</section>
	);
}
