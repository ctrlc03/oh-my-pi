/** The one type guard this package shares: untrusted JSON (GitHub's listing, settings files, IPC) is checked field by field after it. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
