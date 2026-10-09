import { Check, LoaderCircle, RefreshCw } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useState } from "react";
import type { CompanionClient, SpendLimits } from "../../lib/companion";
import { useRequest } from "../../lib/use-request";

/** Dollars as typed: empty means no limit, anything else a positive amount. `undefined`: not a valid amount. */
function parseAmount(text: string): number | null | undefined {
	const trimmed = text.trim().replace(/^\$/, "");
	if (trimmed === "") return null;
	const amount = Number(trimmed);
	return Number.isFinite(amount) && amount > 0 ? amount : undefined;
}

const show = (limit: number | null): string => (limit === null ? "" : String(limit));

/** Spend limits the companion pushes an alert at, once per day / once per session. */
export function SpendAlerts({ client }: { client: CompanionClient }): ReactNode {
	const load = useCallback(() => client.spendLimits(), [client]);
	const { state, reload } = useRequest(load);
	return (
		<section className="sh-stats-section" aria-label="spend alerts">
			<h2 className="sh-recents-title">Spend alerts</h2>
			{state.status === "loading" && (
				<div className="sh-companion-empty sh-file-status">
					<LoaderCircle size={14} className="sh-spin" /> Loading…
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
			{state.status === "ready" && <SpendForm client={client} saved={state.value} />}
		</section>
	);
}

function SpendForm({ client, saved }: { client: CompanionClient; saved: SpendLimits }): ReactNode {
	const [current, setCurrent] = useState(saved);
	const [daily, setDaily] = useState(show(saved.dailyUsd));
	const [session, setSession] = useState(show(saved.sessionUsd));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const dailyUsd = parseAmount(daily);
	const sessionUsd = parseAmount(session);
	const valid = dailyUsd !== undefined && sessionUsd !== undefined;
	const changed = valid && (dailyUsd !== current.dailyUsd || sessionUsd !== current.sessionUsd);

	const save = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
		e.preventDefault();
		if (!changed) return;
		setBusy(true);
		setError(null);
		try {
			setCurrent(await client.spendLimits({ dailyUsd, sessionUsd }));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<form className="sh-spend" onSubmit={e => void save(e)}>
			<label className="sh-spend-field">
				<span className="sh-field-label">Per day, all sessions</span>
				<input
					className="sh-input"
					value={daily}
					onChange={e => setDaily(e.currentTarget.value)}
					placeholder="No limit"
					inputMode="decimal"
					aria-invalid={dailyUsd === undefined}
				/>
			</label>
			<label className="sh-spend-field">
				<span className="sh-field-label">Per session</span>
				<input
					className="sh-input"
					value={session}
					onChange={e => setSession(e.currentTarget.value)}
					placeholder="No limit"
					inputMode="decimal"
					aria-invalid={sessionUsd === undefined}
				/>
			</label>
			<button type="submit" className="sh-btn" disabled={busy || !changed}>
				{busy ? <LoaderCircle size={14} className="sh-spin" /> : <Check size={14} />} Save
			</button>
			<div className="sh-field-hint">
				US dollars; leave empty for no limit. Each limit notifies once (the daily one once per day, from local
				midnight), so turn notifications on for this computer. Spend is checked about every five minutes.
			</div>
			{!valid && <div className="sh-connect-error">Enter a positive amount, or leave the field empty.</div>}
			{error && <div className="sh-connect-error">{error}</div>}
		</form>
	);
}
