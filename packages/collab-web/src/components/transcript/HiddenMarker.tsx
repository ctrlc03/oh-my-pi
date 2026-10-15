import { Eye, EyeOff } from "lucide-react";
import type { ReactNode } from "react";
import type { HiddenSlot } from "../../lib/hidden-messages";
import type { HideView } from "./Block";

/**
 * The thin line a run of hidden messages leaves in the transcript: how many, and *Show*, which reveals them in
 * place (dimmed) until *Hide again*. Revealed, *Unhide* makes them visible for good. Nothing else is offered
 * while they are hidden.
 */
export function HiddenMarker({
	slot,
	revealed,
	hide,
}: {
	slot: HiddenSlot;
	revealed: boolean;
	hide: HideView;
}): ReactNode {
	const noun = `${slot.size} hidden message${slot.size === 1 ? "" : "s"}`;
	const messages = `${slot.size} message${slot.size === 1 ? "" : "s"}`;
	return (
		<div
			className="tr-divider tr-divider--marker tr-hidden"
			data-revealed={revealed ? "" : undefined}
			data-hidden-marker
			role="group"
		>
			<EyeOff size={13} aria-hidden />
			<span className="tr-hidden-count">{noun}</span>
			<button
				type="button"
				className="tr-hidden-btn"
				aria-label={revealed ? `Hide again, ${noun}` : `Show ${noun}`}
				onClick={() => hide.toggle(slot.group)}
			>
				{revealed ? "Hide again" : "Show"}
			</button>
			{revealed && (
				<button
					type="button"
					className="tr-hidden-btn"
					aria-label={`Unhide ${messages}`}
					onClick={() => hide.unhideGroup(slot.group)}
				>
					<Eye size={13} aria-hidden />
					Unhide
				</button>
			)}
		</div>
	);
}
