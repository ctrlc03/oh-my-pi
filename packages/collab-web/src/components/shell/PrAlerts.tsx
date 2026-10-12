import { LoaderCircle, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import type { CompanionClient, PrAlertSettings } from "../../lib/companion";
import { useRequest } from "../../lib/use-request";

/** Whether the companion pushes when checks finish or reviews and comments arrive on the user's open pull requests. */
export function PrAlerts({ client }: { client: CompanionClient }): ReactNode {
	const load = useCallback(() => client.prAlerts(), [client]);
	const { state, reload } = useRequest(load);
	return (
		<>
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
			{state.status === "ready" && <PrAlertsForm client={client} saved={state.value} />}
		</>
	);
}

function PrAlertsForm({ client, saved }: { client: CompanionClient; saved: PrAlertSettings }): ReactNode {
	const [current, setCurrent] = useState(saved);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const toggle = async (key: keyof PrAlertSettings, on: boolean): Promise<void> => {
		setBusy(true);
		setError(null);
		try {
			setCurrent(await client.prAlerts({ ...current, [key]: on }));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="sh-spend">
			<label className="sh-start-sandbox">
				<input
					type="checkbox"
					checked={current.checks}
					disabled={busy}
					onChange={e => void toggle("checks", e.currentTarget.checked)}
				/>
				<span className="sh-start-sandbox-text">
					<span className="sh-start-sandbox-title">Checks finished</span>
					<span className="sh-field-hint">When the checks of one of your open pull requests pass or fail.</span>
				</span>
			</label>
			<label className="sh-start-sandbox">
				<input
					type="checkbox"
					checked={current.reviews}
					disabled={busy}
					onChange={e => void toggle("reviews", e.currentTarget.checked)}
				/>
				<span className="sh-start-sandbox-text">
					<span className="sh-start-sandbox-title">Reviews &amp; comments</span>
					<span className="sh-field-hint">When someone else reviews or comments on one of them.</span>
				</span>
			</label>
			<div className="sh-field-hint">
				Pull requests are looked up in the repositories of your sessions through the computer's signed-in gh, every
				few minutes, and notify this computer's subscribed devices. Turn notifications on for this computer.
			</div>
			{error && <div className="sh-connect-error">{error}</div>}
		</div>
	);
}
