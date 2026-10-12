import type { ReactNode } from "react";
import { AutoSettlePanel } from "../shell/OrgMenu";
import { WorktreeSettings } from "../shell/WorktreeSettings";
import type { SettingsEnv } from "./env";
import { ComputerGate, SettingsGroup } from "./SettingsRows";

/** Auto-settle works on this device alone; the computer adds the shared copy, the pull request rule and worktrees. */
export function SessionsSection({ env }: { env: SettingsEnv }): ReactNode {
	const { companion, org } = env;
	return (
		<>
			<SettingsGroup title="Auto-settle">
				<AutoSettlePanel org={org} />
			</SettingsGroup>
			{companion?.snap.canGitFlow === true && (
				<SettingsGroup title="Git worktrees">
					<ComputerGate companion={companion}>{client => <WorktreeSettings client={client} />}</ComputerGate>
				</SettingsGroup>
			)}
		</>
	);
}
