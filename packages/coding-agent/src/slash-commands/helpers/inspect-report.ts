/**
 * Text rendering of the trajectory inspector (`/inspect`) and the request preview
 * (`/preview-request`): the plain-text form for text/ACP hosts, and the one-line
 * row and detail block the TUI selector shows.
 */
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import { cacheHitPct } from "@oh-my-pi/pi-tui/chat/cache-invalidation-marker";
import type { InspectInjected, InspectRow, RequestPreview } from "@oh-my-pi/pi-wire";
import type { InspectResult } from "../../session/request-inspector";

function clock(epochMs: number): string {
	const date = new Date(epochMs);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function cachePart(row: InspectRow): string {
	const pct = cacheHitPct(row);
	return pct === undefined ? "cache -" : `cache ${Math.round(pct)}%`;
}

function timingPart(row: InspectRow): string {
	if (row.durationMs === undefined) return "no timing";
	const ttft = row.ttftMs === undefined ? "ttft -" : `ttft ${formatDuration(row.ttftMs)}`;
	return `${ttft}, total ${formatDuration(row.durationMs)}`;
}

function costPart(cost: number): string {
	return cost > 0 ? `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}` : "$0";
}

/** `#3  14:02:11  anthropic/claude-sonnet  ttft 1.2s, total 8.4s  in 12K out 540  cache 94%  $0.021  toolUse  +3`. */
export function inspectRowLine(row: InspectRow): string {
	const injected = row.injected.length > 0 ? `  +${row.injected.length}` : "";
	const flag = row.stopReason === "error" || row.stopReason === "aborted" ? ` ${row.stopReason}` : "";
	return `#${row.seq}  ${clock(row.at)}  ${row.model}  ${timingPart(row)}  in ${formatNumber(row.input + row.cacheRead + row.cacheWrite)} out ${formatNumber(row.output)}  ${cachePart(row)}  ${costPart(row.cost)}${flag}${injected}`;
}

function injectedLine(item: InspectInjected): string {
	const tokens = item.tokens > 0 ? ` (~${formatNumber(item.tokens)} tokens)` : "";
	return `- ${item.label}${tokens}`;
}

/** The detail block of one request: timing, usage, cache and what entered the context. */
export function inspectRowDetail(row: InspectRow): string {
	const lines = [
		`Request #${row.seq} · ${new Date(row.at).toLocaleString()} · ${row.model}`,
		`Stop reason: ${row.stopReason}${row.error ? ` — ${row.error}` : ""}`,
		`Timing: ${timingPart(row)}${
			row.ttftMs !== undefined && row.durationMs !== undefined
				? `, decode ${formatDuration(Math.max(0, row.durationMs - row.ttftMs))}`
				: ""
		}`,
		`Tokens: ${row.input.toLocaleString()} input, ${row.cacheRead.toLocaleString()} cache read, ${row.cacheWrite.toLocaleString()} cache write, ${row.output.toLocaleString()} output (${cachePart(row)})`,
		`Cost: ${costPart(row.cost)}`,
	];
	if (row.injected.length === 0) {
		lines.push("", "Nothing entered the context since the previous request.");
		return lines.join("\n");
	}
	lines.push("", "Entered the context since the previous request:");
	for (const item of row.injected) {
		lines.push(injectedLine(item));
		if (item.text) lines.push(...item.text.split("\n").map(line => `    ${line}`));
	}
	return lines.join("\n");
}

/** Summary over every row: request count, total cost and tokens, median time to first token, cache share. */
export function inspectSummary(rows: readonly InspectRow[]): string {
	if (rows.length === 0) return "No model requests yet.";
	let cost = 0;
	let output = 0;
	let read = 0;
	let prompt = 0;
	const ttfts: number[] = [];
	for (const row of rows) {
		cost += row.cost;
		output += row.output;
		read += row.cacheRead;
		prompt += row.input + row.cacheRead + row.cacheWrite;
		if (row.ttftMs !== undefined) ttfts.push(row.ttftMs);
	}
	ttfts.sort((a, b) => a - b);
	const median = ttfts.length === 0 ? undefined : ttfts[Math.floor(ttfts.length / 2)];
	const parts = [
		`${rows.length} request${rows.length === 1 ? "" : "s"}`,
		costPart(cost),
		`${formatNumber(prompt)} in / ${formatNumber(output)} out`,
	];
	if (median !== undefined) parts.push(`median ttft ${formatDuration(median)}`);
	if (prompt > 0) parts.push(`cache ${Math.round((read / prompt) * 100)}%`);
	return parts.join(" · ");
}

/** `/inspect` as plain text: the summary and one line per request, with the injected items beneath. */
export function formatInspectReport(result: InspectResult): string {
	const lines = [inspectSummary(result.rows)];
	if (result.total > result.rows.length) lines.push(`Showing the newest ${result.rows.length} of ${result.total}.`);
	for (const row of result.rows) {
		lines.push("", inspectRowLine(row));
		for (const item of row.injected) lines.push(`    ${injectedLine(item).slice(2)}`);
	}
	return lines.join("\n");
}

/** What the preview is, before its body: model, size and what it leaves out. */
export function previewHeader(preview: RequestPreview): string {
	const what = preview.source === "request" ? "provider request" : "request context";
	const lines = [
		`Next ${what} for ${preview.model}: ~${preview.tokens.toLocaleString()} tokens, ${preview.messages} message${preview.messages === 1 ? "" : "s"}, ${preview.tools} tool${preview.tools === 1 ? "" : "s"}. Nothing was sent.`,
	];
	if (preview.note) lines.push(preview.note);
	if (preview.truncated) lines.push("The body is cut at the size limit.");
	return lines.join("\n");
}

/** `/preview-request` as plain text. */
export function formatPreviewReport(preview: RequestPreview): string {
	return `${previewHeader(preview)}\n\n${preview.text}`;
}
