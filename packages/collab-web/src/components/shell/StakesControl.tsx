import type { StakesStatus } from "@oh-my-pi/pi-wire/stakes";
import { GraduationCap, LoaderCircle, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { CompanionClient } from "../../lib/companion";
import { type StakesGate, stakesDetail, stakesGateLine, takeQuizLabel } from "../../lib/stakes";
import { Sheet } from "./Sheet";
import "./stakes.css";

/** What the app needs to show and change one session's high-stakes mode. */
export interface StakesControl {
	client: CompanionClient;
	/** The session's host on its computer. */
	instanceId: string;
	/** The mode, as the computer's host list reports it. */
	on: boolean;
}

const CHIP_TIP = "High stakes: pushes and pull requests need a passed quiz";

/** A session that is high stakes, in the same place and weight as the sandboxed chip. */
export function HighStakesChip(): ReactNode {
	return (
		<span className="sh-chip sh-chip-stakes" title={CHIP_TIP}>
			<ShieldAlert size={11} /> High stakes
		</span>
	);
}

/** The session header's mark: icon only, as the sandboxed mark (the header drops its pills on phones). */
export function HighStakesMark(): ReactNode {
	return (
		<span className="sh-stakes-mark" role="img" aria-label="High stakes" data-tip={CHIP_TIP}>
			<ShieldAlert size={12} />
		</span>
	);
}

/**
 * The session menu's switch. Turning the mode on needs nothing; turning it off asks first, because it removes the
 * quiz that stands between the agent's changes and a push. The companion refuses an off without the confirmation.
 */
export function HighStakesRow({ control }: { control: StakesControl }): ReactNode {
	const { client, instanceId, on } = control;
	// The answer to this device's own change, until the host list catches up with it.
	const [answered, setAnswered] = useState<boolean | null>(null);
	const [busy, setBusy] = useState(false);
	const [asking, setAsking] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => setAnswered(null), [on]);
	const shown = answered ?? on;

	const change = async (next: boolean): Promise<void> => {
		setAsking(false);
		setBusy(true);
		setError(null);
		try {
			const status = await client.setHighStakes(instanceId, next, next ? {} : { confirmOff: true });
			setAnswered(status.on);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="sh-sheet-row sh-sheet-row-top">
			<dt>High stakes</dt>
			<dd className="sh-stakes-cell">
				<span className="sh-stakes-line">
					<button
						type="button"
						role="switch"
						className="sh-stakes-switch"
						aria-checked={shown}
						aria-label="High stakes"
						disabled={busy}
						onClick={() => (shown ? setAsking(true) : void change(true))}
					>
						<span className="sh-stakes-knob" aria-hidden="true" />
					</button>
					{busy && <LoaderCircle size={14} className="sh-spin" />}
				</span>
				<span className="sh-field-hint">Pushes and pull requests need a passed quiz.</span>
				{error !== null && (
					<span className="sh-connect-error" role="alert">
						{error}
					</span>
				)}
			</dd>
			{asking && (
				<Sheet label="Turn off high stakes" fixed onClose={() => setAsking(false)}>
					<div className="sh-sheet-head">
						<div className="sh-sheet-title">Turn off high stakes?</div>
					</div>
					<p className="sh-edit-prompt-note">
						Pushes and pull requests will no longer need a quiz, and the session will log it.
					</p>
					<div className="sh-edit-prompt-actions sh-stakes-actions">
						<button type="button" className="sh-btn sh-btn-primary" onClick={() => setAsking(false)} autoFocus>
							Keep on
						</button>
						<button type="button" className="sh-btn" onClick={() => void change(false)}>
							Turn off
						</button>
					</div>
				</Sheet>
			)}
		</div>
	);
}

export interface StakesGateNoteProps {
	status: StakesStatus;
	/** What is held back, one line each; empty while nothing here waits for the quiz. */
	gates: readonly StakesGate[];
	client: CompanionClient;
	/** The session whose quiz is needed. */
	instanceId: string;
	/** Open the quiz with this id; null: the *Take the quiz* action is not offered. */
	onOpenQuiz: ((id: string) => void) | null;
}

/**
 * Why the push, pull request or merge buttons are disabled, announced as it changes, with the action that opens
 * (or creates) the quiz for exactly the diff that is needed.
 */
export function StakesGateNote({ status, gates, client, instanceId, onOpenQuiz }: StakesGateNoteProps): ReactNode {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const detail = stakesDetail(status);

	const take = async (): Promise<void> => {
		if (onOpenQuiz === null) return;
		setBusy(true);
		setError(null);
		try {
			onOpenQuiz((await client.stakesQuiz(instanceId)).id);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div aria-live="polite">
			{gates.length > 0 && (
				<div className="sh-stakes-gate">
					<ul className="sh-stakes-gate-lines">
						{gates.map(gate => (
							<li key={gate} className="sh-stakes-gate-line">
								<ShieldAlert size={14} aria-hidden="true" />
								<span>{stakesGateLine(gate)}</span>
							</li>
						))}
					</ul>
					{detail !== null && <div className="sh-field-hint">{detail}</div>}
					{onOpenQuiz !== null && (
						<button type="button" className="sh-btn sh-btn-primary" disabled={busy} onClick={() => void take()}>
							{busy ? <LoaderCircle size={14} className="sh-spin" /> : <GraduationCap size={14} />}{" "}
							{takeQuizLabel(status)}
						</button>
					)}
					{error !== null && <div className="sh-connect-error">{error}</div>}
				</div>
			)}
		</div>
	);
}
