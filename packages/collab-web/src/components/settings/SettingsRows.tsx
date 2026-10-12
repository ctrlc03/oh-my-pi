import { Laptop, RefreshCw, Smartphone } from "lucide-react";
import type { ReactNode } from "react";
import { useId } from "react";
import type { CompanionClient } from "../../lib/companion";
import type { CompanionHandle } from "../../lib/use-companion";

/** Where a setting is kept: this browser, or the paired computer. */
export function Where({ machine }: { machine: string | null }): ReactNode {
	const Icon = machine === null ? Smartphone : Laptop;
	return (
		<span className="sh-set-where">
			<Icon size={13} aria-hidden="true" />
			{machine === null ? "Saved on this device" : `Saved on ${machine}`}
		</span>
	);
}

/** A titled run of rows; `where` says where the group's settings are kept when the section's own header does not. */
export function SettingsGroup({
	title,
	where,
	children,
}: {
	title?: string;
	where?: ReactNode;
	children: ReactNode;
}): ReactNode {
	const titleId = useId();
	return (
		<section className="sh-set-group" aria-labelledby={title === undefined ? undefined : titleId}>
			{(title !== undefined || where !== undefined) && (
				<div className="sh-set-group-head">
					{title !== undefined && (
						<h3 id={titleId} className="sh-set-group-title">
							{title}
						</h3>
					)}
					{where}
				</div>
			)}
			{children}
		</section>
	);
}

/** One setting: its name and what it does on the left, the control on the right (below it on a narrow screen). */
export function SettingsRow({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: ReactNode;
	children: ReactNode;
}): ReactNode {
	return (
		<div className="sh-set-row">
			<div className="sh-set-row-text">
				<div className="sh-set-row-label">{label}</div>
				{hint !== undefined && <div className="sh-field-hint">{hint}</div>}
			</div>
			<div className="sh-set-row-control">{children}</div>
		</div>
	);
}

/** A segmented choice between a few values, as a radio group. */
export function Choice<T extends string | number | boolean>({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: T;
	options: readonly { value: T; label: string; icon?: ReactNode; tip?: string }[];
	onChange(value: T): void;
}): ReactNode {
	return (
		<div className="sh-segmented" role="radiogroup" aria-label={label}>
			{options.map(option => (
				<button
					key={String(option.value)}
					type="button"
					role="radio"
					aria-checked={value === option.value}
					className={value === option.value ? "sh-segment sh-segment-on" : "sh-segment"}
					onClick={() => onChange(option.value)}
					data-tip={option.tip}
				>
					{option.icon} {option.label}
				</button>
			))}
		</div>
	);
}

/** Content that needs the computer, given its client; while the computer is unreachable the section says so instead. */
export function ComputerGate({
	companion,
	children,
}: {
	companion: CompanionHandle;
	children(client: CompanionClient): ReactNode;
}): ReactNode {
	const { snap, client } = companion;
	if (snap.phase === "live" && client !== null) return children(client);
	return (
		<div className="sh-companion-offline">
			<span>
				{snap.phase === "connecting"
					? "Connecting to your computer…"
					: (snap.error ?? "Your computer is unreachable right now.")}
			</span>
			{client !== null && snap.phase !== "connecting" && (
				<button type="button" className="sh-btn" onClick={() => client.connect()}>
					<RefreshCw size={14} /> Retry
				</button>
			)}
		</div>
	);
}
