/** The wire package has no dependencies, so it keeps its own canonical object guard. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
