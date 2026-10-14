import type { ReactNode } from "react";
import { DEVICE_ORG } from "../../lib/org-storage";
import { AutoSettlePanel } from "../shell/OrgMenu";
import { WorktreeSettings } from "../shell/WorktreeSettings";
import type { SettingsEnv } from "./env";
import { ComputerGate, SettingsGroup } from "./SettingsRows";

/**
 * Auto-settle works on this device alone; each computer adds the shared copy, the pull request rule and worktrees.
 * With several computers each has its own block: pinned, snoozed and settled sessions are kept per computer.
 */
export function SessionsSection({ env }: { env: SettingsEnv }): ReactNode {
	const { computers, orgs } = env;
	if (computers.length === 0) {
		return (
			<SettingsGroup title="Auto-settle">
				<AutoSettlePanel org={orgs.of(DEVICE_ORG)} />
			</SettingsGroup>
		);
	}
	if (computers.length === 1) {
		const computer = computers[0]!;
		return (
			<>
				<SettingsGroup title="Auto-settle">
					<AutoSettlePanel org={orgs.of(computer.id)} />
				</SettingsGroup>
				{computer.snap.canGitFlow && (
					<SettingsGroup title="Git worktrees">
						<ComputerGate computer={computer}>{client => <WorktreeSettings client={client} />}</ComputerGate>
					</SettingsGroup>
				)}
			</>
		);
	}
	return (
		<>
			{computers.map(computer => (
				<SettingsGroup key={computer.id} title={computer.name}>
					<SettingsGroup nested title="Auto-settle">
						<AutoSettlePanel org={orgs.of(computer.id)} />
					</SettingsGroup>
					{computer.snap.canGitFlow && (
						<SettingsGroup nested title="Git worktrees">
							<ComputerGate computer={computer} named>
								{client => <WorktreeSettings client={client} computerName={computer.name} />}
							</ComputerGate>
						</SettingsGroup>
					)}
				</SettingsGroup>
			))}
		</>
	);
}
