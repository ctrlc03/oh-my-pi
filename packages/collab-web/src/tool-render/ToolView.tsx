/**
 * Tool card chrome + per-tool dispatch. Works in the collab-web app and inside
 * the `<omp-tool-view>` web component embedded in HTML session exports.
 */
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import type { ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { resolveToolRenderer } from "./registry";
import type { ToolRenderHost, ToolRenderProps, ToolResultLike } from "./types";
import { isRecord, replaceTabs, stripAnsi } from "./util";
import "./tool-render.css";

export interface ToolViewProps {
	name: string;
	args?: unknown;
	result?: ToolResultLike;
	/** Tool is still executing (live collab view). */
	running?: boolean;
	/** Model-provided intent (`i`), shown atop the body. */
	intent?: string;
	/** Streaming partial output tail while running. */
	partial?: string;
	defaultOpen?: boolean;
	/** Host capabilities (sub-session drill-down, …). */
	host?: ToolRenderHost;
	/** Replaces the card header: a host that frames the card itself (the transcript's blocks) draws its own. */
	head?: (state: ToolHeadState) => ReactNode;
}

/** What a host-drawn card header needs: the display name and one-line summary, the status, and the open state with its toggle. */
export interface ToolHeadState {
	name: string;
	status: "run" | "err" | "ok" | "pending";
	open: boolean;
	toggle(): void;
	intent: string | undefined;
	summary: ReactNode;
}

function normalizeArgs(raw: unknown): { args: Record<string, unknown>; intent: string | undefined } {
	if (!isRecord(raw)) return { args: {}, intent: undefined };
	const intent = typeof raw[INTENT_FIELD] === "string" ? (raw[INTENT_FIELD] as string).trim() : undefined;
	if (!(INTENT_FIELD in raw)) return { args: raw, intent };
	const args: Record<string, unknown> = {};
	for (const k in raw) {
		if (k !== INTENT_FIELD) args[k] = raw[k];
	}
	return { args, intent };
}

export interface XdevDispatch {
	tool: string;
	args: Record<string, unknown>;
	inner: unknown;
}

/** The device tool a successful `write xd://<tool>` call ran, with its own args and details. */
export function executeXdevDispatch(name: string, result: ToolResultLike | undefined): XdevDispatch | null {
	if (name !== "write" || result?.isError === true || !isRecord(result?.details)) return null;
	const xdev = result.details.xdev;
	if (!isRecord(xdev) || xdev.mode !== "execute" || typeof xdev.tool !== "string") return null;
	return { tool: xdev.tool, args: isRecord(xdev.args) ? xdev.args : {}, inner: xdev.inner };
}

/** Lines of live output shown under a running tool. */
const PARTIAL_LINES = 10;
/** Character cap on those lines, for output without line breaks. */
const PARTIAL_CHARS = 2048;

/**
 * The newest lines of a running tool's output. Hosts send the whole rolling
 * buffer on every update, and progress meters (downloads, installs) arrive as a
 * new line per redraw, so only the tail is worth rendering.
 */
function partialTail(text: string): string {
	const end = text.trimEnd();
	let start = end.length;
	for (let i = 0; i < PARTIAL_LINES && start > 0; i++) start = end.lastIndexOf("\n", start - 1);
	const tail = start < 0 ? end : end.slice(start + 1);
	const clean = stripAnsi(replaceTabs(tail));
	return clean.length > PARTIAL_CHARS ? `…${clean.slice(-PARTIAL_CHARS)}` : clean;
}

export function ToolView(props: ToolViewProps): ReactNode {
	const [open, setOpen] = useState(props.defaultOpen ?? false);
	const xdev = executeXdevDispatch(props.name, props.result);
	const { args, intent: argIntent } = normalizeArgs(props.args);
	const intent = props.intent?.trim() || argIntent;
	const name = xdev?.tool ?? props.name;
	const result = xdev
		? { content: props.result!.content, details: xdev.inner, isError: props.result!.isError }
		: props.result;
	const renderer = resolveToolRenderer(name);
	const renderProps: ToolRenderProps = {
		name,
		args: xdev?.args ?? args,
		result,
		running: props.running,
		host: props.host,
	};

	const isError = props.result?.isError === true;
	const status = props.running ? "run" : isError ? "err" : props.result ? "ok" : "pending";
	const partial = props.running && !props.result && props.partial ? partialTail(props.partial) : "";
	const partialView = useRef<HTMLPreElement>(null);
	// Keep the newest line in view as output streams; wrapped lines can still overflow the box.
	useLayoutEffect(() => {
		const view = partialView.current;
		if (view) view.scrollTop = view.scrollHeight;
	}, [partial]);

	return (
		<div className={`tv-card${isError ? " tv-card--error" : ""}`}>
			{props.head ? (
				props.head({
					name: xdev ? `xd://${name}` : name,
					status,
					open,
					toggle: () => setOpen(v => !v),
					intent: intent || undefined,
					summary: <renderer.Summary {...renderProps} />,
				})
			) : (
				<button
					type="button"
					className="tv-head"
					aria-expanded={open}
					onClick={() => setOpen(v => !v)}
					title={intent || undefined}
				>
					{status === "run" ? (
						<span className="tv-spin" aria-label="running" />
					) : (
						<span className={`tv-status tv-status--${status}`} aria-hidden="true" />
					)}
					<span className="tv-name">{xdev ? `xd://${name}` : name}</span>
					<span className="tv-sum">
						<renderer.Summary {...renderProps} />
					</span>
					<span className="tv-chev" aria-hidden="true" />
				</button>
			)}
			{open && (
				<div className="tv-body">
					{intent && <div className="tv-intent">{intent}</div>}
					{renderer.Body ? <renderer.Body {...renderProps} /> : null}
				</div>
			)}
			{partial && (
				<pre ref={partialView} className="tv-partial">
					{partial}
				</pre>
			)}
		</div>
	);
}
