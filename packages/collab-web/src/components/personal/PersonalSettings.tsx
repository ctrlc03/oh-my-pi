import type { ReactNode } from "react";
import { useState } from "react";
import { PERSONAL_TAB_ORDER, PERSONAL_TABS, type PersonalTab, takeRequestedTab } from "../../lib/personal-ui";
import { usePersonal } from "../../lib/use-personal";
import { AboutTab } from "./AboutTab";
import { ActivityTab } from "./ActivityTab";
import { AgentTab } from "./AgentTab";
import { MemoryTab } from "./MemoryTab";
import { SettingsTab } from "./SettingsTab";
import { SetupWizard } from "./SetupWizard";

/**
 * Settings → Personal agent. Without a home computer this is the setup flow; with one, its tabs: the agent's state, Memory,
 * About you, Activity (proposals, digests, events) and the agent's settings. Loaded on demand: the app's entry chunk does
 * not carry any of it.
 */
export default function PersonalSettings(): ReactNode {
	const personal = usePersonal();
	const { home } = personal;
	const [tab, setTab] = useState<PersonalTab>(() => takeRequestedTab() ?? "agent");
	if (home.computer === null) return <SetupWizard />;
	const open = home.status === null ? 0 : home.status.counts.proposals + home.status.counts.digests;
	return (
		<div className="pa-screen">
			{home.duplicates.length > 0 && (
				<div className="pa-note pa-note-warn" role="status">
					Personal is also set up on {home.duplicates.map(computer => computer.name).join(", ")}. Only{" "}
					{home.computer.name} is used. Memory is never copied between computers: turn Personal off on the others.
				</div>
			)}
			<div className="pa-tabs" role="tablist" aria-label="Personal agent">
				{PERSONAL_TAB_ORDER.map(id => (
					<button
						key={id}
						type="button"
						role="tab"
						id={`pa-tab-${id}`}
						aria-selected={tab === id}
						aria-controls="pa-panel"
						className="pa-tab"
						onClick={() => setTab(id)}
					>
						{PERSONAL_TABS[id]}
						{id === "activity" && open > 0 && <span className="pa-tab-count">{open}</span>}
					</button>
				))}
			</div>
			<div id="pa-panel" role="tabpanel" aria-labelledby={`pa-tab-${tab}`} className="pa-panel">
				{tab === "agent" && <AgentTab goTo={setTab} />}
				{tab === "memory" && <MemoryTab />}
				{tab === "about" && <AboutTab />}
				{tab === "activity" && <ActivityTab />}
				{tab === "settings" && <SettingsTab />}
			</div>
		</div>
	);
}
