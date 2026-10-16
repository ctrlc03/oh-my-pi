/**
 * Whether this session runs the `chat-tree` memory mode (docs/personal-chat-tree.md), and the settings that mode
 * switches off: the context is bounded by the chat's view, so omp's own compaction has nothing to do, and the chat's
 * `zoom` is the only way to navigate memory, so Mnemopi recall is not injected.
 */
import type { Settings } from "../../config/settings";
import { cfgMnemopiAutoRecall, cfgMnemopiPinnedTokenLimit, cfgMnemopiRecallEveryTurn } from "../../mnemopi/settings";
import {
	cfgCompactionEnabled,
	cfgCompactionExperimentalContextManagement,
	cfgCompactionIdleEnabled,
	cfgCompactionMidTurnEnabled,
} from "../../session/context-settings";
import { cfgPersonalEnabled, cfgPersonalMemoryMode, cfgPersonalRunKind } from "../settings";

/** The Personal live session in `chat-tree` memory mode. Inert for the review run and for every other session. */
export function chatTreeActive(settings: Settings): boolean {
	return (
		cfgPersonalEnabled.get(settings) &&
		cfgPersonalRunKind.get(settings) === "live" &&
		cfgPersonalMemoryMode.get(settings) === "chat-tree"
	);
}

/** The compaction settings {@link applyChatTreeSettings} switches off, which the process override on the main session's settings would otherwise leak into every subagent overlay. */
const COMPACTION_SETTINGS = [
	cfgCompactionEnabled,
	cfgCompactionIdleEnabled,
	cfgCompactionMidTurnEnabled,
	cfgCompactionExperimentalContextManagement,
] as const;

/** The values of {@link COMPACTION_SETTINGS} as they were before the mode switched them off, per settings instance. */
const originalCompaction = new WeakMap<Settings, Record<string, boolean>>();

/** Switches off, for this process only, what the chat's view replaces. A no-op outside `chat-tree` mode. */
export function applyChatTreeSettings(settings: Settings): void {
	if (!chatTreeActive(settings)) return;
	if (!originalCompaction.has(settings)) {
		const originals: Record<string, boolean> = {};
		for (const setting of COMPACTION_SETTINGS) originals[setting.id] = setting.get(settings);
		originalCompaction.set(settings, originals);
	}
	for (const setting of COMPACTION_SETTINGS) setting.override(settings, false);
	cfgMnemopiAutoRecall.override(settings, false);
	cfgMnemopiRecallEveryTurn.override(settings, false);
	cfgMnemopiPinnedTokenLimit.override(settings, 0);
}

/**
 * Overrides for a subagent's settings overlay that give it back the compaction the main session switched off: the
 * chat's view bounds only the main session's context, a subagent has no chat. Undefined when `settings` is not a
 * `chat-tree` session's.
 */
export function chatTreeSubagentOverrides(settings: Settings): Readonly<Record<string, boolean>> | undefined {
	return originalCompaction.get(settings);
}
