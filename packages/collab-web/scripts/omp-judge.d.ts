/**
 * Types for the standalone judge the companion calls for a bake-off's second opinion (tsconfig `paths` maps
 * `@oh-my-pi/pi-coding-agent/judgment/standalone` here). This project type-checks with the browser's DOM lib, and the
 * real module graph only type-checks against the workspace's non-DOM lib. bun still resolves the real module at
 * runtime. Keep in sync with packages/coding-agent/src/judgment/standalone.ts.
 */

/** One billed judgment attempt, as `JudgeDeps.onUsage` reports it. */
export interface JudgmentUsage {
	purpose: string;
	role: string;
	api: string;
	provider: string;
	model: string;
	usage: { input: number; output: number; cost: { total: number } };
	stopReason: string;
	errorMessage?: string;
}

/** What the `judge` role resolves to first. */
export interface JudgeDescription {
	kind: "native" | "local" | "online";
	explicit: boolean;
	label: string;
}

export interface StandaloneJudge {
	judge: {
		judge(
			request: { state: unknown; questions: Record<string, unknown> },
			options?: { signal?: AbortSignal },
		): Promise<{ answers: Record<string, any> }>;
		/** The model the first candidate routes to; its `cost` is USD per million tokens. */
		primaryModel(): { provider: string; id: string; cost: { input: number; output: number } } | undefined;
	};
	native: boolean;
	describe: JudgeDescription | undefined;
	close(): void;
}

export function openStandaloneJudge(
	cwd: string,
	purpose: string,
	options?: { onUsage?: (usage: JudgmentUsage) => void },
): Promise<StandaloneJudge>;
