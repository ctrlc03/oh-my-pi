import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import {
	type ComputerHandle,
	defaultComputer,
	type Feature,
	loadLastComputer,
	unavailableReason,
} from "../../lib/computers";
import "./computer-picker.css";

export interface ComputerPickerProps {
	computers: readonly ComputerHandle[];
	/** What the pick is for: a computer that cannot do it is shown but not pickable. */
	feature: Feature;
	/** The picked computer's id. */
	value: string | null;
	onChange(id: string): void;
	label?: string;
}

/** Which computer to start on. Nothing with fewer than two computers: there is no choice to make. */
export function ComputerPicker({
	computers,
	feature,
	value,
	onChange,
	label = "Computer",
}: ComputerPickerProps): ReactNode {
	const labelId = useId();
	if (computers.length < 2) return null;
	const unavailable = computers.flatMap(computer => {
		const reason = unavailableReason(computer, feature);
		return reason === null ? [] : [{ computer, reason }];
	});
	return (
		<div className="sh-field sh-computer-picker">
			<span id={labelId} className="sh-field-label">
				{label}
			</span>
			<div className="sh-segmented sh-segmented-wrap" role="radiogroup" aria-labelledby={labelId}>
				{computers.map(computer => {
					const reason = unavailableReason(computer, feature);
					const on = computer.id === value;
					return (
						<button
							key={computer.id}
							type="button"
							role="radio"
							aria-checked={on}
							disabled={reason !== null}
							className={on ? "sh-segment sh-segment-on" : "sh-segment"}
							onClick={() => onChange(computer.id)}
						>
							<span
								className={`sh-dot${computer.snap.phase === "live" ? " sh-dot-live" : ""}`}
								aria-hidden="true"
							/>
							{computer.name}
						</button>
					);
				})}
			</div>
			{unavailable.map(({ computer, reason }) => (
				<span key={computer.id} className="sh-field-hint sh-computer-picker-reason">
					{computer.name}: {reason}
				</span>
			))}
		</div>
	);
}

/**
 * The computer a new piece of work starts on, and a setter for the user's pick. It starts on
 * {@link defaultComputer}; it moves only when the chosen computer can no longer take the work (it went
 * offline), to another that can, never while that computer is still fine. Null when none can.
 */
export function useStartComputer(
	computers: readonly ComputerHandle[],
	feature: Feature,
	currentId: string | null,
): [string | null, (id: string) => void] {
	const [picked, setPicked] = useState<string | null>(null);
	const chosen = computers.find(computer => computer.id === picked) ?? null;
	const resolved =
		chosen !== null && unavailableReason(chosen, feature) === null
			? chosen
			: defaultComputer(computers, feature, currentId, loadLastComputer());
	const resolvedId = resolved?.id ?? null;
	useEffect(() => {
		setPicked(resolvedId);
	}, [resolvedId]);
	return [resolvedId, setPicked];
}
