/**
 * Private sessions on the companion's side: which starts launch `omp --private` and what the `hosts` frame advertises. The
 * enforcement lives in omp itself (see docs/private-sessions.md); the companion only passes the flag and lists the result.
 */

/** The `hosts` frame's private field: starting a private session needs the same tmux launch every start uses, so it follows `canStart`. */
export function privateHostsFields(canStart: boolean): { canPrivate: boolean } {
	return { canPrivate: canStart };
}

/**
 * Whether a start launches omp with `--private`. Only a new omp session can be made private: a vendor agent's model calls go to
 * its vendor, and a resumed session keeps the privacy its header recorded, so the flag is never passed on a resume.
 */
export function launchesPrivate(request: { private?: boolean; foreign: boolean; resume?: string }): boolean {
	return request.private === true && !request.foreign && request.resume === undefined;
}
