import { Check, Copy, LoaderCircle, RefreshCw, WifiOff } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { spendBar } from "../../lib/personal";
import type { PersonalQuery } from "../../lib/use-personal";
import { usePersonal } from "../../lib/use-personal";
import type { PersonalSpendWindow } from "@oh-my-pi/pi-wire/personal";
import "./personal.css";

/** A spend window as a labelled bar (the usage sheet's meter), turning amber at the warning level and red when capped. */
export function SpendMeter({ title, window }: { title: string; window: PersonalSpendWindow }): ReactNode {
	const bar = spendBar(window);
	const fill = bar.level === "capped" ? " sh-limit-full" : bar.level === "warning" ? " sh-limit-low" : "";
	return (
		<div className="pa-meter">
			<div className="sh-limit-line">
				<span className="sh-limit-label">{title}</span>
				<span className={`sh-limit-pct${fill}`}>{bar.text}</span>
			</div>
			<div
				className="sh-limit-meter"
				role="meter"
				aria-label={`${title} spend`}
				aria-valuemin={0}
				aria-valuemax={window.limitUsd ?? 0}
				aria-valuenow={window.usd}
				aria-valuetext={bar.text}
			>
				<div
					className={`sh-limit-fill${fill}`}
					style={{ "--used": `${Math.round(bar.share * 100)}%` } as CSSProperties}
				/>
			</div>
			{bar.level === "warning" && (
				<div className="sh-field-hint">Close to the limit. Personal stops taking new prompts at 100%.</div>
			)}
			{bar.level === "capped" && (
				<div className="pa-note pa-note-err">
					Limit reached. Personal takes no new prompts until the window passes or you raise the limit.
				</div>
			)}
		</div>
	);
}

/** A command in a box with a copy button. */
export function CopyLine({ text, label }: { text: string; label: string }): ReactNode {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 2_000);
		return () => clearTimeout(timer);
	}, [copied]);
	return (
		<span className="pa-copy">
			<code className="pa-copy-text">{text}</code>
			<button
				type="button"
				className="sh-btn sh-btn-icon"
				aria-label={label}
				onClick={() => {
					navigator.clipboard.writeText(text).then(
						() => setCopied(true),
						() => setCopied(false),
					);
				}}
			>
				{copied ? <Check size={15} /> : <Copy size={15} />}
			</button>
		</span>
	);
}

/**
 * Renders `children` while the home computer is reachable; otherwise a calm line saying it is offline (never an error,
 * never retried in a loop: the app asks again when the computer comes back).
 */
export function HomeGate({ children }: { children: ReactNode }): ReactNode {
	const personal = usePersonal();
	if (personal.client !== null) return children;
	const name = personal.home.computer?.name ?? "The home computer";
	return (
		<div className="pa-offline" role="status">
			<WifiOff size={16} aria-hidden="true" />
			<div>
				<div className="pa-offline-title">
					{personal.home.computer === null ? "No home computer yet" : `${name} is offline`}
				</div>
				<div className="sh-field-hint">
					{personal.home.computer === null
						? "Set up Personal first."
						: "Personal and its memory live on that computer. Open it, or wait for it to come back; this screen updates by itself."}
				</div>
			</div>
		</div>
	);
}

/** A loading line, or the error with Retry, or `children(value)` for a ready query. */
export function QueryView<T>({
	query,
	what,
	children,
}: {
	query: PersonalQuery<T>;
	/** The thing loading, for the status line: "the memory". */
	what: string;
	children(value: T, refreshing: boolean): ReactNode;
}): ReactNode {
	const { state, refreshing, reload } = query;
	if (state.status === "loading") {
		return (
			<div className="sh-companion-empty sh-file-status" role="status">
				<LoaderCircle size={14} className="sh-spin" /> Loading {what}…
			</div>
		);
	}
	if (state.status === "error") {
		return (
			<div className="sh-tree-error">
				<div className="sh-connect-error">{state.message}</div>
				<button type="button" className="sh-btn" onClick={reload}>
					<RefreshCw size={14} /> Retry
				</button>
			</div>
		);
	}
	return children(state.value, refreshing);
}

export interface Action {
	busy: boolean;
	error: string | null;
	/** Runs `work` once at a time; its failure becomes `error`. Resolves with whether it succeeded. */
	run(work: () => Promise<unknown>): Promise<boolean>;
	clear(): void;
}

/** One button's worth of async work: busy while it runs, the failure kept as a readable message. Stops reporting once unmounted. */
export function useAction(): Action {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const alive = useRef(true);
	const running = useRef(false);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);
	const run = useCallback(async (work: () => Promise<unknown>): Promise<boolean> => {
		if (running.current) return false;
		running.current = true;
		setBusy(true);
		setError(null);
		try {
			await work();
			return true;
		} catch (err) {
			if (alive.current) setError(err instanceof Error ? err.message : String(err));
			return false;
		} finally {
			running.current = false;
			if (alive.current) setBusy(false);
		}
	}, []);
	const clear = useCallback(() => setError(null), []);
	return { busy, error, run, clear };
}
