import type { JSX } from "react";
import type { PetdexPet } from "../../lib/petdex";
import { usePetSheetUrl } from "../../lib/use-pet-sheet";
import { Mascot, type MascotProps } from "./Mascot";
import { SpriteMascot } from "./SpriteMascot";

export interface PetFigureProps extends MascotProps {
	/** The chosen petdex pet; null draws our own mascot. */
	pick: PetdexPet | null;
}

/** The pet's art: the chosen petdex pet once its sheet is here, else our mascot (also while it downloads or when it cannot). */
export function PetFigure({ pick, ...art }: PetFigureProps): JSX.Element {
	const sheetUrl = usePetSheetUrl(pick);
	return sheetUrl === null ? <Mascot {...art} /> : <SpriteMascot {...art} sheetUrl={sheetUrl} />;
}
