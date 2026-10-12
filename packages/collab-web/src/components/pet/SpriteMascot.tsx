import type { CSSProperties, JSX } from "react";
import { spriteGeometry } from "../../lib/petdex";
import type { MascotProps } from "./Mascot";
import "./pet.css";

export interface SpriteMascotProps extends MascotProps {
	/** URL of the pet's sprite sheet: a blob URL of the cached download, or the asset address. */
	sheetUrl: string;
}

/**
 * A petdex pet: the state's row of the sprite sheet, stepped through with a CSS animation (so it also runs in
 * the pop-out window, with no script). `still` shows the row's first frame.
 */
export function SpriteMascot({ state, size, still, sheetUrl }: SpriteMascotProps): JSX.Element {
	const g = spriteGeometry(size, state);
	const style: CSSProperties & Record<`--${string}`, string | number> = {
		width: g.width,
		height: g.height,
		backgroundImage: `url("${sheetUrl}")`,
		backgroundSize: `${g.sheetWidth}px auto`,
		backgroundPosition: `0px ${g.offsetY}px`,
		"--tl-pet-sprite-end": `${g.travelX}px`,
		"--tl-pet-sprite-frames": g.frames,
		"--tl-pet-sprite-ms": `${g.durationMs}ms`,
	};
	return (
		<div
			key={state}
			className="tl-pet-sprite"
			data-state={state}
			data-still={still ? "true" : undefined}
			style={style}
			aria-hidden="true"
		/>
	);
}
