import type { ToolResultMessage } from "@oh-my-pi/pi-wire";
import type { ReactNode } from "react";
import { memo, useMemo } from "react";
import { effectiveCall, toolMeta } from "../../lib/blocks";
import { messageText } from "../../lib/format";
import { type ToolHeadState, type ToolRenderHost, ToolView } from "../../tool-render";
import { ToolBlockHead } from "./Block";

export interface ToolCardProps {
	toolCallId: string;
	name: string;
	args: unknown;
	intent?: string;
	result?: ToolResultMessage;
	running?: boolean;
	partialResult?: unknown;
	host?: ToolRenderHost;
	/** The card is a transcript block: its header carries the status, command, wall time and block actions. */
	framed?: boolean;
}

/** Wire-type adapter over the shared per-tool renderer stack. */
export const ToolCard = memo(function ToolCard(props: ToolCardProps): ReactNode {
	const { toolCallId, name, intent, args, result, running, partialResult, host, framed } = props;
	const partial =
		running && !result ? (typeof partialResult === "string" ? partialResult : messageText(partialResult)) : "";
	const head = useMemo(() => {
		if (framed !== true) return undefined;
		const call = effectiveCall(name, args, result);
		const meta = toolMeta(call.name, call.args, call.result);
		return (state: ToolHeadState): ReactNode => <ToolBlockHead id={toolCallId} state={state} meta={meta} />;
	}, [framed, toolCallId, name, args, result]);
	return (
		<ToolView
			name={name}
			args={args}
			result={result}
			running={running}
			intent={intent}
			partial={partial || undefined}
			host={host}
			head={head}
		/>
	);
});
