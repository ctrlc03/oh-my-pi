import { Moon, RotateCcw, Sun, SunMoon } from "lucide-react";
import type { ReactNode } from "react";
import {
	type Appearance,
	type CodeFont,
	DEFAULT_APPEARANCE,
	type Font,
	resetAppearance,
	type Spacing,
	setAppearance,
	type TextSize,
	useAppearance,
	type Zoom,
	ZOOM_STEPS,
} from "../../lib/appearance";
import { useFontAvailability } from "../../lib/fonts";
import { resetPaneSizes } from "../../lib/pane-size";
import { type ThemePreference, useThemePreference } from "../../lib/theme";
import { useHasPaneSizes } from "../../lib/use-pane-layout";
import { PetPanel } from "../pet/PetPanel";
import { AccentSwatches, FontPicker, type FontOption } from "./AppearanceControls";
import { AppearancePreview } from "./AppearancePreview";
import { Choice, SettingsGroup, SettingsRow } from "./SettingsRows";
import { TopBarControls } from "./TopBarControls";
import "./appearance.css";

const THEMES: readonly { value: ThemePreference; label: string; icon: ReactNode }[] = [
	{ value: "system", label: "System", icon: <SunMoon size={14} /> },
	{ value: "light", label: "Light", icon: <Sun size={14} /> },
	{ value: "dark", label: "Dark", icon: <Moon size={14} /> },
];

const TEXT_SIZES: readonly { value: TextSize; label: string }[] = [
	{ value: "small", label: "Small" },
	{ value: "default", label: "Default" },
	{ value: "large", label: "Large" },
	{ value: "xlarge", label: "Extra large" },
];

const SPACINGS: readonly { value: Spacing; label: string }[] = [
	{ value: "compact", label: "Compact" },
	{ value: "comfortable", label: "Comfortable" },
	{ value: "relaxed", label: "Relaxed" },
];

const ZOOMS: readonly { value: Zoom; label: string }[] = ZOOM_STEPS.map(step => ({
	value: step,
	label: `${step}%`,
}));

const FONT_OPTIONS: readonly FontOption<Font>[] = [
	{ value: "system", label: "System", stack: "var(--font-ui-system)" },
	{ value: "serif", label: "Serif", stack: "var(--font-ui-serif)" },
	{ value: "rounded", label: "Rounded", stack: "var(--font-ui-rounded)" },
	{ value: "mono", label: "Monospace", stack: "var(--font-mono)" },
];

const CODE_FONT_OPTIONS: readonly FontOption<CodeFont>[] = [
	{ value: "system", label: "System mono", stack: "var(--font-mono-system)" },
	{ value: "jetbrains", label: "JetBrains Mono", stack: "var(--font-mono-jetbrains)" },
	{ value: "fira", label: "Fira Code", stack: "var(--font-mono-fira)" },
	{ value: "cascadia", label: "Cascadia Code", stack: "var(--font-mono-cascadia)" },
	{ value: "sfmono", label: "SF Mono", stack: "var(--font-mono-sfmono)" },
	{ value: "menlo", label: "Menlo", stack: "var(--font-mono-menlo)" },
];

function isDefault(appearance: Appearance): boolean {
	return (Object.keys(DEFAULT_APPEARANCE) as (keyof Appearance)[]).every(
		key => appearance[key] === DEFAULT_APPEARANCE[key],
	);
}

