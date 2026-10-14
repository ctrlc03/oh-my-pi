import type { ReactNode } from "react";
import type { EntryState } from "../../lib/personal";
import "./status-dot.css";

/** A coloured dot for a run state. Kept apart from the Personal screens so the sidebar entry does not load them. */
export function StatusDot({ tone, label }: { tone: EntryState["tone"]; label?: string }): ReactNode {
	return (
		<span
			className={`pa-dot pa-dot-${tone}`}
			role={label === undefined ? undefined : "img"}
			aria-label={label}
			aria-hidden={label === undefined}
		/>
	);
}
