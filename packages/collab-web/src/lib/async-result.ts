/**
 * `async-result` custom messages carry a finished background job's full output
 * (task reports, bash logs) for the model. The transcript shows one status line
 * per job instead, like the terminal UI does; the body stays reachable on demand.
 */

export const ASYNC_RESULT_TYPE = "async-result";

export interface AsyncResultJob {
	id: string;
	type: string | null;
	label: string | null;
	durationMs: number | null;
}

function str(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function toJob(value: unknown): AsyncResultJob | null {
	if (value === null || typeof value !== "object") return null;
	const job = value as Record<string, unknown>;
	const duration = job.durationMs;
	return {
		id: str(job.jobId) ?? "job",
		type: str(job.type),
		label: str(job.label),
		durationMs: typeof duration === "number" && Number.isFinite(duration) && duration >= 0 ? duration : null,
	};
}

/** Jobs reported by an `async-result` message: a batch (`jobs`) or one job inline. */
export function asyncResultJobs(details: unknown): AsyncResultJob[] {
	if (details === null || typeof details !== "object") return [];
	const record = details as Record<string, unknown>;
	if (Array.isArray(record.jobs) && record.jobs.length > 0) {
		return record.jobs.map(toJob).filter((job): job is AsyncResultJob => job !== null);
	}
	const single = toJob(record);
	return single && Object.hasOwn(record, "jobId") ? [single] : [];
}
