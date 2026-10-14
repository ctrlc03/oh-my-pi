/**
 * Judge for commands that run outside an agent session (`omp find`, `omp stats`,
 * the git TUI's AI staging): project settings, a fresh auth store, the model
 * registry, and CLI extension providers, resolved the same way everywhere.
 */
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { discoverAuthStorage, loadCliExtensionProviders } from "../sdk";
import {
	type ChainJudge,
	describeJudge,
	hasNativeJudge,
	type JudgeDeps,
	type JudgeDescription,
	resolveJudge,
	sharedJudgmentCache,
} from ".";

export interface StandaloneJudge {
	judge: ChainJudge;
	/** The judge role resolves first to a native System One model; prompted fallbacks cannot give calibrated probabilities. */
	native: boolean;
	/** What the role resolves to first (kind, whether it was assigned explicitly, label); undefined when no model is available. */
	describe: JudgeDescription | undefined;
	/** Release the auth store; the judge must not be used afterwards. */
	close(): void;
}

/**
 * Resolve the `judge` role chain for `cwd`'s project settings and extensions.
 * No session ledger exists here; `onUsage` receives every billed attempt (cache hits never), so a caller that
 * enforces a spending limit can read the cost. `purpose` labels telemetry; native answers still go through the
 * shared answer cache.
 */
export async function openStandaloneJudge(
	cwd: string,
	purpose: string,
	options: { onUsage?: JudgeDeps["onUsage"] } = {},
): Promise<StandaloneJudge> {
	const settings = await Settings.init({ cwd });
	const authStorage = await discoverAuthStorage(undefined, { settings });
	try {
		const registry = new ModelRegistry(authStorage);
		await registry.refresh();
		await loadCliExtensionProviders(registry, settings, cwd);
		return {
			judge: resolveJudge({
				settings,
				registry,
				sessionId: Bun.randomUUIDv7(),
				purpose,
				cache: sharedJudgmentCache(),
				onUsage: options.onUsage,
			}),
			native: hasNativeJudge(settings, registry),
			describe: describeJudge(settings, registry),
			close: () => authStorage.close(),
		};
	} catch (error) {
		authStorage.close();
		throw error;
	}
}
