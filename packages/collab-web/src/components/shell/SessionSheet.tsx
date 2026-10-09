import type { SessionCommand, SessionState, WireModel } from "@oh-my-pi/pi-wire";
import {
	ChevronDown,
	ChevronRight,
	type LucideIcon,
	LogOut,
	MessageSquare,
	Monitor,
	Moon,
	Rows3,
	Sun,
	X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { ConnectionPhase } from "../../lib/client";
import { fmtPercent, fmtTokens } from "../../lib/format";
import type { PushControl } from "../../lib/push";
import { type ThemePreference, useThemePreference } from "../../lib/theme";
import { formatUsage, type SessionUsage } from "../../lib/usage";
import { PushButton, SandboxedChip } from "./CompanionCard";
import { Sheet } from "./Sheet";

const THEMES: readonly { value: ThemePreference; label: string; Icon: LucideIcon }[] = [
	{ value: "system", label: "System", Icon: Monitor },
	{ value: "light", label: "Light", Icon: Sun },
	{ value: "dark", label: "Dark", Icon: Moon },
];

const VIEWS: readonly { chat: boolean; label: string; Icon: LucideIcon }[] = [
	{ chat: true, label: "Chat", Icon: MessageSquare },
	{ chat: false, label: "Full", Icon: Rows3 },
];

const PUSH_LABEL: Record<PushControl["status"], string> = {
	unsupported: "",
	off: "Off",
	on: "On",
	busy: "…",
	denied: "Blocked in settings",
};

/** Desktop shortcuts, wired in app.tsx; shown only where a pointer can use them. */
const SHORTCUTS: readonly { keys: string; action: string }[] = [
	{ keys: "⌘K / Ctrl K", action: "switch session" },
	{ keys: "/", action: "find in session" },
	{ keys: "Esc", action: "close, or stop a running turn" },
];

/** Models grouped by provider, in the host's order. */
function groupByProvider(models: readonly WireModel[]): [string, WireModel[]][] {
	const groups = new Map<string, WireModel[]>();
	for (const model of models) {
		const group = groups.get(model.provider);
		if (group) group.push(model);
		else groups.set(model.provider, [model]);
	}
	return [...groups];
}

export interface SessionSheetProps {
	title: string;
	state: SessionState | null;
	phase: ConnectionPhase;
	phaseLabel: string;
	readOnly: boolean;
	sandboxed: boolean;
	contextPct: number | null;
	/** Chat view: prompts and replies only, tool runs folded. */
	chat: boolean;
	onChatChange(chat: boolean): void;
	/** Files the agent changed this session. */
	changeCount: number;
	onOpenChanges(): void;
	push: PushControl;
	onLeave(): void;
	onClose(): void;
	/** The paired computer can show this session's git working tree. */
	workingTree: boolean;
	/** Totals summed from assistant messages; null when none reported usage. */
	usage: SessionUsage | null;
	/** Models this writer may switch to; null when the host predates session controls. */
	models: readonly WireModel[] | null;
	onSessionCommand(cmd: SessionCommand, arg?: string): void;
}

/**
 * Session details and the actions the compact header drops: connection, model,
 * context, participants, theme, and leave. A bottom sheet on phones, a dropdown
 * card under the header elsewhere.
 */
export function SessionSheet({
	title,
	state,
	phase,
	phaseLabel,
	readOnly,
	sandboxed,
	contextPct,
	chat,
	onChatChange,
	changeCount,
	onOpenChanges,
	workingTree,
	usage,
	models,
	onSessionCommand,
	push,
	onLeave,
	onClose,
}: SessionSheetProps): ReactNode {
	const { preference, setPreference } = useThemePreference();
	const [pickerOpen, setPickerOpen] = useState(false);
	const [compacting, setCompacting] = useState(false);
	const [instructions, setInstructions] = useState("");
	const canControl = models !== null && !readOnly && phase === "live";
	const levels = state?.thinkingLevels ?? [];

	return (
		<Sheet label="session details" onClose={onClose}>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title">{title}</div>
				<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="close">
					<X size={16} />
				</button>
			</div>
			{state?.cwd && <div className="sh-sheet-cwd">{state.cwd}</div>}

			<dl className="sh-sheet-rows">
				<div className="sh-sheet-row">
					<dt>Connection</dt>
					<dd>
						<span className={`sh-dot sh-dot-${phase}`} />
						{phaseLabel}
						{readOnly && <span className="sh-chip">read-only</span>}
						{sandboxed && <SandboxedChip />}
					</dd>
				</div>
				{state?.model && (
					<div className="sh-sheet-row">
						<dt>Model</dt>
						<dd className="sh-sheet-mono">
							{canControl ? (
								<button
									type="button"
									className="sh-sheet-link sh-sheet-mono"
									onClick={() => setPickerOpen(open => !open)}
									aria-expanded={pickerOpen}
								>
									{state.model.name}
									<ChevronDown size={14} />
								</button>
							) : (
								state.model.name
							)}
							{!(canControl && levels.length > 0) && state.thinkingLevel && (
								<span className="sh-sheet-faint"> · {state.thinkingLevel}</span>
							)}
						</dd>
					</div>
				)}
				{canControl && pickerOpen && models && (
					<div className="sh-model-list" role="listbox" aria-label="model">
						{groupByProvider(models).map(([provider, group]) => (
							<div key={provider} className="sh-model-group">
								<div className="sh-model-provider">{provider}</div>
								{group.map(model => {
									const current = model.id === state?.model?.id && model.provider === state.model.provider;
									return (
										<button
											key={model.id}
											type="button"
											role="option"
											aria-selected={current}
											className={current ? "sh-model sh-model-on" : "sh-model"}
											onClick={() => {
												setPickerOpen(false);
												if (!current) onSessionCommand("model", `${model.provider}/${model.id}`);
											}}
										>
											<span>{model.name}</span>
											{model.contextWindow !== null && (
												<span className="sh-sheet-faint">{fmtTokens(model.contextWindow)}</span>
											)}
										</button>
									);
								})}
							</div>
						))}
					</div>
				)}
				{canControl && levels.length > 0 && (
					<div className="sh-sheet-row">
						<dt>Thinking</dt>
						<dd>
							<div className="sh-segmented sh-segmented-wrap" role="radiogroup" aria-label="thinking level">
								{levels.map(level => (
									<button
										key={level}
										type="button"
										role="radio"
										aria-checked={state?.thinkingLevel === level}
										className={state?.thinkingLevel === level ? "sh-segment sh-segment-on" : "sh-segment"}
										onClick={() => {
											if (state?.thinkingLevel !== level) onSessionCommand("thinking", level);
										}}
									>
										{level}
									</button>
								))}
							</div>
						</dd>
					</div>
				)}
				{contextPct != null && (
					<div className="sh-sheet-row">
						<dt>Context</dt>
						<dd>
							<span className={contextPct > 80 ? "sh-gauge sh-gauge-warn" : "sh-gauge"}>
								<span className="sh-gauge-track sh-sheet-gauge">
									<span
										className="sh-gauge-fill"
										style={{ width: `${Math.min(100, Math.max(0, contextPct))}%` }}
									/>
								</span>
								<span className="sh-gauge-pct">{fmtPercent(contextPct)}</span>
							</span>
						</dd>
					</div>
				)}
				{usage && (
					<div className="sh-sheet-row sh-sheet-row-top">
						<dt>Usage</dt>
						<dd className="sh-sheet-usage">
							<span className="sh-sheet-mono">{formatUsage(usage.total)}</span>
							<span className="sh-sheet-faint">
								cache {fmtTokens(usage.total.cacheRead)} read · {fmtTokens(usage.total.cacheWrite)} write
							</span>
							{usage.last && <span className="sh-sheet-faint">last turn {formatUsage(usage.last)}</span>}
						</dd>
					</div>
				)}
				{canControl && (
					<div className="sh-sheet-row sh-sheet-row-top">
						<dt>Compact</dt>
						<dd className="sh-sheet-compact">
							{compacting ? (
								<>
									<span className="sh-sheet-faint">Summarize the conversation to free context?</span>
									<textarea
										className="sh-sheet-input"
										value={instructions}
										onChange={e => setInstructions(e.target.value)}
										placeholder="Instructions (optional)"
										rows={2}
										spellCheck={false}
									/>
									<span className="sh-sheet-actions">
										<button type="button" className="sh-btn" onClick={() => setCompacting(false)}>
											Cancel
										</button>
										<button
											type="button"
											className="sh-btn sh-btn-primary"
											onClick={() => {
												onSessionCommand("compact", instructions.trim() || undefined);
												setCompacting(false);
												setInstructions("");
											}}
										>
											Compact
										</button>
									</span>
								</>
							) : (
								<button type="button" className="sh-btn" onClick={() => setCompacting(true)}>
									Compact…
								</button>
							)}
						</dd>
					</div>
				)}
				{state && state.participants.length > 0 && (
					<div className="sh-sheet-row sh-sheet-row-top">
						<dt>People</dt>
						<dd className="sh-sheet-people">
							{state.participants.map((p, i) => (
								<span key={`${p.name}:${i}`} className="sh-sheet-person">
									<span className={p.role === "host" ? "sh-avatar sh-avatar-host" : "sh-avatar"}>
										{(p.name[0] ?? "?").toUpperCase()}
									</span>
									{p.name}
									<span className="sh-sheet-faint">
										{p.role}
										{p.readOnly ? " · view-only" : ""}
									</span>
								</span>
							))}
						</dd>
					</div>
				)}
				<div className="sh-sheet-row">
					<dt>View</dt>
					<dd>
						<div className="sh-segmented" role="radiogroup" aria-label="transcript view">
							{VIEWS.map(view => (
								<button
									key={view.label}
									type="button"
									role="radio"
									aria-checked={chat === view.chat}
									className={chat === view.chat ? "sh-segment sh-segment-on" : "sh-segment"}
									onClick={() => onChatChange(view.chat)}
								>
									<view.Icon size={14} /> {view.label}
								</button>
							))}
						</div>
					</dd>
				</div>
				<div className="sh-sheet-row">
					<dt>Changes</dt>
					<dd>
						<button
							type="button"
							className="sh-sheet-link"
							onClick={onOpenChanges}
							disabled={changeCount === 0 && !workingTree}
						>
							{changeCount > 0
								? `${changeCount} file${changeCount === 1 ? "" : "s"}`
								: workingTree
									? "Working tree"
									: "No files yet"}
							{(changeCount > 0 || workingTree) && <ChevronRight size={14} />}
						</button>
					</dd>
				</div>
				{push.status !== "unsupported" && (
					<div className="sh-sheet-row">
						<dt>Notify</dt>
						<dd>
							<PushButton push={push} />
							<span className="sh-sheet-faint">{PUSH_LABEL[push.status]}</span>
						</dd>
					</div>
				)}
				<div className="sh-sheet-row">
					<dt>Theme</dt>
					<dd>
						<div className="sh-segmented" role="radiogroup" aria-label="theme">
							{THEMES.map(({ value, label, Icon }) => (
								<button
									key={value}
									type="button"
									role="radio"
									aria-checked={preference === value}
									className={preference === value ? "sh-segment sh-segment-on" : "sh-segment"}
									onClick={() => setPreference(value)}
								>
									<Icon size={14} /> {label}
								</button>
							))}
						</div>
					</dd>
				</div>
			</dl>
			<div className="sh-shortcuts">
				<div className="sh-shortcuts-title">Shortcuts</div>
				{SHORTCUTS.map(shortcut => (
					<div key={shortcut.keys} className="sh-shortcut">
						<kbd>{shortcut.keys}</kbd>
						<span>{shortcut.action}</span>
					</div>
				))}
			</div>
			{push.error && <div className="sh-connect-error">{push.error}</div>}

			<button type="button" className="sh-btn sh-sheet-leave" onClick={onLeave}>
				<LogOut size={15} /> Leave session
			</button>
		</Sheet>
	);
}
