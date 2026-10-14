/**
 * Preload (`bun --preload`) for the Personal agent's end-to-end runs: the companion and every omp it starts read the same
 * clock offset from `$HOME/.e2e-clock-offset-ms` (a whole number of milliseconds, default 0), so a test moves "now" for all
 * of them at once without waiting. `Date.now()` and `new Date()` are shifted; timers and `performance.now()` are not.
 * The file is re-read at most every 100 ms.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const realNow = Date.now.bind(Date);
const RealDate = Date;
const file = path.join(process.env.HOME ?? "", ".e2e-clock-offset-ms");
let offset = 0;
let readAt = 0;

function currentOffset(): number {
	const t = realNow();
	if (t - readAt >= 100) {
		readAt = t;
		try {
			const value = Number(fs.readFileSync(file, "utf8").trim());
			offset = Number.isFinite(value) ? value : 0;
		} catch {
			offset = 0;
		}
	}
	return offset;
}

class ShiftedDate extends RealDate {
	constructor(...args: unknown[]) {
		if (args.length === 0) super(realNow() + currentOffset());
		else super(...(args as [number]));
	}

	static override now(): number {
		return realNow() + currentOffset();
	}
}

globalThis.Date = ShiftedDate as unknown as DateConstructor;
