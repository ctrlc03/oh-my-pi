import type { PairingLink } from "../../lib/companion";
import type { ComputerHandle } from "../../lib/computers";
import type { PushControls } from "../../lib/push";
import type { SessionOrgs } from "../../lib/use-session-org";

/** What the Settings sections read from the app. */
export interface SettingsEnv {
	/** The paired computers; empty while none is paired. */
	computers: readonly ComputerHandle[];
	/** Push on this device, per computer. */
	pushes: PushControls;
	/** Session organisation (auto-settle and the rest), per computer. */
	orgs: SessionOrgs;
	/** A pairing link was pasted or scanned; the app pairs with the computer it names. */
	onPair(link: PairingLink): void;
	/** Unpair a computer from this device (and sign this device out of it when it is reachable). Rejects with a readable message. */
	onRemoveComputer(id: string): Promise<void>;
}
