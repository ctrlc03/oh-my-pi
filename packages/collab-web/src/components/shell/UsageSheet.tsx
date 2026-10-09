import { LoaderCircle, RefreshCw, X } from "lucide-react";
import type { PointerEvent, ReactNode } from "react";
import { useCallback, useRef, useState } from "react";
import type { CompanionClient, UsageRange, UsageReport } from "../../lib/companion";
import { fmtCost, fmtTokens, relTime, shortenPath } from "../../lib/format";
import { readJson, writeJson } from "../../lib/storage";
import { useRequest } from "../../lib/use-request";
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
	client: CompanionClient;
	onClose(): void;
}

function storedRange(): UsageRange {
	const raw = readJson(RANGE_KEY);
	return RANGES.find(r => r.value === raw)?.value ?? DEFAULT_RANGE;
}

/** Spend and token totals across every omp session on the paired computer. */
export function UsageSheet({ client, onClose }: UsageSheetProps): ReactNode {
	const [range, setRange] = useState(storedRange);
	const [metric, setMetric] = useState<Metric>("cost");
	const load = useCallback(() => client.requestUsage(range), [client, range]);
	const { state, reload } = useRequest(load);
	// Keep the previous report on screen (dimmed) while another range loads.
	const shown = useRef<UsageReport | null>(null);
	if (state.status === "ready") shown.current = state.value;
	const report = shown.current;
	const loading = state.status === "loading";

	const pickRange = (value: UsageRange): void => {
		setRange(value);
		writeJson(RANGE_KEY, value);
	};

	return (
		<Sheet label="usage" size="wide" onClose={onClose}>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title">Usage</div>
				<span className="sh-stats-head-actions">
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={reload}
						disabled={loading}
						aria-label="refresh"
						title="refresh"
					>
						{loading ? <LoaderCircle size={15} className="sh-spin" /> : <RefreshCw size={15} />}
					</button>
					<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="close">
						<X size={16} />
					</button>
				</span>
			</div>
			<div className="sh-segmented" role="radiogroup" aria-label="time range">
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
			{state.status === "error" && (
				<div className="sh-tree-error">
					<div className="sh-connect-error">{state.message}</div>
					<button type="button" className="sh-btn" onClick={reload}>
						<RefreshCw size={14} /> Retry
					</button>
				</div>
			)}
			{report === null ? (
				state.status === "loading" && (
					<div className="sh-companion-empty sh-file-status">
						<LoaderCircle size={14} className="sh-spin" /> Reading usage… the first read can take a while.
					</div>
				)
			) : (
				<div className={loading ? "sh-stats-body sh-stats-stale" : "sh-stats-body"}>
					<Headline report={report} />
					<section className="sh-stats-section" aria-label="usage over time">
						<div className="sh-stats-section-head">
							<h2 className="sh-recents-title">Over time</h2>
							<div className="sh-segmented" role="radiogroup" aria-label="chart metric">
								{METRICS.map(m => (
									<button
										key={m.value}
										type="button"
										role="radio"
										aria-checked={metric === m.value}
										className={metric === m.value ? "sh-segment sh-segment-on" : "sh-segment"}
										onClick={() => setMetric(m.value)}
									>
										{m.label}
									</button>
								))}
							</div>
						</div>
						<BarChart key={`${report.range}:${metric}`} report={report} metric={metric} />
					</section>
					<Breakdown
						title="By model"
						rows={report.byModel.map(m => ({
							key: `${m.provider}/${m.model}`,
							name: m.model,
							sub: m.provider,
							cost: m.cost,
							tokens: m.tokens,
							requests: m.requests,
						}))}
					/>
					<Breakdown
						title="By project"
						rows={report.byProject.map(p => ({
							key: p.folder,
							name: shortenPath(p.folder),
							title: p.folder,
							cost: p.cost,
							tokens: p.tokens,
							requests: p.requests,
						}))}
					/>
					{report.overall.unpricedRequests > 0 && (
						<div className="sh-field-hint">
							{report.overall.unpricedRequests} request{report.overall.unpricedRequests === 1 ? "" : "s"} have no
							known price (subscription models) and count as $0.
						</div>
					)}
					{report.syncedAt > 0 && <div className="sh-stats-foot">synced {relTime(report.syncedAt)}</div>}
				</div>
			)}
		</Sheet>
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
