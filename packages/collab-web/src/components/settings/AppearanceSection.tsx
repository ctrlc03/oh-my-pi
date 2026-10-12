import { Moon, Sun, SunMoon } from "lucide-react";
import type { ReactNode } from "react";
import { type ThemePreference, useThemePreference } from "../../lib/theme";
import { PetPanel } from "../pet/PetPanel";
import { Choice, SettingsGroup, SettingsRow } from "./SettingsRows";

const THEMES: readonly { value: ThemePreference; label: string; icon: ReactNode }[] = [
	{ value: "system", label: "System", icon: <SunMoon size={14} /> },
	{ value: "light", label: "Light", icon: <Sun size={14} /> },
	{ value: "dark", label: "Dark", icon: <Moon size={14} /> },
];

export function AppearanceSection(): ReactNode {
	const { preference, setPreference } = useThemePreference();
	return (
		<>
			<SettingsGroup>
				<SettingsRow label="Theme" hint="System follows your device's light or dark setting.">
					<Choice label="Theme" value={preference} options={THEMES} onChange={setPreference} />
				</SettingsRow>
			</SettingsGroup>
			<SettingsGroup title="Pet">
				<PetPanel />
			</SettingsGroup>
		</>
	);
}
