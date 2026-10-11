/** Split command arguments, optionally enforcing complete quotes and shell-style escapes. */
export function parseCommandArgs(argsString: string, options?: { strict?: boolean }): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;
	let started = false;

	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i];
		if (options?.strict && char === "\\" && inQuote !== "'") {
			const next = argsString[i + 1];
			if (next === undefined) throw new Error("Incomplete command escape.");
			if (inQuote === null || next === '"' || next === "\\" || next === "$" || next === "`") {
				current += next;
				started = true;
				i++;
				continue;
			}
		}
		if (inQuote) {
			if (char === inQuote) {
				inQuote = null;
			} else {
				current += char;
			}
		} else if (char === '"' || char === "'") {
			inQuote = char;
			started = true;
		} else if (char === " " || char === "\t") {
			if (current || (options?.strict && started)) {
				args.push(current);
				current = "";
				started = false;
			}
		} else {
			current += char;
			started = true;
		}
	}

	if (options?.strict && inQuote) throw new Error("Unterminated command quote.");
	if (current || (options?.strict && started)) {
		args.push(current);
	}

	return args;
}

/**
 * Substitute argument placeholders in template content
 * Supports $1, $2, ... for positional args, $@ and $ARGUMENTS for all args
 *
 * Note: Replacement happens on the template string only. Argument values
 * containing patterns like $1, $@, or $ARGUMENTS are NOT recursively substituted.
 *
 * `format` renders the values one placeholder selects (none, one, or many) at its offset in
 * `content`; the default joins them with spaces.
 */
export function substituteArgs(
	content: string,
	args: string[],
	format: (values: string[], offset: number) => string = values => values.join(" "),
): string {
	return content.replace(
		/\$@\[(\d+)(?::(\d*)?)?\]|\$ARGUMENTS|\$@|\$(\d+)/g,
		(
			match,
			startRaw: string | undefined,
			lengthRaw: string | undefined,
			positionalNum: string | undefined,
			offset: number,
		) => {
			if (positionalNum !== undefined) {
				const index = Number.parseInt(positionalNum, 10) - 1;
				return format(index >= 0 && index < args.length ? [args[index]] : [], offset);
			}

			if (startRaw !== undefined) {
				const start = Number.parseInt(startRaw, 10);
				if (!Number.isFinite(start) || start < 1) return format([], offset);
				const startIndex = start - 1;
				if (startIndex >= args.length) return format([], offset);

				if (lengthRaw === undefined || lengthRaw === "") {
					return format(args.slice(startIndex), offset);
				}

				const length = Number.parseInt(lengthRaw, 10);
				if (!Number.isFinite(length) || length <= 0) return format([], offset);
				return format(args.slice(startIndex, startIndex + length), offset);
			}

			if (match === "$ARGUMENTS" || match === "$@") {
				return format(args, offset);
			}

			return match;
		},
	);
}
