/**
 * Private-mode egress policy: once entered, no model request may reach a provider outside the
 * allowlist.
 *
 * The policy is process-wide and one-way on purpose. A private session may run subagents, titles,
 * compaction and every other model call in this process, and none of them carries the session
 * object down to the transport; a process that has entered private mode therefore stays private
 * for its whole life (a later `/new`, resume or SDK session in the same process cannot loosen it).
 *
 * The check runs at every pi-ai entry that dispatches to a provider (`stream`, `streamSimple`,
 * the transport fetch, and the image/speech/transcription/embedding/rerank/video/judgment
 * dispatchers) and throws {@link PrivateModeError} before any network I/O.
 */

/** A model request targeted a provider that the private session does not allow. */
export class PrivateModeError extends Error {
	readonly provider: string;
	readonly allowedProviders: readonly string[];

	constructor(provider: string, allowedProviders: readonly string[]) {
		super(
			`${provider} is not allowed in a private session (private.providers: ${allowedProviders.join(", ") || "none"}).`,
		);
		this.name = "PrivateModeError";
		this.provider = provider;
		this.allowedProviders = allowedProviders;
	}
}

let allowedProviders: ReadonlySet<string> | undefined;

/**
 * Enter private mode for the rest of the process. Calling it again can only narrow the allowlist
 * (intersection), never widen it.
 */
export function enterPrivateMode(providers: Iterable<string>): void {
	const next = new Set(providers);
	if (allowedProviders === undefined) {
		allowedProviders = next;
		return;
	}
	const current = allowedProviders;
	allowedProviders = new Set([...next].filter(provider => current.has(provider)));
}

/** Whether this process has entered private mode. */
export function isPrivateModeActive(): boolean {
	return allowedProviders !== undefined;
}

/** The providers private mode allows, or `undefined` when the process is not private. */
export function privateModeProviders(): readonly string[] | undefined {
	return allowedProviders === undefined ? undefined : [...allowedProviders];
}

/** Whether a request to `provider` is permitted (always true outside private mode). */
export function isProviderAllowedInPrivateMode(provider: string): boolean {
	return allowedProviders === undefined || allowedProviders.has(provider);
}

/** Throws {@link PrivateModeError} when private mode is active and `provider` is not allowed. */
export function assertProviderAllowedInPrivateMode(provider: string): void {
	if (allowedProviders === undefined || allowedProviders.has(provider)) return;
	throw new PrivateModeError(provider, [...allowedProviders]);
}

/** Leave private mode. Test-only: production code has no way out of private mode. */
export function resetPrivateModeForTesting(): void {
	allowedProviders = undefined;
}
