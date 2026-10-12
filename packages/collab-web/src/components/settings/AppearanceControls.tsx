import type { ReactNode } from "react";
import { ACCENTS, type Accent } from "../../lib/appearance";

export const ACCENT_LABELS: Record<Accent, string> = {
	pink: "Pink",
	blue: "Blue",
	violet: "Violet",
	green: "Green",
	orange: "Orange",
	slate: "Slate",
};

/** The accent presets as colour dots; each dot carries its own preset's tokens (tokens.css), so it shows its colour whatever is active. */
export function AccentSwatches({ value, onChange }: { value: Accent; onChange(accent: Accent): void }): ReactNode {
	return (
		<div className="sh-appr-swatches" role="group" aria-label="Accent colour">
			{ACCENTS.map(accent => (
				<button
					key={accent}
					type="button"
					className="sh-appr-swatch"
					data-accent={accent}
					aria-label={ACCENT_LABELS[accent]}
					aria-pressed={value === accent}
					onClick={() => onChange(accent)}
				>
					<span className="sh-appr-swatch-dot" />
				</button>
			))}
		</div>
	);
}

export interface FontOption<T extends string> {
	value: T;
	label: string;
	/** A `var(--font-…)` reference to the stack the sample is set in. */
	stack: string;
	/** Why the option cannot be picked on this device; shown on its tile. */
	missing?: string;
}

/** A choice between fonts, each tile set in its own face so the options can be compared by eye. */
export function FontPicker<T extends string>({
	label,
	value,
	options,
	sample,
	onChange,
}: {
	label: string;
	value: T;
	options: readonly FontOption<T>[];
	sample: string;
	onChange(value: T): void;
}): ReactNode {
	return (
		<div className="sh-appr-fonts" role="radiogroup" aria-label={label}>
			{options.map(option => (
				<button
					key={option.value}
					type="button"
					role="radio"
					aria-checked={value === option.value}
					disabled={option.missing !== undefined}
					className={value === option.value ? "sh-appr-font sh-appr-font-on" : "sh-appr-font"}
					onClick={() => onChange(option.value)}
				>
					<span className="sh-appr-font-name">{option.label}</span>
					<span className="sh-appr-font-sample" style={{ fontFamily: option.stack }} aria-hidden>
						{sample}
					</span>
					{option.missing !== undefined && <span className="sh-appr-font-note">{option.missing}</span>}
				</button>
			))}
		</div>
	);
}
