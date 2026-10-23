import { Laptop, LoaderCircle, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { ComputerHandle } from "../../lib/computers";
import { AddComputer } from "../shell/AddComputer";
import { VmSettings } from "../shell/VmSettings";
import type { SettingsEnv } from "./env";
import { ComputerGate, SettingsGroup } from "./SettingsRows";

/** Why a computer is not usable right now, or null while it is connected. */
function reasonOf(computer: ComputerHandle): string | null {
	const { snap } = computer;
	if (snap.phase === "live") return null;
	if (snap.phase === "connecting") return "Connecting…";
	return computer.error ?? snap.error ?? (snap.phase === "unpaired" ? "Needs pairing again" : "Not reachable");
}

function stateLabel(computer: ComputerHandle): string {
	switch (computer.snap.phase) {
		case "live":
			return "Online";
		case "connecting":
			return "Connecting";
		case "unpaired":
			return "Needs pairing";
		case "offline":
			return "Offline";
	}
}

function ComputerRow({
	computer,
	onRemove,
}: {
	computer: ComputerHandle;
	onRemove(id: string): Promise<void>;
}): ReactNode {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const { phase } = computer.snap;
	const reason = reasonOf(computer);

	const remove = async (): Promise<void> => {
		if (busy) return;
		const ok = window.confirm(
			`Remove ${computer.name}? Its sessions leave this app, and this device is signed out of it when it is reachable. Pair again to bring it back.`,
		);
		if (!ok) return;
		setBusy(true);
		setError(null);
		try {
			await onRemove(computer.id);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setBusy(false);
		}
	};

	return (
		<li className="sh-set-computer">
			<div className="sh-set-computer-main">
				<Laptop size={16} aria-hidden="true" />
				<div className="sh-set-computer-text">
					<div className="sh-set-computer-name">
						{computer.name}
						<span
							className={
								phase === "live"
									? "sh-dot sh-dot-live"
									: phase === "connecting"
										? "sh-dot sh-dot-connecting"
										: "sh-dot"
							}
							role="img"
							aria-label={stateLabel(computer)}
						/>
					</div>
					{reason !== null && <div className="sh-field-hint">{reason}</div>}
				</div>
				<button
					type="button"
					className="sh-btn"
					onClick={() => void remove()}
					disabled={busy}
					aria-label={`Remove ${computer.name}`}
				>
					{busy ? <LoaderCircle size={14} className="sh-spin" /> : <Trash2 size={14} />} Remove
				</button>
			</div>
			{error && <div className="sh-connect-error">{error}</div>}
		</li>
	);
}

/** The paired computers, and where the first (or another) is added. */
export function ComputersSection({ env }: { env: SettingsEnv }): ReactNode {
	const { computers, onPair, onRemoveComputer } = env;
	const [added, setAdded] = useState(false);
	return (
		<>
			<SettingsGroup title="Paired computers">
				{computers.length === 0 ? (
					<p className="sh-field-hint">No computer is paired yet.</p>
				) : (
					<ul className="sh-set-computers" aria-label="Paired computers">
						{computers.map(computer => (
							<ComputerRow key={computer.id} computer={computer} onRemove={onRemoveComputer} />
						))}
					</ul>
				)}
			</SettingsGroup>
			{computers
				.filter(computer => computer.snap.canVms)
				.map(computer => (
					<SettingsGroup
						key={computer.id}
						title={computers.length > 1 ? `Virtual machines on ${computer.name}` : "Virtual machines"}
					>
						<ComputerGate computer={computer} named={computers.length > 1}>
							{client => (
								<VmSettings
									client={client}
									computerName={computers.length > 1 ? computer.name : undefined}
									onPair={onPair}
								/>
							)}
						</ComputerGate>
					</SettingsGroup>
				))}
			<SettingsGroup title="Add a computer">
				<AddComputer
					computers={computers}
					onPair={link => {
						setAdded(false);
						onPair(link);
					}}
					onPaired={() => setAdded(true)}
				/>
				{added && (
					<p className="sh-field-hint" role="status">
						Computer added.
					</p>
				)}
			</SettingsGroup>
		</>
	);
}
