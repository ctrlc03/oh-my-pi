import { describe } from "bun:test";

/**
 * The Personal agent's end-to-end scenarios start the real companion, real omp sessions in tmux and a scripted model (see
 * `scripts/e2e-personal-harness.ts`). Each starts processes and takes tens of seconds to minutes, so they are left out of the
 * default `bun test`; run them with `bun run e2e:personal` (or `OMP_E2E_PERSONAL=1 bun test test/e2e-personal`).
 */
export const e2eEnabled = process.env.OMP_E2E_PERSONAL === "1";

/** `describe` for an end-to-end scenario: skipped unless `OMP_E2E_PERSONAL=1`. */
export const describeE2e = e2eEnabled ? describe : describe.skip;

/** Per-test timeout of a scenario, ms. */
export const SCENARIO_TIMEOUT_MS = 600_000;

/**
 * Wait real time. The scenarios drive the companion and omp, separate processes with timers of their own (the 3 s hosts poll,
 * the 15 s keep-alive tick), so no fake clock reaches them; use it to let them run, or to show that nothing happens.
 */
export const realTime = (ms: number): Promise<void> => Bun.sleep(ms);
