/** A petdex pet's sprite sheet as a URL a CSS background can use. */

import { useEffect, useState } from "react";
import { loadPetdexSheet, type PetdexPet } from "./petdex";

/**
 * The object URL of `pick`'s sheet, from this device's saved copy or one download; null while it loads, when
 * `pick` is null and when the sheet cannot be had (the caller then draws the mascot).
 */
export function usePetSheetUrl(pick: PetdexPet | null): string | null {
	const [loaded, setLoaded] = useState<{ sheet: string; url: string } | null>(null);
	const sheet = pick?.sheet ?? null;
	useEffect(() => {
		if (sheet === null) return;
		let url: string | null = null;
		let cancelled = false;
		loadPetdexSheet(sheet).then(
			blob => {
				if (cancelled) return;
				url = URL.createObjectURL(blob);
				setLoaded({ sheet, url });
			},
			() => {},
		);
		return () => {
			cancelled = true;
			if (url !== null) URL.revokeObjectURL(url);
		};
	}, [sheet]);
	return loaded !== null && loaded.sheet === sheet ? loaded.url : null;
}
