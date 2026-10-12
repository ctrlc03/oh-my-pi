import type { PushControl } from "../../lib/push";
import type { CompanionHandle } from "../../lib/use-companion";
import type { SessionOrgControl } from "../../lib/use-session-org";

/** What the Settings sections read from the app. */
export interface SettingsEnv {
	/** The paired computer; null while none is paired. */
	companion: CompanionHandle | null;
	push: PushControl;
	org: SessionOrgControl;
}
