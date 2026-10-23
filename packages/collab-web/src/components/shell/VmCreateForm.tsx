import {
	VM_CPUS_RANGE,
	VM_DEFAULTS,
	VM_DISK_GIB_RANGE,
	VM_MEMORY_GIB_RANGE,
	type VmCreateOptions,
	type VmNetworkMode,
	vmCreateProblem,
} from "@oh-my-pi/pi-wire/vm";
import { LoaderCircle, Plus } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import type { CompanionClient } from "../../lib/companion";
import { Choice } from "../settings/SettingsRows";
import "./vm.css";

/** What the New VM form holds, as typed. */
export interface VmDraft {
	name: string;
	/** One repository per line. */
	repos: string;
	cpus: string;
	memoryGiB: string;
	diskGiB: string;
	network: VmNetworkMode;
	/** Empty: no limit. */
	dailyCostUsd: string;
	/** Build a template for fresh VMs instead of a VM to pair. */
	template: boolean;
}

export const EMPTY_VM_DRAFT: VmDraft = {
	name: "",
	repos: "",
	cpus: String(VM_DEFAULTS.cpus),
	memoryGiB: String(VM_DEFAULTS.memoryGiB),
	diskGiB: String(VM_DEFAULTS.diskGiB),
	network: VM_DEFAULTS.network,
	dailyCostUsd: "",
	template: false,
};

/** `owner/repo` from what a person pastes: a repository URL, an ssh address, with or without `.git`. */
function repoOf(text: string): string {
	return text
		.replace(/^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:|github\.com\/)/i, "")
		.replace(/\/+$/, "")
		.replace(/\.git$/i, "");
}

function numberOf(text: string): number | undefined {
	return text.trim() === "" ? undefined : Number(text);
}

/** The request the draft asks for, or the first thing wrong with it in words for a person. */
export function vmDraftOptions(draft: VmDraft): { options: VmCreateOptions } | { problem: string } {
	const repos = [
		...new Set(
			draft.repos
				.split(/[\s,]+/)
				.filter(token => token !== "")
				.map(repoOf),
		),
	];
	const options: VmCreateOptions = {
		name: draft.name.trim(),
		repos,
		cpus: numberOf(draft.cpus),
		memoryGiB: numberOf(draft.memoryGiB),
		diskGiB: numberOf(draft.diskGiB),
		network: draft.network,
		dailyCostUsd: numberOf(draft.dailyCostUsd),
		...(draft.template ? { template: true } : {}),
	};
	const problem = vmCreateProblem(options);
	return problem === null ? { options } : { problem };
}

function NumberField({
	label,
	unit,
	range,
	value,
	onChange,
}: {
	label: string;
	unit: string;
	range: { min: number; max: number };
	value: string;
	onChange(value: string): void;
}): ReactNode {
	return (
		<label className="sh-field">
			<span className="sh-field-label">{label}</span>
			<span className="sh-review-draft">
				<input
					className="sh-input sh-vm-number"
					type="number"
					min={range.min}
					max={range.max}
					step={1}
					inputMode="numeric"
					value={value}
					onChange={e => onChange(e.currentTarget.value)}
				/>
				{unit}
			</span>
		</label>
	);
}

