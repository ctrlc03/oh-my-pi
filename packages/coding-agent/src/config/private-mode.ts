/**
 * Entering private mode from the operator's settings. The egress guard itself lives in
 * `@oh-my-pi/pi-ai/private-mode`; this module owns the settings that feed it.
 */
import {
	enterPrivateMode,
	isPrivateModeActive,
	isProviderAllowedInPrivateMode,
	privateModeProviders,
} from "@oh-my-pi/pi-ai/private-mode";
import { PrivateSessionError } from "../session/private-session";
import { cfgOffline } from "./auxiliary-model-policy";
import { cfgMemoryBackend } from "../memory-backend/settings";
import { cfgOperatorPrivateProviders } from "./model-settings";
import type { Settings } from "./settings";

/**
 * Make this process private, limited to `private.providers`. Idempotent for the same allowlist;
 * a second call can only narrow it.
 *
 * @throws PrivateSessionError when `private.providers` is empty: a private session that may call
 *   no model could not run, and silently allowing everything would defeat it.
 */
export function activatePrivateMode(settings: Settings): readonly string[] {
	const providers = cfgOperatorPrivateProviders
		.get(settings)
		.filter((provider): provider is string => typeof provider === "string" && provider.trim() !== "")
		.map(provider => provider.trim());
	if (providers.length === 0) {
		throw new PrivateSessionError(
			"Private sessions need `private.providers` in config.yml: list the provider ids a private session may call (for example `private: { providers: [studio-glm] }`).",
		);
	}
	enterPrivateMode(providers);
	// Auxiliary services (judge, Spotlight, memory, live audio, hosted web search, ...) already honor
	// `models.offline`: they stay on the active model's provider, which a private session limits to the allowlist.
	cfgOffline.override(settings, true);
	// Memory backends (local, Hindsight, Mnemopi, Sharpshooter) call models or ship transcripts to a store.
	cfgMemoryBackend.override(settings, "off");
	return privateModeProviders() ?? [];
}

/**
 * A disabled-provider set that also disables every provider a private process does not allow, so
 * model catalogs, availability, role resolution, fallbacks and credential lookup never see a
 * disallowed provider. Only `has` is meaningful: do not iterate it or read `size` (use
 * {@link filtersProviders} to ask whether it filters anything).
 */
class PrivateProviderDenylist extends Set<string> {
	override has(provider: string): boolean {
		return super.has(provider) || !isProviderAllowedInPrivateMode(provider);
	}
}

/**
 * Whether `disabled` removes any provider. A private process's denylist is empty by `size` yet
 * disables every provider off the allowlist, so shortcuts that skip filtering for an empty set must
 * ask this instead of reading `size`.
 */
export function filtersProviders(disabled: ReadonlySet<string>): boolean {
	return disabled.size > 0 || isPrivateModeActive();
}

/** `disabledProviders` as the effective denylist: unchanged outside private mode. */
export function effectiveDisabledProviders(disabled: Iterable<string> | undefined): Set<string> {
	return privateModeProviders() === undefined ? new Set(disabled) : new PrivateProviderDenylist(disabled);
}

/** The refusal for a provider a private session may not use, shared by the CLI and runtime paths. */
export function privateProviderRefusal(provider: string): string {
	const allowed = privateModeProviders() ?? [];
	return `${provider} is not allowed in a private session (private.providers: ${allowed.join(", ") || "none"}).`;
}
