import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import type { PushControl } from "../../lib/push";
import { PrAlerts } from "../shell/PrAlerts";
import { SpendAlerts } from "../shell/SpendAlerts";
import type { SettingsEnv } from "./env";
import { Choice, ComputerGate, SettingsGroup, SettingsRow, Where } from "./SettingsRows";

const ON_OFF: readonly { value: boolean; label: string }[] = [
	{ value: false, label: "Off" },
	{ value: true, label: "On" },
];

/** Push on this device: the browser subscribes with the computer's key, and the computer pushes when a session needs you. */
function PushRow({ push }: { push: PushControl }): ReactNode {
	if (push.status === "unsupported") {
		return (
			<p className="sh-field-hint">
				This browser cannot receive push notifications. On an iPhone or iPad they work in the app installed to the
				home screen (iOS 16.4 and later).
			</p>
		);
	}
	return (
		<SettingsRow label="Notify me on this device" hint="When a session needs input or finishes a turn.">
			{push.status === "denied" ? (
				<span className="sh-field-hint">Blocked in this browser's settings</span>
			) : (
				<>
					{push.status === "busy" && <LoaderCircle size={14} className="sh-spin" aria-label="Working" />}
					<Choice
						label="Notifications on this device"
						value={push.status === "on"}
						options={ON_OFF}
						onChange={on => {
							if (on !== (push.status === "on") && push.status !== "busy") push.toggle();
						}}
					/>
				</>
			)}
		</SettingsRow>
	);
}

export function NotificationsSection({ env }: { env: SettingsEnv }): ReactNode {
	const { companion, push } = env;
	if (companion === null) return null;
	const machine = companion.snap.machine ?? "your computer";
	return (
		<>
			<SettingsGroup title="This device" where={<Where machine={null} />}>
				<PushRow push={push} />
				{push.error && <div className="sh-connect-error">{push.error}</div>}
			</SettingsGroup>
			<ComputerGate companion={companion}>
				{client => (
					<>
						{companion.snap.canGithub && (
							<SettingsGroup title="GitHub alerts" where={<Where machine={machine} />}>
								<PrAlerts client={client} />
							</SettingsGroup>
						)}
						<SettingsGroup title="Spend alerts" where={<Where machine={machine} />}>
							<SpendAlerts client={client} />
						</SettingsGroup>
					</>
				)}
			</ComputerGate>
		</>
	);
}
