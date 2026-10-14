import type { ReactNode } from "react";
import { APP_BUILD } from "../../lib/pwa";
import { servedByLabel } from "../../lib/relay-route";
import { DiagnosticsPanel } from "../shell/DiagnosticsPanel";
import type { SettingsEnv } from "./env";
import { ComputerGate, SettingsGroup } from "./SettingsRows";

export function AboutSection({ env }: { env: SettingsEnv }): ReactNode {
	const { computers } = env;
	const many = computers.length > 1;
	return (
		<>
			<SettingsGroup title="This app">
				<dl className="sh-diag-list">
					<div className="sh-diag-row">
						<dt>App build</dt>
						<dd>{APP_BUILD}</dd>
					</div>
					<div className="sh-diag-row">
						<dt>Served by</dt>
						<dd>{servedByLabel(window.location)}</dd>
					</div>
				</dl>
			</SettingsGroup>
			{computers.map(computer => (
				<SettingsGroup key={computer.id} title={many ? computer.name : (computer.snap.machine ?? "Your computer")}>
					<ComputerGate computer={computer} named={many}>
						{client => <DiagnosticsPanel client={client} computerName={many ? computer.name : undefined} />}
					</ComputerGate>
				</SettingsGroup>
			))}
		</>
	);
}