/** Ask the computer to create a VM: its name, repositories and size. The create runs there; `onCreated` gets the name once it was accepted. */
export function VmCreateForm({
	client,
	disabledReason,
	onCreated,
	onCancel,
}: {
	client: CompanionClient;
	/** Why creating is not possible now (the computer's readiness problem); the form shows it instead of submitting. */
	disabledReason?: string | null;
	onCreated(name: string): void;
	onCancel?(): void;
}): ReactNode {
	const [draft, setDraft] = useState(EMPTY_VM_DRAFT);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const parsed = vmDraftOptions(draft);
	const edit = (patch: Partial<VmDraft>): void => {
		setDraft({ ...draft, ...patch });
		setError(null);
	};

	const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
		e.preventDefault();
		if (busy || !("options" in parsed) || disabledReason) return;
		setBusy(true);
		setError(null);
		try {
			await client.vmCreate(parsed.options);
			setDraft(EMPTY_VM_DRAFT);
			onCreated(parsed.options.name);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<form className="sh-spend sh-vm-form" onSubmit={e => void submit(e)} aria-label="New virtual machine">
			<label className="sh-field">
				<span className="sh-field-label">Name</span>
				<input
					className="sh-input sh-input-mono"
					type="text"
					value={draft.name}
					onChange={e => edit({ name: e.currentTarget.value })}
					placeholder="my-project"
					maxLength={31}
					spellCheck={false}
					autoComplete="off"
					autoCapitalize="off"
					autoCorrect="off"
				/>
				<span className="sh-field-hint">
					Lower-case letters, digits and dashes. The VM shows up as a computer with this name.
				</span>
			</label>
			<label className="sh-field">
				<span className="sh-field-label">Repositories</span>
				<textarea
					className="sh-input sh-review-textarea sh-input-mono"
					rows={3}
					value={draft.repos}
					onChange={e => edit({ repos: e.currentTarget.value })}
					placeholder={"owner/repo\nowner/another-repo"}
					spellCheck={false}
					autoComplete="off"
					autoCapitalize="off"
					autoCorrect="off"
				/>
				<span className="sh-field-hint">
					One per line, all under one GitHub owner. The VM gets a clone of each and a GitHub token limited to them.
				</span>
			</label>
			<div className="sh-vm-sizes">
				<NumberField
					label="CPUs"
					unit="cores"
					range={VM_CPUS_RANGE}
					value={draft.cpus}
					onChange={cpus => edit({ cpus })}
				/>
				<NumberField
					label="Memory"
					unit="GiB"
					range={VM_MEMORY_GIB_RANGE}
					value={draft.memoryGiB}
					onChange={memoryGiB => edit({ memoryGiB })}
				/>
				<NumberField
					label="Disk"
					unit="GiB"
					range={VM_DISK_GIB_RANGE}
					value={draft.diskGiB}
					onChange={diskGiB => edit({ diskGiB })}
				/>
			</div>
			<div className="sh-field">
				<span className="sh-field-label">Network</span>
				<Choice<VmNetworkMode>
					label="Network"
					value={draft.network}
					options={[
						{ value: "open", label: "Open", tip: "The VM reaches the internet and your network" },
						{
							value: "allowlist",
							label: "Allowlist",
							tip: "The VM reaches only listed hosts: GitHub, package registries",
						},
					]}
					onChange={network => edit({ network })}
				/>
				<span className="sh-field-hint">
					{draft.network === "open"
						? "The VM can reach the internet and your local network, not the computer's own services."
						: "The VM can reach only GitHub, package registries and the relay."}
				</span>
			</div>
			<label className="sh-field">
				<span className="sh-field-label">Daily cost limit (optional)</span>
				<span className="sh-review-draft">
					$
					<input
						className="sh-input sh-vm-number"
						type="number"
						min={0}
						step="any"
						inputMode="decimal"
						value={draft.dailyCostUsd}
						onChange={e => edit({ dailyCostUsd: e.currentTarget.value })}
						placeholder="none"
					/>
					per day
				</span>
				<span className="sh-field-hint">
					Model calls from the VM stop for the rest of the UTC day once their estimated cost reaches this.
				</span>
			</label>
			<label className="sh-start-sandbox">
				<input
					type="checkbox"
					checked={draft.template}
					onChange={e => edit({ template: e.currentTarget.checked })}
				/>
				<span className="sh-start-sandbox-text">
					<span className="sh-start-sandbox-title">Template for fresh VMs</span>
					<span className="sh-field-hint">
						Built once, then kept stopped and never paired. Starting a session in a fresh VM clones it: a
						throwaway copy with an identity of its own, deleted when the session ends.
					</span>
				</span>
			</label>
			{disabledReason && (
				<div className="sh-connect-error" role="alert">
					{disabledReason}
				</div>
			)}
			{!disabledReason && "problem" in parsed && draft.name !== "" && draft.repos.trim() !== "" && (
				<div className="sh-connect-error" role="alert">
					{parsed.problem}
				</div>
			)}
			{error && (
				<div className="sh-connect-error" role="alert">
					{error}
				</div>
			)}
			<div className="sh-review-confirm-actions">
				{onCancel && (
					<button type="button" className="sh-btn" onClick={onCancel} disabled={busy}>
						Cancel
					</button>
				)}
				<button
					type="submit"
					className="sh-btn sh-btn-primary"
					disabled={busy || !("options" in parsed) || Boolean(disabledReason)}
				>
					{busy ? <LoaderCircle size={14} className="sh-spin" /> : <Plus size={14} />}{" "}
					{draft.template ? "Create template" : "Create VM"}
				</button>
			</div>
		</form>
	);
}
