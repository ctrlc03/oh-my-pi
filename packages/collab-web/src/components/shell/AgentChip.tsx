import { Bot } from "lucide-react";
import type { ReactNode } from "react";
import type { AgentRef } from "../../lib/companion";
import "./agents.css";

export interface AgentChipProps {
	/** The vendor agent behind a session. omp sessions carry none, and show nothing. */
	agent?: AgentRef | null;
	/** `chip`: a pill among a row's chips; `mark`: plain text and icon for the session header, which hides its chips on phones. */
	variant?: "chip" | "mark";
}

/** Which vendor agent runs a session, in the same place and weight as the sandboxed badge. */
export function AgentChip({ agent, variant = "chip" }: AgentChipProps): ReactNode {
	if (!agent) return null;
	if (variant === "mark") {
		return (
			<span className="sh-agent-mark">
				<Bot size={12} /> {agent.name}
			</span>
		);
	}
	return (
		<span className="sh-chip sh-chip-agent">
			<Bot size={11} /> {agent.name}
		</span>
	);
}
