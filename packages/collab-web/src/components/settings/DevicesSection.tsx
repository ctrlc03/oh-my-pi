import type { ReactNode } from "react";
import { DevicesPanel } from "../shell/DevicesPanel";
import type { SettingsEnv } from "./env";
import { ComputerGate, SettingsGroup } from "./SettingsRows";

/** The devices each computer lets control it; with several computers, one block per computer. */
export function DevicesSection({ env }: { env: SettingsEnv }): ReactNode {
	const { computers } = env;
	if (computers.length === 1) {
		return <ComputerGate computer={computers[0]!}>{client => <DevicesPanel client={client} />}</ComputerGate>;
	}
	return (
		<>
			{computers.map(computer => (
				<SettingsGroup key={computer.id} title={computer.name}>
					<ComputerGate computer={computer} named>
						{client => <DevicesPanel client={client} computerName={computer.name} />}
					</ComputerGate>
				</SettingsGroup>
			))}
		</>
	);
}