export function AppearanceSection(): ReactNode {
	const { preference, setPreference } = useThemePreference();
	const appearance = useAppearance();
	const available = useFontAvailability();
	const hasPaneSizes = useHasPaneSizes();
	const fonts = FONT_OPTIONS.map(option => ({
		...option,
		missing: available.font[option.value] ? undefined : "Not available here",
	}));
	const codeFonts = CODE_FONT_OPTIONS.map(option => ({
		...option,
		missing: available.codeFont[option.value] ? undefined : "Not installed",
	}));
	return (
		<>
			<SettingsGroup title="Preview">
				<AppearancePreview />
			</SettingsGroup>
			<SettingsGroup title="Theme & colour">
				<SettingsRow label="Theme" hint="System follows your device's light or dark setting.">
					<Choice label="Theme" value={preference} options={THEMES} onChange={setPreference} />
				</SettingsRow>
				<SettingsRow label="Accent colour" hint="Buttons, links, highlights and the focus ring.">
					<AccentSwatches value={appearance.accent} onChange={accent => setAppearance({ accent })} />
				</SettingsRow>
				<SettingsRow
					label="Defaults"
					hint="Theme, accent, zoom, text size, fonts and line spacing back to their defaults. Pane sizes, the top bar and the pet stay."
				>
					<button
						type="button"
						className="sh-btn"
						disabled={preference === "system" && isDefault(appearance)}
						onClick={resetAppearance}
					>
						<RotateCcw size={14} /> Reset appearance
					</button>
				</SettingsRow>
			</SettingsGroup>
			<SettingsGroup title="Text">
				<SettingsRow
					label="Text size"
					hint="Conversation text, code, tool output and the message box. Buttons and labels keep their size; Zoom scales those."
				>
					<Choice
						label="Text size"
						value={appearance.textSize}
						options={TEXT_SIZES}
						onChange={textSize => setAppearance({ textSize })}
					/>
				</SettingsRow>
				<SettingsRow label="Font" hint="The typeface of the whole app. Fonts come from this device.">
					<FontPicker
						label="Font"
						value={appearance.font}
						options={fonts}
						sample="Aa Quick fox"
						onChange={font => setAppearance({ font })}
					/>
				</SettingsRow>
				<SettingsRow
					label="Code font"
					hint="Code blocks, commands, tool output and the editor. A font this device does not have cannot be chosen."
				>
					<FontPicker
						label="Code font"
						value={appearance.codeFont}
						options={codeFonts}
						sample="Aa 0O1l {}"
						onChange={codeFont => setAppearance({ codeFont })}
					/>
				</SettingsRow>
				<SettingsRow label="Line spacing" hint="The air between lines and between blocks in the conversation.">
					<Choice
						label="Line spacing"
						value={appearance.spacing}
						options={SPACINGS}
						onChange={spacing => setAppearance({ spacing })}
					/>
				</SettingsRow>
			</SettingsGroup>
			<SettingsGroup title="Layout">
				<SettingsRow label="Zoom" hint={`Scales the whole interface, not only the text. Now ${appearance.zoom}%.`}>
					<div className="sh-appr-zoom">
						<Choice
							label="Zoom"
							value={appearance.zoom}
							options={ZOOMS}
							onChange={zoom => setAppearance({ zoom })}
						/>
						<button
							type="button"
							className="sh-btn"
							disabled={appearance.zoom === DEFAULT_APPEARANCE.zoom}
							onClick={() => setAppearance({ zoom: DEFAULT_APPEARANCE.zoom })}
						>
							<RotateCcw size={14} /> Reset to 100%
						</button>
					</div>
				</SettingsRow>
				<SettingsRow
					label="Pane sizes"
					hint="The widths of the sessions sidebar, agents rail, split view and editor, set by dragging their dividers."
				>
					<button type="button" className="sh-btn" disabled={!hasPaneSizes} onClick={resetPaneSizes}>
						<RotateCcw size={14} /> Reset pane sizes
					</button>
				</SettingsRow>
			</SettingsGroup>
			<SettingsGroup title="Top bar">
				<SettingsRow
					label="Buttons"
					hint="Hidden buttons stay in the ⋯ menu and the command palette. A phone's bar has room for four: the first four of yours, not counting the ones marked Not on phones."
				>
					<TopBarControls />
				</SettingsRow>
			</SettingsGroup>
			<SettingsGroup title="Pet">
				<PetPanel />
			</SettingsGroup>
		</>
	);
}
