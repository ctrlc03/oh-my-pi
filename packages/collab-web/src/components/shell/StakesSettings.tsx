import { isPassMark, STAKES_MAX_PASS_MARK, STAKES_MIN_PASS_MARK } from "@oh-my-pi/pi-wire/stakes";
import { Check, LoaderCircle, RefreshCw } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useState } from "react";
import type { CompanionClient } from "../../lib/companion";
import { useRequest } from "../../lib/use-request";

/** The computer's high-stakes setting: the share of a quiz's points that passes it (needs `canHighStakes`). */
export function StakesSettings({ client }: { client: CompanionClient }): ReactNode {
	const load = useCallback(() => client.stakesSettings(), [client]);
	const { state, reload } = useRequest(load);
	if (state.status === "loading") {
		return (
			<div className="sh-companion-empty sh-file-status">
				<LoaderCircle size={14} className="sh-spin" /> Loading…
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
	return <PassMarkForm client={client} saved={state.value.passMark} />;
}

function PassMarkForm({ client, saved }: { client: CompanionClient; saved: number }): ReactNode {
	const [current, setCurrent] = useState(saved);
	const [draft, setDraft] = useState(String(saved));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const value = draft.trim() === "" ? Number.NaN : Number(draft);
	const valid = isPassMark(value);
	const changed = valid && value !== current;

	const save = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
		e.preventDefault();
		if (!changed) return;
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const settings = await client.stakesSettings(value);
			setCurrent(settings.passMark);
			setDraft(String(settings.passMark));
			setNotice("Saved.");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<form className="sh-spend" onSubmit={e => void save(e)}>
			<label className="sh-field">
				<span className="sh-field-label">Pass mark</span>
				<span className="sh-review-draft">
					<input
						className="sh-input"
						type="number"
						min={STAKES_MIN_PASS_MARK}
						max={STAKES_MAX_PASS_MARK}
						step={1}
						inputMode="numeric"
						value={draft}
						onChange={e => {
							setDraft(e.currentTarget.value);
							setNotice(null);
						}}
						aria-label="Pass mark"
						aria-invalid={!valid}
					/>
					%
				</span>
				<span className="sh-field-hint">Quizzes for high-stakes sessions need this share of the points.</span>
			</label>
			{!valid && (
				<div className="sh-connect-error" role="alert">
					Use a whole percent from {STAKES_MIN_PASS_MARK} to {STAKES_MAX_PASS_MARK}.
				</div>
			)}
			<div className="sh-review-confirm-actions">
				<button type="submit" className="sh-btn sh-btn-primary" disabled={busy || !changed}>
					{busy ? <LoaderCircle size={14} className="sh-spin" /> : <Check size={14} />} Save
				</button>
			</div>
			{notice && <div className="sh-field-hint">{notice}</div>}
			{error && <div className="sh-connect-error">{error}</div>}
		</form>
	);
}
