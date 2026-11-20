import { Lock } from "lucide-react";
import type { ReactNode } from "react";
import "./private.css";

const TIP = "Private: only this computer's local models; nothing leaves it";

/** A private session, in the same place and weight as the sandboxed and high-stakes chips. */
export function PrivateChip(): ReactNode {
	return (
		<span className="sh-chip sh-chip-private" role="img" aria-label="Private session" title={TIP}>
			<Lock size={11} aria-hidden="true" /> Private
		</span>
	);
}

/** Icon-only mark for the session header and the sidebar rows (the header drops its pills on phones). */
export function PrivateMark(): ReactNode {
	return (
		<span className="sh-private-mark" role="img" aria-label="Private session" data-tip={TIP} title={TIP}>
			<Lock size={12} />
		</span>
	);
}
