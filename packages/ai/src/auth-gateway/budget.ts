/**
 * Daily budgets for scoped auth-gateway clients.
 *
 * A client's usage is totalled per UTC day in an {@link AuthGatewayUsageLedger},
 * keyed by the client's name. Enforcement happens before a request, so the
 * request that crosses a limit is still served and a later one is refused.
 * Usage is added when a request ends, so requests in flight together can
 * overshoot too; a client's in-flight requests are capped (`maxConcurrent`) to
 * bound that.
 */

/** Tokens (input + output + cache read + cache write) and cost accumulated by one client on one day. */
export interface AuthGatewayUsageTotals {
	tokens: number;
	costUsd: number;
}

/**
 * Where a gateway keeps each client's running totals. Calls are synchronous so
 * a request's check and its later record never await storage; a file-backed
 * implementation loads and flushes on its own schedule.
 */
export interface AuthGatewayUsageLedger {
	/** Totals for `client` on `day` (`YYYY-MM-DD`, UTC); zeros when it has none. */
	read(client: string, day: string): AuthGatewayUsageTotals;
	/** Add `delta` to `client`'s totals for `day`. */
	add(client: string, day: string, delta: AuthGatewayUsageTotals): void;
}

/** A ledger held in process memory: totals reset when the process restarts. */
export function createMemoryUsageLedger(): AuthGatewayUsageLedger {
	const totals = new Map<string, Map<string, AuthGatewayUsageTotals>>();
	return {
		read(client, day) {
			const current = totals.get(client)?.get(day);
			return { tokens: current?.tokens ?? 0, costUsd: current?.costUsd ?? 0 };
		},
		add(client, day, delta) {
			let days = totals.get(client);
			if (!days) {
				days = new Map();
				totals.set(client, days);
			}
			const current = days.get(day);
			if (current) {
				current.tokens += delta.tokens;
				current.costUsd += delta.costUsd;
			} else {
				days.set(day, { tokens: delta.tokens, costUsd: delta.costUsd });
			}
		},
	};
}

/** The UTC calendar day of `ms` (epoch milliseconds) as `YYYY-MM-DD`. */
export function utcDay(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

/** In-flight inference requests a budgeted client may have at once unless its budget sets `maxConcurrent`. */
export const DEFAULT_MAX_CONCURRENT = 16;

/** Counts a router's in-flight requests per client, so a budget's overshoot stays bounded. */
export interface AuthGatewayInflightGate {
	/**
	 * Take a slot for `client`, or `undefined` when it already has `limit`
	 * requests in flight. Call the returned release once the request is over;
	 * calling it again does nothing.
	 */
	acquire(client: string, limit: number): (() => void) | undefined;
}

/** A gate over process memory, one per router. */
export function createInflightGate(): AuthGatewayInflightGate {
	const inflight = new Map<string, number>();
	return {
		acquire(client, limit) {
			const count = inflight.get(client) ?? 0;
			if (count >= limit) return undefined;
			inflight.set(client, count + 1);
			let held = true;
			return () => {
				if (!held) return;
				held = false;
				const remaining = (inflight.get(client) ?? 1) - 1;
				if (remaining > 0) inflight.set(client, remaining);
				else inflight.delete(client);
			};
		},
	};
}
