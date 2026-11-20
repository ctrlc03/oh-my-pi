/**
 * Private-session adoption rules shared by every path that loads or forks a transcript.
 *
 * A session is private when its header says so (`private: true`); the process is private once it
 * has entered private mode (`@oh-my-pi/pi-ai/private-mode`). The two must agree: a private process
 * refuses non-private transcripts, and a private transcript is only opened by a process that is, or
 * at startup becomes, private. See `docs/private-sessions.md`.
 */
import { isPrivateModeActive } from "@oh-my-pi/pi-ai/private-mode";

/** A session cannot be opened, forked, or switched to because of its privacy. */
export class PrivateSessionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PrivateSessionError";
	}
}

let adopt: (() => void) | undefined;

/**
 * Run `body` with startup adoption on: opening a private transcript in a process that is not yet
 * private enters private mode (`activate`) instead of failing. Only the launch path uses this; a
 * session switched to at runtime never turns a normal process private.
 */
export async function withPrivateSessionAdoption<T>(activate: () => void, body: () => Promise<T>): Promise<T> {
	adopt = activate;
	try {
		return await body();
	} finally {
		adopt = undefined;
	}
}

/**
 * Check that a transcript whose header says `sessionIsPrivate` may be loaded or forked here.
 * Throws {@link PrivateSessionError} before anything is mutated or written.
 */
export function assertSessionPrivacyCompatible(sessionIsPrivate: boolean): void {
	const processIsPrivate = isPrivateModeActive();
	if (processIsPrivate && !sessionIsPrivate) {
		throw new PrivateSessionError(
			"This process is private and cannot open a session that is not private: only a new session can be made private; a forked private session stays private.",
		);
	}
	if (!processIsPrivate && sessionIsPrivate) {
		if (adopt === undefined) {
			throw new PrivateSessionError(
				"That session is private. Open it from a new process with `omp --resume <id>`; a normal session cannot switch to a private one.",
			);
		}
		adopt();
	}
}
