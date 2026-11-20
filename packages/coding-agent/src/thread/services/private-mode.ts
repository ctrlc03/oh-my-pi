/**
 * Private-mode egress policy across subagent worker links. A worker is a fresh realm with its own
 * pi-ai module state, so without this hand-off its model requests would run unguarded: main's
 * allowlist crosses in the boot globals and the worker enters private mode before any other
 * service boots.
 */
import { enterPrivateMode, privateModeProviders } from "@oh-my-pi/pi-ai/private-mode";
import type { ThreadService } from "../services";

/** Boot globals of {@link privateModeThreadService}. */
export interface PrivateModeGlobals {
	/** Main's private allowlist, or `undefined` when main is not private. */
	readonly providers: readonly string[] | undefined;
}

/** {@link privateModeThreadService} with its two hooks declared concretely, so they can be called without a link. */
export interface PrivateModeThreadService extends ThreadService {
	globals(): PrivateModeGlobals;
	boot(globals: unknown): void;
}

/** Hands main's private-mode allowlist to each worker; see the module doc. */
export const privateModeThreadService: PrivateModeThreadService = {
	name: "private-mode",

	globals(): PrivateModeGlobals {
		return { providers: privateModeProviders() };
	},

	boot(globals: unknown): void {
		const providers: unknown =
			typeof globals === "object" && globals !== null ? Reflect.get(globals, "providers") : undefined;
		if (providers === undefined) return;
		if (!Array.isArray(providers) || !providers.every(provider => typeof provider === "string")) {
			throw new Error("private mode service: malformed boot globals");
		}
		enterPrivateMode(providers);
	},
};
