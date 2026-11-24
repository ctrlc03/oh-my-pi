/**
 * Wraps a periodic job so a run that is still waiting never starts another. A job whose work reads session folders can
 * wait arbitrarily long — on macOS, the first access to a protected folder (Documents, Desktop, Downloads, iCloud,
 * removable and network volumes) blocks until the user answers a privacy prompt — and polling every folder on each
 * timer tick would pile one waiting read behind another. The tick's arguments are those of the run in flight when the
 * timer fires; the newest listing is the one worth acting on, so the arguments of the skipped call are dropped and the
 * next successful run sees fresh state. A run that throws is *not* treated as finished for the purposes of the next
 * fire until it has settled, and the error reaches the caller's `await`.
 */
export function skipWhileRunning<Args extends readonly unknown[]>(
	work: (...args: Args) => Promise<void>,
): (...args: Args) => Promise<void> {
	let running: Promise<void> | undefined;
	return async (...args: Args): Promise<void> => {
		if (running !== undefined) return;
		running = work(...args).finally(() => {
			running = undefined;
		});
		await running;
	};
}
