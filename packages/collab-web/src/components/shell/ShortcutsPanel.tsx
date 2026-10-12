import { RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import { Fragment, useEffect, useState } from "react";
import {
	type Combo,
	comboFromEvent,
	comboProblem,
	effectiveBindings,
	findConflicts,
	formatCombo,
	GESTURES,
	IS_MAC,
	resetOverrides,
	SHORTCUTS,
	type ShortcutGroup,
	type ShortcutId,
	setOverride,
	useOverrides,
} from "../../lib/shortcuts";
import "./shortcuts.css";

const GROUPS: readonly ShortcutGroup[] = ["Blocks", "Session", "View", "General"];

const IDS = Object.keys(SHORTCUTS) as ShortcutId[];

/** Take the next key press as the keys of `id`; Esc gives up. The press is swallowed so it neither acts nor closes the sheet. */
function useRecording(id: ShortcutId | null, finish: (combo: Combo | null) => void): void {
	useEffect(() => {
		if (id === null) return;
		const onKey = (e: KeyboardEvent): void => {
			e.preventDefault();
			e.stopPropagation();
			if (e.key === "Escape") return finish(null);
			const combo = comboFromEvent(e, IS_MAC);
			if (combo !== null) finish(combo);
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [id, finish]);
}

/**
 * Every keyboard shortcut, read from the same table the handlers match against, and the touch gestures.
 * Click a shortcut's keys, then press the new ones: the choice is stored on this device and used from the
 * next key press on (and after a reload). Two shortcuts on the same keys are flagged, not refused.
 */
export function ShortcutsPanel(): ReactNode {
	const overrides = useOverrides();
	const bindings = effectiveBindings(overrides);
	const conflicts = findConflicts(bindings);
	const [recording, setRecording] = useState<ShortcutId | null>(null);
	const [problem, setProblem] = useState<{ id: ShortcutId; message: string } | null>(null);
	useRecording(recording, combo => {
		if (recording === null) return;
		setRecording(null);
		if (combo === null) return;
		const message = comboProblem(recording, combo);
		if (message === null) {
			setProblem(null);
			setOverride(recording, combo);
		} else setProblem({ id: recording, message });
	});
	const customised = Object.keys(overrides).length;
	const conflicting = Object.keys(conflicts).length;

	return (
		<div className="sh-keys-panel">
			<div className="sh-keys-bar">
				<div className="sh-field-hint sh-keys-hint">
					Click a shortcut's keys, then press the ones you want. Esc cancels.
					{conflicting > 0 && (
						<span className="sh-keys-warn"> {conflicting} share keys with another shortcut.</span>
					)}
				</div>
				{customised > 0 && (
					<button
						type="button"
						className="sh-btn"
						onClick={() => {
							setProblem(null);
							resetOverrides();
						}}
					>
						<RotateCcw size={13} /> Reset all
					</button>
				)}
			</div>
			<div className="sh-keys">
				{GROUPS.map(group => (
					<Fragment key={group}>
						<h3 className="sh-keys-group">{group}</h3>
						<dl className="sh-keys-list">
							{IDS.filter(id => SHORTCUTS[id].group === group).map(id => {
								const shortcut = SHORTCUTS[id];
								const custom = Object.hasOwn(overrides, id);
								const clash = conflicts[id];
								const failed = problem?.id === id ? problem.message : null;
								return (
									<Fragment key={id}>
										<dt>
											{shortcut.label}
											{clash !== undefined && (
												<span className="sh-keys-warn">
													Same keys as{" "}
													{clash.map(other => SHORTCUTS[other].label.toLowerCase()).join("; ")}.
												</span>
											)}
											{failed !== null && <span className="sh-keys-error">{failed}</span>}
										</dt>
										<dd>
											{custom && (
												<button
													type="button"
													className="sh-btn sh-btn-icon sh-keys-reset"
													onClick={() => {
														setProblem(null);
														setOverride(id, null);
													}}
													aria-label={`Reset ${shortcut.label}`}
													title="Back to the default"
												>
													<RotateCcw size={13} />
												</button>
											)}
											{Object.hasOwn(shortcut, "fixed") ? (
												<kbd className="sh-kbd">{formatCombo(bindings[id], IS_MAC)}</kbd>
											) : (
												<button
													type="button"
													className={
														recording === id
															? "sh-kbd sh-kbd-edit sh-kbd-recording"
															: custom
																? "sh-kbd sh-kbd-edit sh-kbd-custom"
																: "sh-kbd sh-kbd-edit"
													}
													onClick={() => {
														setProblem(null);
														setRecording(recording === id ? null : id);
													}}
													aria-label={`Change the keys for ${shortcut.label}`}
												>
													{recording === id ? "press keys…" : formatCombo(bindings[id], IS_MAC)}
												</button>
											)}
										</dd>
									</Fragment>
								);
							})}
						</dl>
					</Fragment>
				))}
				<h3 className="sh-keys-group">Touch gestures</h3>
				<dl className="sh-keys-list">
					{GESTURES.map(item => (
						<Fragment key={item.gesture}>
							<dt>{item.gesture}</dt>
							<dd className="sh-keys-gesture">{item.label}</dd>
						</Fragment>
					))}
				</dl>
			</div>
		</div>
	);
}
