/** `glob` (legacy `find`) — glob-based file finder; results are paths sorted by mtime. */
import type { ReactNode } from "react";
import { Badge, Badges, InvalidArg, Note, PathText, ResultText, Row } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, num, resultTextOf, scopePaths, shortenPath, str, truncate } from "../util";

/** Most matched paths listed as buttons; the rest are summarized as "… N more". */
const MAX_OPEN_ROWS = 40;

function Summary({ args }: ToolRenderProps): ReactNode {
	const raw = args.path ?? args.paths;
	if (raw !== undefined && typeof raw !== "string" && !Array.isArray(raw)) return <InvalidArg what="path" />;
	const globs = scopePaths(args).map(shortenPath).join(", ");
	return <span className="tv-pattern">{truncate(globs || "*", 120)}</span>;
}

function Body({ args, result, host }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const limit = num(args.limit);
	const timeout = num(args.timeout);
	const fileCount = num(details?.fileCount);
	const resultLimit = num(details?.resultLimitReached);
	const scopePath = str(details?.scopePath);
	const error = str(details?.error);
	const meta = details && isRecord(details.meta) ? details.meta : null;
	const limits = meta && isRecord(meta.limits) ? meta.limits : null;
	const truncated =
		Boolean(details?.truncated) ||
		resultLimit !== null ||
		(details !== null && isRecord(details.truncation)) ||
		(meta !== null && isRecord(meta.truncation)) ||
		Boolean(limits?.resultLimit);
	const missing = Array.isArray(details?.missingPaths)
		? details.missingPaths.filter((p): p is string => typeof p === "string")
		: [];

	// One matched path per line; directories (trailing `/`) are not files to open.
	const files = resultTextOf(result)
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0 && !line.endsWith("/"));
	return (
		<>
			<Badges
				items={[
					limit !== null && <Badge>limit {limit}</Badge>,
					args.gitignore === false && <Badge>no-gitignore</Badge>,
					args.hidden === false && <Badge>no-hidden</Badge>,
					timeout !== null && <Badge>timeout {timeout}s</Badge>,
					fileCount !== null && (
						<Badge tone="accent">
							{fileCount} file{fileCount === 1 ? "" : "s"}
						</Badge>
					),
					scopePath !== null && <Badge>in {shortenPath(scopePath)}</Badge>,
					truncated && (
						<Badge tone="warn">{resultLimit !== null ? `truncated at ${resultLimit}` : "truncated"}</Badge>
					),
				]}
			/>
			{missing.length > 0 && <Note tone="warn">skipped missing: {missing.map(shortenPath).join(", ")}</Note>}
			{error !== null && !result?.isError && <Note tone="err">{error}</Note>}
			{host?.openFile !== undefined &&
			result?.isError !== true &&
			(fileCount === null || fileCount > 0) &&
			files.length > 0 ? (
				<div className="tv-list">
					{files.slice(0, MAX_OPEN_ROWS).map(file => (
						<Row key={file}>
							<PathText path={file} host={host} />
						</Row>
					))}
					{files.length > MAX_OPEN_ROWS && (
						<Row>
							<span className="tv-faint">… {files.length - MAX_OPEN_ROWS} more</span>
						</Row>
					)}
				</div>
			) : (
				<ResultText result={result} maxLines={12} />
			)}
		</>
	);
}

export const globRenderer: ToolRenderer = { Summary, Body };
