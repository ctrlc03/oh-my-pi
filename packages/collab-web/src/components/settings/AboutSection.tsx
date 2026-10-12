import type { ReactNode } from "react";
import { APP_BUILD } from "../../lib/pwa";
import { DiagnosticsPanel } from "../shell/DiagnosticsPanel";
import type { SettingsEnv } from "./env";
import { ComputerGate, SettingsGroup } from "./SettingsRows";

export function AboutSection({ env }: { env: SettingsEnv }): ReactNode {
	const { companion } = env;
	return (
		<>
			<SettingsGroup title="This app">
				<dl className="sh-diag-list">
					<div className="sh-diag-row">
						<dt>App build</dt>
						<dd>{APP_BUILD}</dd>
					</div>
				</dl>
			</SettingsGroup>
			{companion !== null && (
				<SettingsGroup title={companion.snap.machine ?? "Your computer"}>
					<ComputerGate companion={companion}>{client => <DiagnosticsPanel client={client} />}</ComputerGate>
				</SettingsGroup>
			)}
		</>
	);
}
