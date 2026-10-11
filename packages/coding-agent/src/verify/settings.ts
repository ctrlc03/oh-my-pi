import { register } from "../config/registry";

export const VERIFY_WHEN_VALUES = ["turn-end", "after-edit"] as const;

// Config-file-only: verification is configured per repository, not toggled from the settings panel.
export const cfgVerifyCommand = register({
	id: "verify.command",
	type: "array",
	scalar: true,
	default: [] as string[],
});

export const cfgVerifyWhen = register({
	id: "verify.when",
	type: "enum",
	values: VERIFY_WHEN_VALUES,
	default: "turn-end",
});

export const cfgVerifyPaths = register({
	id: "verify.paths",
	type: "array",
	scalar: true,
	default: [] as string[],
});

export const cfgVerifyTimeoutMs = register({
	id: "verify.timeoutMs",
	type: "number",
	default: 120_000,
});

export const cfgVerifyMaxOutputChars = register({
	id: "verify.maxOutputChars",
	type: "number",
	default: 6000,
});

export const cfgVerifyMaxAttempts = register({
	id: "verify.maxAttempts",
	type: "number",
	default: 3,
});
