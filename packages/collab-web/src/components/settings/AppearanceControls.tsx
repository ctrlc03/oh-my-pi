import { type CSSProperties, type ReactNode, useRef } from "react";
import {
	ACCENT_PRESETS,
	type Accent,
	type AccentPreset,
	DARK_PALETTES,
	type DarkPalette,
	LIGHT_PALETTES,
	type LightPalette,
} from "../../lib/appearance";

export const ACCENT_LABELS: Record<Accent, string> = {
	pink: "Pink",
	red: "Red",
	orange: "Orange",
	amber: "Amber",
	green: "Green",
	teal: "Teal",
	cyan: "Cyan",
	blue: "Blue",
	indigo: "Indigo",
	violet: "Violet",
	slate: "Slate",
	custom: "Custom",
};

/** What the colour picker opens on before a custom accent was chosen: the default accent's pink. */
const PICKER_START = "#f472c0";

/**
 * The accent presets as colour dots, then a Custom dot. Each dot carries its own tokens (tokens.css), so it shows its
 * colour whatever is active. Custom: a first click picks a colour (the browser's colour dialog); once one is kept,
 * a click selects it and a click on the selected dot opens the dialog again to change it.
 */
export function AccentSwatches({
	value,
	custom,
	onSelect,
	onCustom,
}: {
	value: Accent;
	/** The kept custom colour, `#rrggbb`. */
	custom: string | null;
	onSelect(accent: AccentPreset): void;
	onCustom(hex: string): void;
}): ReactNode {
	const picker = useRef<HTMLInputElement>(null);
	const openPicker = (): void => {
		const input = picker.current;
		if (input === null) return;
		try {
			input.showPicker();
		} catch {
			// No showPicker (an older browser) or no user activation: a click on the input opens the same dialog.
			input.click();
		}
	};
	return (
		<div className="sh-appr-swatches" role="group" aria-label="Accent colour">
			{ACCENT_PRESETS.map(accent => (
				<button
					key={accent}
					type="button"
					className="sh-appr-swatch"
					data-accent={accent}
					aria-label={ACCENT_LABELS[accent]}
					aria-pressed={value === accent}
					title={ACCENT_LABELS[accent]}
					onClick={() => onSelect(accent)}
				>
					<span className="sh-appr-swatch-dot" />
				</button>
			))}
			<span className="sh-appr-custom">
				<button
					type="button"
					className="sh-appr-swatch"
					data-accent={custom === null ? undefined : "custom"}
					data-unset={custom === null ? "" : undefined}
					style={custom === null ? undefined : ({ "--accent-custom": custom } as CSSProperties)}
					aria-label={custom === null ? "Custom colour" : `Custom colour ${custom}`}
					aria-pressed={value === "custom"}
					title={value === "custom" || custom === null ? "Choose a colour…" : "Custom colour"}
					onClick={() => (value === "custom" || custom === null ? openPicker() : onCustom(custom))}
				>
					<span className="sh-appr-swatch-dot" />
				</button>
				<input
					ref={picker}
					type="color"
					className="sh-appr-colour"
					tabIndex={-1}
					aria-hidden
					value={custom ?? PICKER_START}
					onChange={event => onCustom(event.currentTarget.value)}
				/>
			</span>
			{custom !== null && <code className="sh-appr-hex">{custom}</code>}
		</div>
	);
}

export const DARK_PALETTE_LABELS: Record<DarkPalette, string> = {
	plum: "Plum",
	graphite: "Graphite",
	midnight: "Midnight",
	black: "Black",
	nord: "Nord",
};

export const LIGHT_PALETTE_LABELS: Record<LightPalette, string> = {
	marble: "Marble",
	paper: "Paper",
	sand: "Sand",
	sky: "Sky",
};

/**
 * A palette as a row of tiles, each a small picture of the app in that palette's own surface, text and border tokens
 * (a `.sh-appr-pal` wears them whatever theme is active, tokens.css) and the accent in use.
 */
function PaletteTiles<T extends string>({
	kind,
	label,
	value,
	options,
	labels,
	onChange,
}: {
	kind: "dark" | "light";
	label: string;
	value: T;
	options: readonly T[];
	labels: Record<T, string>;
	onChange(value: T): void;
}): ReactNode {
	return (
		<div className="sh-appr-pals" role="radiogroup" aria-label={label}>
			{options.map(option => (
				<button
					key={option}
					type="button"
					role="radio"
					aria-checked={value === option}
					className="sh-appr-pal"
					{...{ [`data-palette-${kind}`]: option }}
					onClick={() => onChange(option)}
				>
					<span className="sh-appr-pal-view" aria-hidden>
						<span className="sh-appr-pal-side" />
						<span className="sh-appr-pal-main">
							<span className="sh-appr-pal-card">
								<span className="sh-appr-pal-line" />
								<span className="sh-appr-pal-line sh-appr-pal-line-short" />
							</span>
							<span className="sh-appr-pal-send" />
						</span>
					</span>
					<span className="sh-appr-pal-name">{labels[option]}</span>
				</button>
			))}
		</div>
	);
}

export function DarkPaletteTiles({
	value,
	onChange,
}: {
	value: DarkPalette;
	onChange(value: DarkPalette): void;
}): ReactNode {
	return (
		<PaletteTiles
			kind="dark"
			label="Dark palette"
			value={value}
			options={DARK_PALETTES}
			labels={DARK_PALETTE_LABELS}
			onChange={onChange}
		/>
	);
}

export function LightPaletteTiles({
	value,
	onChange,
}: {
	value: LightPalette;
	onChange(value: LightPalette): void;
}): ReactNode {
	return (
		<PaletteTiles
			kind="light"
			label="Light palette"
			value={value}
			options={LIGHT_PALETTES}
			labels={LIGHT_PALETTE_LABELS}
			onChange={onChange}
		/>
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
