import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import type { ComputerHandle } from "../../lib/computers";
import type { PushControl } from "../../lib/push";
import { PrAlerts } from "../shell/PrAlerts";
import { SpendAlerts } from "../shell/SpendAlerts";
import type { SettingsEnv } from "./env";
import { Choice, ComputerGate, SettingsGroup, SettingsRow, Where } from "./SettingsRows";

const ON_OFF: readonly { value: boolean; label: string }[] = [
	{ value: false, label: "Off" },
	{ value: true, label: "On" },
];

/**
 * Push on this device: the browser subscribes with the computer's key, and the computer pushes when a session needs you.
 * `computerName` (several computers are paired) says which computer's sessions the push is about.
 */
function PushRow({ push, computerName }: { push: PushControl; computerName?: string }): ReactNode {
	if (push.status === "unsupported") {
		return (
			<p className="sh-field-hint">
				This browser cannot receive push notifications. On an iPhone or iPad they work in the app installed to the
				home screen (iOS 16.4 and later).
			</p>
		);
	}
	return (
		<SettingsRow
			label="Notify me on this device"
			hint={
				computerName === undefined
					? "When a session needs input or finishes a turn."
					: `When a session on ${computerName} needs input or finishes a turn.`
			}
		>
			{push.status === "denied" ? (
				<span className="sh-field-hint">Blocked in this browser's settings</span>
			) : (
				<>
					{push.status === "busy" && <LoaderCircle size={14} className="sh-spin" aria-label="Working" />}
					<Choice
						label={
							computerName === undefined
								? "Notifications on this device"
								: `Notifications on this device for ${computerName}`
						}
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

/** One computer's notification settings: push on this device, then the alerts the computer sends. */
function ComputerNotifications({
	computer,
	push,
	nested,
	computerName,
}: {
	computer: ComputerHandle;
	push: PushControl;
	/** Several computers are paired: these groups sit inside the computer's own block. */
	nested: boolean;
	computerName: string | undefined;
}): ReactNode {
	const machine = computer.snap.machine ?? "your computer";
	const where = <Where machine={computerName ?? machine} />;
	return (
		<>
			<SettingsGroup title="This device" where={<Where machine={null} />} nested={nested}>
				<PushRow push={push} computerName={computerName} />
				{push.error && <div className="sh-connect-error">{push.error}</div>}
			</SettingsGroup>
			<ComputerGate computer={computer} named={nested}>
				{client => (
					<>
						{computer.snap.canGithub && (
							<SettingsGroup title="GitHub alerts" where={where} nested={nested}>
								<PrAlerts client={client} computerName={computerName} />
							</SettingsGroup>
						)}
						<SettingsGroup title="Spend alerts" where={where} nested={nested}>
							<SpendAlerts client={client} computerName={computerName} />
						</SettingsGroup>
					</>
				)}
			</ComputerGate>
		</>
	);
}

export function NotificationsSection({ env }: { env: SettingsEnv }): ReactNode {
	const { computers, pushes } = env;
	if (computers.length === 0) return null;
	if (computers.length === 1) {
		const computer = computers[0]!;
		return (
			<ComputerNotifications
				computer={computer}
				push={pushes.of(computer.id)}
				nested={false}
				computerName={undefined}
			/>
		);
	}
	return (
		<>
			{computers.map(computer => (
				<SettingsGroup key={computer.id} title={computer.name}>
					<ComputerNotifications
						computer={computer}
						push={pushes.of(computer.id)}
						nested
						computerName={computer.name}
					/>
				</SettingsGroup>
			))}
		</>
	);
}
