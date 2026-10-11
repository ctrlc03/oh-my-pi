import {
	Archive,
	ArchiveRestore,
	ArrowDown,
	ArrowUp,
	GripVertical,
	ListChecks,
	Moon,
	Pin,
	PinOff,
	Timer,
	TimerOff,
	X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { type OrgAction, type OrgStatus, type SnoozeChoice, snoozeChoices } from "../../lib/session-org";
import type { SessionOrgControl } from "../../lib/use-session-org";
import { Sheet } from "./Sheet";

const IDLE_DAY_CHOICES = [3, 7, 14, 30];

function SheetHead({ title, onClose }: { title: string; onClose(): void }): ReactNode {
	return (
		<div className="sh-sheet-head">
			<div className="sh-sheet-title">{title}</div>
			<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="Close">
				<X size={16} />
			</button>
		</div>
	);
}

function SnoozeList({
	choices,
	onPick,
}: {
	choices: readonly SnoozeChoice[];
	onPick(choice: SnoozeChoice): void;
}): ReactNode {
	return choices.map(choice => (
		<button key={choice.id} type="button" className="sh-btn sh-org-menu-item" onClick={() => onPick(choice)}>
			<Moon size={15} /> {choice.label}
		</button>
	));
}

export interface OrgMenuProps {
	title: string;
	status: OrgStatus;
	/** Where it stands among the rows it can be moved among (the pinned, or the arranged active ones); null when it cannot be moved. */
	place: { index: number; count: number } | null;
	/** Whether the idle and pull request rules may settle it; null: the choice is not offered. */
	autoSettle: boolean | null;
	limitResetAt: number | null;
	/** The session has ended while settled: it can only be moved back to active (which resumes it), or picked. */
	ended: boolean;
	now: number;
	onAct(action: OrgAction, message: string): void;
	onMove(to: number): void;
	onArrange(): void;
	onSelect(): void;
	onClose(): void;
}

/** One session's menu: pin, move, snooze, settle, auto-settle, and the modes that change several at a time. */
export function OrgMenu(props: OrgMenuProps): ReactNode {
	const { status, place, now } = props;
	const [snoozing, setSnoozing] = useState(false);
	return (
		<Sheet label={`organise ${props.title}`} onClose={props.onClose}>
			<SheetHead title={props.title} onClose={props.onClose} />
			<div className="sh-org-menu">
				{snoozing ? (
					<SnoozeList
						choices={snoozeChoices(now, props.limitResetAt)}
						onPick={choice => props.onAct({ type: "snooze", until: choice.until }, `Snoozed ${props.title}`)}
					/>
				) : props.ended ? (
					<>
						<button
							type="button"
							className="sh-btn sh-org-menu-item"
							onClick={() => props.onAct({ type: "unsettle" }, `Moved ${props.title} back`)}
						>
							<ArchiveRestore size={15} />
							<span className="sh-org-menu-text">
								Move back to active
								<span className="sh-org-menu-hint">It ended when it settled; this resumes it</span>
							</span>
						</button>
						<div className="sh-org-menu-sep" role="separator" />
						<button type="button" className="sh-btn sh-org-menu-item" onClick={props.onSelect}>
							<ListChecks size={15} /> Select…
						</button>
					</>
				) : (
					<>
						{status === "pinned" ? (
							<button
								type="button"
								className="sh-btn sh-org-menu-item"
								onClick={() => props.onAct({ type: "unpin" }, `Unpinned ${props.title}`)}
							>
								<PinOff size={15} /> Unpin
							</button>
						) : (
							<button
								type="button"
								className="sh-btn sh-org-menu-item"
								onClick={() => props.onAct({ type: "pin" }, `Pinned ${props.title}`)}
							>
								<Pin size={15} /> Pin to top
							</button>
						)}
						{place !== null && place.index > 0 && (
							<button
								type="button"
								className="sh-btn sh-org-menu-item"
								onClick={() => props.onMove(place.index - 1)}
							>
								<ArrowUp size={15} /> Move up
							</button>
						)}
						{place !== null && place.index < place.count - 1 && (
							<button
								type="button"
								className="sh-btn sh-org-menu-item"
								onClick={() => props.onMove(place.index + 1)}
							>
								<ArrowDown size={15} /> Move down
							</button>
						)}
						{status === "snoozed" ? (
							<button
								type="button"
								className="sh-btn sh-org-menu-item"
								onClick={() => props.onAct({ type: "wake" }, `Woke ${props.title}`)}
							>
								<Moon size={15} /> Wake now
							</button>
						) : (
							<button type="button" className="sh-btn sh-org-menu-item" onClick={() => setSnoozing(true)}>
								<Moon size={15} /> Snooze…
							</button>
						)}
						{status === "settled" ? (
							<button
								type="button"
								className="sh-btn sh-org-menu-item"
								onClick={() => props.onAct({ type: "unsettle" }, `Moved ${props.title} back`)}
							>
								<ArchiveRestore size={15} /> Move back to active
							</button>
						) : (
							<button
								type="button"
								className="sh-btn sh-org-menu-item"
								onClick={() => props.onAct({ type: "settle" }, `Settled ${props.title}`)}
							>
								<Archive size={15} /> Settle
							</button>
						)}
						{props.autoSettle !== null && (
							<button
								type="button"
								className="sh-btn sh-org-menu-item"
								onClick={() => props.onAct({ type: "autosettle", on: !props.autoSettle }, "")}
							>
								{props.autoSettle ? <Timer size={15} /> : <TimerOff size={15} />}
								<span className="sh-org-menu-text">
									Auto-settle: {props.autoSettle ? "on" : "off"}
									<span className="sh-org-menu-hint">
										{props.autoSettle
											? "Idle and pull request rules may settle it"
											: "Kept out of the idle and pull request rules"}
									</span>
								</span>
							</button>
						)}
						<div className="sh-org-menu-sep" role="separator" />
						<button type="button" className="sh-btn sh-org-menu-item" onClick={props.onArrange}>
							<GripVertical size={15} /> Arrange sessions
						</button>
						<button type="button" className="sh-btn sh-org-menu-item" onClick={props.onSelect}>
							<ListChecks size={15} /> Select…
						</button>
					</>
				)}
			</div>
		</Sheet>
	);
}

/** The snooze durations for the sessions picked in select mode. */
export function OrgSnoozeSheet(props: {
	title: string;
	now: number;
	onPick(choice: SnoozeChoice): void;
	onClose(): void;
}): ReactNode {
	return (
		<Sheet label={props.title} onClose={props.onClose}>
			<SheetHead title={props.title} onClose={props.onClose} />
			<div className="sh-org-menu">
				<SnoozeList choices={snoozeChoices(props.now, null)} onPick={props.onPick} />
			</div>
		</Sheet>
	);
}

export function OrgSettingsSheet({ org, onClose }: { org: SessionOrgControl; onClose(): void }): ReactNode {
	const { settings } = org.doc;
	return (
		<Sheet label="Auto-settle" onClose={onClose}>
			<SheetHead title="Auto-settle" onClose={onClose} />
			<div className="sh-org-settings-body">
				<label className="sh-field">
					<span className="sh-field-label">Settle sessions that sit idle</span>
					<select
						className="sh-input"
						value={settings.idleDays ?? ""}
						onChange={e =>
							org.setSettings({ idleDays: e.currentTarget.value === "" ? null : Number(e.currentTarget.value) })
						}
					>
						<option value="">Never</option>
						{IDLE_DAY_CHOICES.map(days => (
							<option key={days} value={days}>
								for {days} days
							</option>
						))}
					</select>
					<span className="sh-field-hint">
						Pinned and snoozed sessions are left alone, and so are those with auto-settle turned off in their
						menu.
					</span>
				</label>
				{org.synced && (
					<label className="sh-org-check">
						<input
							type="checkbox"
							checked={settings.settleOnPr}
							onChange={e => org.setSettings({ settleOnPr: e.currentTarget.checked })}
						/>
						<span>Settle when the session's pull request merges or closes</span>
					</label>
				)}
				{org.canEndOnSettle && (
					<label className="sh-org-check sh-org-check-hinted">
						<input
							type="checkbox"
							checked={settings.endOnSettle === true}
							onChange={e => org.setSettings({ endOnSettle: e.currentTarget.checked })}
						/>
						<span className="sh-org-check-text">
							End sessions when they settle
							<span className="sh-field-hint">
								Ends the session on this computer when it settles; open it to resume.
							</span>
						</span>
					</label>
				)}
				<span className="sh-field-hint">
					{org.synced
						? "Pins, snoozes and settled sessions follow you across devices through your computer."
						: "Kept on this device. Pair your computer to share it across devices."}
				</span>
			</div>
		</Sheet>
	);
}
