import { Eye, EyeOff, PawPrint } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo } from "react";
import type { GuestClient } from "../../lib/client";
import type { CompanionHost } from "../../lib/companion";
import { type PaletteEntry, usePaletteEntries } from "../../lib/palette";
import { closePetPip } from "../../lib/pet-pip";
import { setPetSettings, usePetSettings } from "../../lib/pet-settings";
import { closePetSheet, openPetSheet, usePetSheetOpen } from "../../lib/pet-ui";
import { PetLayer } from "./PetLayer";
import { PetSheet } from "./PetSheet";

export interface PetHostProps {
	/** The open session's client; null on the home screen. */
	client: GuestClient | null;
	hosts: readonly CompanionHost[];
	hostsLive: boolean;
}

/** The pet, mounted once at the app's top: the floating layer while it is on, its settings sheet, and its palette entries. */
export function PetHost({ client, hosts, hostsLive }: PetHostProps): ReactNode {
	const { enabled } = usePetSettings();
	const sheetOpen = usePetSheetOpen();

	// Turning the pet off takes the pop-out window with it.
	useEffect(() => {
		if (!enabled) closePetPip();
	}, [enabled]);

	const entries = useMemo<readonly PaletteEntry[]>(
		() => [
			{
				id: "pet:open",
				title: "Pet…",
				section: "Appearance",
				keywords: ["companion", "mascot", "petdex", "size", "roam", "pop out"],
				icon: PawPrint,
				run: openPetSheet,
			},
			enabled
				? {
						id: "pet:hide",
						title: "Hide pet",
						section: "Appearance",
						keywords: ["companion", "mascot"],
						icon: EyeOff,
						run: () => setPetSettings({ enabled: false }),
					}
				: {
						id: "pet:show",
						title: "Show pet",
						section: "Appearance",
						keywords: ["companion", "mascot"],
						icon: Eye,
						run: () => setPetSettings({ enabled: true }),
					},
		],
		[enabled],
	);
	usePaletteEntries(entries);

	return (
		<>
			{enabled && <PetLayer client={client} hosts={hosts} hostsLive={hostsLive} />}
			{sheetOpen && <PetSheet onClose={closePetSheet} />}
		</>
	);
}
