import { HIBERNATE_AFTER_CHOICES, type HibernateSettings as Settings, hibernateAfterLabel } from "@oh-my-pi/pi-wire/hibernate";
import { LoaderCircle, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import type { CompanionClient } from "../../lib/companion";
import { useRequest } from "../../lib/use-request";
import { Choice, SettingsRow } from "../settings/SettingsRows";

const OPTIONS = HIBERNATE_AFTER_CHOICES.map(minutes => ({ value: minutes, label: hibernateAfterLabel(minutes) }));

/** The computer's session hibernation: how long a finished session may sit idle before its omp process is stopped (needs `canHibernate`). */
export function HibernateSettings({
	client,
	computerName,
}: {
	client: CompanionClient;
	/** The computer's name, given when several are paired so the text can say which one; undefined: "the computer". */
	computerName?: string;
}): ReactNode {
	const load = useCallback(() => client.hibernateSettings(), [client]);
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
	return <HibernateForm client={client} saved={state.value} computerName={computerName} />;
}

function HibernateForm({
	client,
	saved,
	computerName,
}: {
	client: CompanionClient;
	saved: Settings;
	computerName: string | undefined;
}): ReactNode {
	const [current, setCurrent] = useState(saved);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const choose = (afterMinutes: number): void => {
		if (busy || afterMinutes === current.afterMinutes) return;
		setBusy(true);
		setError(null);
		client
			.hibernateSettings({ afterMinutes })
			.then(setCurrent, (err: unknown) => setError(err instanceof Error ? err.message : String(err)))
			.finally(() => setBusy(false));
	};

	return (
		<>
			<SettingsRow
				label="Hibernate idle sessions after"
				hint={
					<>
						A session {computerName === undefined ? "your computer" : computerName} started that has finished its work,
						has nothing running in the background and is not open anywhere is stopped to free memory. Opening it, or
						sending it a message, resumes it where it left off. Sessions waiting for an answer, watching a pull
						request or open in a terminal are never hibernated.
					</>
				}
			>
				<Choice label="Hibernate idle sessions after" value={current.afterMinutes} options={OPTIONS} onChange={choose} />
			</SettingsRow>
			{error !== null && <div className="sh-connect-error">{error}</div>}
		</>
	);
}
