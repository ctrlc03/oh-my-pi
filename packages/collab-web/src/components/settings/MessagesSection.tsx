import { MessageSquare, Rows3 } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { setDefaultChat, useDefaultChat } from "../../lib/chat-view";
import { type EnterWhileRunning, setEnterWhileRunning, useEnterWhileRunning } from "../../lib/composer-prefs";
import { displayName, MAX_NAME_CHARS, setDisplayName, useDisplayName } from "../../lib/display-name";
import { SPEECH_RATES, type SpeechRate, setSpeechRate, speechAvailable, useSpeechRate } from "../../lib/speech";
import { QuickRepliesEditor } from "./QuickRepliesEditor";
import { Choice, SettingsGroup, SettingsRow } from "./SettingsRows";

const ENTER_CHOICES: readonly { value: EnterWhileRunning; label: string; tip: string }[] = [
	{ value: "steer", label: "Steers", tip: "Enter sends into the running turn; Alt+Enter waits for it to end" },
	{ value: "queue", label: "Queues", tip: "Enter waits for the running turn to end; Alt+Enter sends into it" },
];

const VIEWS: readonly { value: boolean; label: string; icon: ReactNode }[] = [
	{ value: true, label: "Chat", icon: <MessageSquare size={14} /> },
	{ value: false, label: "Full", icon: <Rows3 size={14} /> },
];

const RATES: readonly { value: SpeechRate; label: string }[] = SPEECH_RATES.map(rate => ({
	value: rate,
	label: `${rate}×`,
}));

function NameField(): ReactNode {
	const saved = useDisplayName();
	const [draft, setDraft] = useState(saved);
	return (
		<input
			className="sh-input sh-set-input"
			type="text"
			value={draft}
			onChange={e => {
				setDraft(e.currentTarget.value);
				if (e.currentTarget.value.trim() !== "") setDisplayName(e.currentTarget.value);
			}}
			onBlur={() => setDraft(displayName())}
			aria-label="Display name"
			placeholder="guest"
			maxLength={MAX_NAME_CHARS}
			spellCheck={false}
			autoComplete="off"
		/>
	);
}

export function MessagesSection(): ReactNode {
	const enter = useEnterWhileRunning();
	const chat = useDefaultChat();
	const rate = useSpeechRate();
	return (
		<>
			<SettingsGroup title="Sending">
				<SettingsRow label="Enter key" hint="What Enter does while the agent is working. Alt+Enter does the other.">
					<Choice
						label="Enter while the agent is working"
						value={enter}
						options={ENTER_CHOICES}
						onChange={setEnterWhileRunning}
					/>
				</SettingsRow>
				<SettingsRow label="Display name" hint="Shown to the others in a session. Used the next time you join one.">
					<NameField />
				</SettingsRow>
			</SettingsGroup>
			<SettingsGroup title="Reading">
				<SettingsRow
					label="View for new sessions"
					hint="Chat shows prompts and replies with tool runs folded. A session can switch in its ⋯ menu."
				>
					<Choice label="View for new sessions" value={chat} options={VIEWS} onChange={setDefaultChat} />
				</SettingsRow>
				{speechAvailable() && (
					<SettingsRow label="Speaking speed" hint="How fast hands-free mode reads replies aloud.">
						<Choice label="Speaking speed" value={rate} options={RATES} onChange={setSpeechRate} />
					</SettingsRow>
				)}
			</SettingsGroup>
			<SettingsGroup title="Saved prompts">
				<p className="sh-field-hint">One-tap prompts above the message box. Tap one to change it.</p>
				<QuickRepliesEditor />
			</SettingsGroup>
		</>
	);
}
