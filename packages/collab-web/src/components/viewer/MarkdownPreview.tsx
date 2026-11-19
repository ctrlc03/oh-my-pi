import type { ReactNode } from "react";
import { useCallback, useEffect, useRef } from "react";
import type { CompanionClient } from "../../lib/companion";
import { imageMime, MAX_IMAGE_BYTES, resolveRelativeLink, viewerKind } from "../../lib/file-viewer";
import type { ResolveImage } from "../transcript/Markdown";
import { Markdown } from "../transcript/Markdown";
import { loadFileBlob } from "./file-blob";
import "./viewer.css";

export interface MarkdownPreviewProps {
	/** The Markdown to render: the editor's text, saved or not. */
	text: string;
	/** The Markdown file's path in the form `toRequest` takes: what its relative links are resolved against. */
	file: string;
	client: CompanionClient;
	instanceId: string;
	/** The path the companion is sent for a file the links resolve to (`file` and the result are of one form). */
	toRequest(resolved: string): string;
}

/**
 * Rendered Markdown, by the transcript's own renderer (code highlighting, math, Mermaid and Excalidraw fences). An
 * image the file names relatively is read from the computer through the same file loading as the image viewer, so
 * `![logo](docs/logo.png)` shows the file beside the Markdown; a link that leaves the tree, names a file that is not an
 * image, or is too large stays as its alt text.
 * The caller keys it by the file: another file has other relative links and starts with no images loaded.
 */
export function MarkdownPreview({ text, file, client, instanceId, toRequest }: MarkdownPreviewProps): ReactNode {
	// Object URLs made for this preview, by link: an edit re-renders the Markdown but must not fetch every image again.
	const urls = useRef(new Map<string, Promise<string | null>>());
	useEffect(() => {
		const made = urls.current;
		return () => {
			for (const pending of made.values())
				void pending.then(url => (url === null ? undefined : URL.revokeObjectURL(url)));
			made.clear();
		};
	}, []);

	const resolveImage = useCallback<ResolveImage>(
		href => {
			const known = urls.current.get(href);
			if (known !== undefined) return known;
			const loading = (async (): Promise<string | null> => {
				const resolved = resolveRelativeLink(file, href);
				if (resolved === null || viewerKind(resolved) !== "image") return null;
				const request = toRequest(resolved);
				const meta = await client.requestFile(instanceId, request);
				if (meta.size > MAX_IMAGE_BYTES) return null;
				const blob = await loadFileBlob({
					client,
					instanceId,
					path: request,
					version: meta.version,
					limit: MAX_IMAGE_BYTES,
					mime: imageMime(resolved) ?? undefined,
				});
				return URL.createObjectURL(blob);
			})().catch(() => null);
			urls.current.set(href, loading);
			return loading;
		},
		[client, instanceId, file, toRequest],
	);

	return (
		<div className="sh-md-preview">
			<Markdown text={text} resolveImage={resolveImage} />
		</div>
	);
}
