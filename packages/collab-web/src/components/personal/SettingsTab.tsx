import { PERSONAL_DEFAULTS, type PersonalSettings, type PersonalSettingsPatch } from "@oh-my-pi/pi-wire/personal";
import { DatabaseBackup, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { relTime } from "../../lib/format";
import {
	type FormGroup,
	formFromSettings,
	groupChange,
	groupDirty,
	resetGroup,
	type SettingsForm,
	syncForm,
} from "../../lib/personal-settings";
import { usePersonal, usePersonalQuery } from "../../lib/use-personal";
import { Choice, SettingsGroup, SettingsRow } from "../settings/SettingsRows";
import { SourcesEditor } from "./SourcesEditor";
import { HomeGate, QueryView, useAction } from "./shared";
import "./agent.css";

/** What the companion answers to a settings request: the settings, and the MCP servers the profile's `mcp.json` names. */
interface Snapshot {
	settings: PersonalSettings;
	mcpServers: string[];
}

/** "5m ago", or "just now" where {@link relTime} says "now". */
function sinceText(at: number): string {
	const text = relTime(at);
	return text === "now" ? "just now" : text;
}

const KEEPS_LIMITS = "A running session keeps the limits it started with until the next rollover.";

function Money({ label, value, onChange }: { label: string; value: string; onChange(value: string): void }): ReactNode {
	return (
		<span className="pa-money">
			<span aria-hidden="true">$</span>
			<input
				type="number"
				className="sh-input pa-input-short"
				inputMode="decimal"
				min={0}
				step="any"
				value={value}
				aria-label={label}
				onChange={event => onChange(event.currentTarget.value)}
			/>
		</span>
	);
}

function Time({ label, value, onChange }: { label: string; value: string; onChange(value: string): void }): ReactNode {
	return (
		<input
			type="time"
			className="sh-input pa-input-short"
			value={value}
			aria-label={label}
			onChange={event => onChange(event.currentTarget.value)}
		/>
	);
}

/** A group's Save button: dirty-only, one group's patch, "Saved" for a moment, the companion's refusal beside it. */
function SaveBar({
	group,
	form,
	saved,
	onSave,
}: {
	group: FormGroup;
	form: SettingsForm;
	saved: PersonalSettings;
	onSave(group: FormGroup, patch: PersonalSettingsPatch): Promise<void>;
}): ReactNode {
	const action = useAction();
	const [flash, setFlash] = useState(false);
	const change = groupChange(group, form, saved);
	const dirty = groupDirty(group, form, saved);
	useEffect(() => {
		if (!flash) return;
		const timer = setTimeout(() => setFlash(false), 2_000);
		return () => clearTimeout(timer);
	}, [flash]);
	return (
		<div className="pa-save">
			<button
				type="button"
				className="sh-btn sh-btn-primary"
				disabled={!dirty || change.error !== null || action.busy}
				onClick={() => {
					setFlash(false);
					void action.run(() => onSave(group, change.patch)).then(ok => setFlash(ok));
				}}
			>
				{action.busy && <LoaderCircle size={14} className="sh-spin" />} Save
			</button>
			<span className="pa-save-state" role="status">
				{flash && !dirty ? "Saved" : ""}
			</span>
			{dirty && change.error !== null && <span className="pa-field-err">{change.error}</span>}
			{action.error !== null && <span className="pa-field-err">{action.error}</span>}
		</div>
	);
}

function SettingsForms({ answer }: { answer: Snapshot }): ReactNode {
	const personal = usePersonal();
	const [snap, setSnap] = useState(answer);
	const [form, setForm] = useState(() => formFromSettings(answer.settings));
	const [lastAnswer, setLastAnswer] = useState(answer);
	const status = personal.home.status;
	const machine = personal.home.computer?.name ?? "the home computer";
	const backupNow = useAction();

	// A new answer (a push, or another device saved) updates the groups nothing was typed into.
	if (lastAnswer !== answer) {
		setLastAnswer(answer);
		setForm(prev => syncForm(prev, snap.settings, answer.settings));
		setSnap(answer);
	}

	const adopt = (next: Snapshot, group: FormGroup | null): void => {
		setForm(prev =>
			syncForm(group === null ? prev : resetGroup(prev, group, next.settings), snap.settings, next.settings),
		);
		setSnap(next);
	};

	const save = async (group: FormGroup, patch: PersonalSettingsPatch): Promise<void> => {
		if (Object.keys(patch).length === 0) {
			adopt(snap, group);
			return;
		}
		const reply = await personal.call({ t: "personal-settings-set", patch });
		adopt({ settings: reply.settings, mcpServers: reply.mcpServers }, group);
	};

	const saveSources = async (sources: PersonalSettings["sources"]): Promise<void> => {
		const reply = await personal.call({ t: "personal-settings-set", patch: { sources } });
		adopt({ settings: reply.settings, mcpServers: reply.mcpServers }, null);
	};

	const runBackup = (): void => {
		if (status === null) return;
		void backupNow.run(async () => {
			const reply = await personal.call({ t: "personal-backup-now" });
			personal.adopt(status.homeComputer.computerId, reply.status);
		});
	};

	const edit = (patch: Partial<SettingsForm>): void => setForm(prev => ({ ...prev, ...patch }));
	const { limits, review, backup } = PERSONAL_DEFAULTS;
	const bars = { form, saved: snap.settings, onSave: save };

	return (
		<>
			<SettingsGroup title="Spend limits">
				<SettingsRow label="Per day" hint={`$${limits.dayUsd} by default. 0 means no limit.`}>
					<Money label="Daily spend limit in dollars" value={form.dayUsd} onChange={dayUsd => edit({ dayUsd })} />
				</SettingsRow>
				<SettingsRow label="Per month" hint={`$${limits.monthUsd} by default. 0 means no limit.`}>
					<Money
						label="Monthly spend limit in dollars"
						value={form.monthUsd}
						onChange={monthUsd => edit({ monthUsd })}
					/>
				</SettingsRow>
				<div className="sh-field-hint">{KEEPS_LIMITS}</div>
				<SaveBar group="limits" {...bars} />
			</SettingsGroup>

			<SettingsGroup title="Nightly review">
				<SettingsRow
					label="Review"
					hint="Once a day the agent looks back, writes a digest and may propose changes to About you."
				>
					<Choice
						label="Nightly review"
						value={form.reviewEnabled}
						options={[
							{ value: true, label: "On" },
							{ value: false, label: "Off" },
						]}
						onChange={reviewEnabled => edit({ reviewEnabled })}
					/>
				</SettingsRow>
				<SettingsRow label="Time" hint={`Local time. ${review.time} by default.`}>
					<Time label="Review time" value={form.reviewTime} onChange={reviewTime => edit({ reviewTime })} />
				</SettingsRow>
				<SettingsRow
					label="Budget per run"
					hint={`$${review.budgetUsd.toFixed(2)} by default. The review also counts against the day and month limits.`}
				>
					<Money
						label="Review budget per run in dollars"
						value={form.reviewBudgetUsd}
						onChange={reviewBudgetUsd => edit({ reviewBudgetUsd })}
					/>
				</SettingsRow>
				<SaveBar group="review" {...bars} />
			</SettingsGroup>

			<SettingsGroup title="Rollover">
				<SettingsRow
					label="Daily rollover"
					hint={`Local time. ${PERSONAL_DEFAULTS.rollover.time} by default. The agent moves to a fresh session when it is idle; the thread in the app continues.`}
				>
					<Time
						label="Rollover time"
						value={form.rolloverTime}
						onChange={rolloverTime => edit({ rolloverTime })}
					/>
				</SettingsRow>
				<SaveBar group="rollover" {...bars} />
			</SettingsGroup>

			<SettingsGroup title="Backups">
				<SettingsRow
					label="Backup folder"
					hint={`On ${machine}. Daily at ${backup.time}; ${backup.keepDaily} daily and ${backup.keepMonthly} monthly snapshots are kept.`}
				>
					<input
						type="text"
						className="sh-input sh-input-mono pa-input-path"
						value={form.backupFolder}
						placeholder={status?.backups.folder ?? "Default folder inside the profile"}
						aria-label="Backup folder"
						spellCheck={false}
						autoCapitalize="off"
						autoCorrect="off"
						onChange={event => edit({ backupFolder: event.currentTarget.value })}
					/>
				</SettingsRow>
				<div className="pa-actions">
					<button
						type="button"
						className="sh-btn"
						disabled={form.backupFolder === ""}
						onClick={() => edit({ backupFolder: "" })}
					>
						Use the default folder inside the profile
					</button>
				</div>
				{status !== null && (
					<div className="sh-field-hint">
						{status.backups.lastAt === null
							? "No backup yet."
							: `Last backup ${sinceText(status.backups.lastAt)}: ${status.backups.lastOk === false ? "failed" : "done"}.`}{" "}
						Now: <code className="pa-path">{status.backups.folder}</code>
					</div>
				)}
				{status?.backups.lastError !== undefined && (
					<div className="pa-note pa-note-err">{status.backups.lastError}</div>
				)}
				{status !== null && (
					<div className="pa-actions">
						<button
							type="button"
							className="sh-btn"
							disabled={backupNow.busy || groupDirty("backup", form, snap.settings)}
							onClick={runBackup}
						>
							{backupNow.busy ? (
								<LoaderCircle size={14} className="sh-spin" aria-hidden="true" />
							) : (
								<DatabaseBackup size={14} aria-hidden="true" />
							)}
							Back up now
						</button>
						{groupDirty("backup", form, snap.settings) && (
							<span className="sh-field-hint">Save the folder first; it backs up to the saved one.</span>
						)}
					</div>
				)}
				{backupNow.error !== null && <div className="sh-connect-error">{backupNow.error}</div>}
				{status?.backups.sameDisk === true && (
					<div className="pa-note pa-note-warn">
						This folder is on the same disk as the memory. Point it at another disk or a synced folder.
					</div>
				)}
				<SaveBar group="backup" {...bars} />
			</SettingsGroup>

			<SettingsGroup title="Sources">
				<SourcesEditor
					sources={snap.settings.sources}
					mcpServers={snap.mcpServers}
					machine={machine}
					onSave={saveSources}
				/>
			</SettingsGroup>
		</>
	);
}

/** Settings → Personal agent → Settings: the agent's limits, review, rollover, backups and sources, saved on the home computer. */
export function SettingsTab(): ReactNode {
	const personal = usePersonal();
	const query = usePersonalQuery(personal, ["settings"], async call => {
		const reply = await call({ t: "personal-settings-get" });
		return { settings: reply.settings, mcpServers: reply.mcpServers };
	});
	return (
		<HomeGate>
			<QueryView query={query} what="the settings">
				{answer => <SettingsForms answer={answer} />}
			</QueryView>
		</HomeGate>
	);
}
