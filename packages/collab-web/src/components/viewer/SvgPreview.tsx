import type { ReactNode } from "react";
import { useMemo } from "react";
import { useObjectUrl } from "./file-blob";
import { ImageViewer } from "./ImageViewer";

export interface SvgPreviewProps {
	/** The SVG's source: the editor's text, saved or not. */
	text: string;
	name: string;
}

/**
 * An SVG's source drawn as an image. An `<img>` runs no script and loads no outside file, so a hostile SVG is
 * shown, not executed; the app's policy would not let it do more in any case.
 */
export function SvgPreview({ text, name }: SvgPreviewProps): ReactNode {
	const blob = useMemo(() => new Blob([text], { type: "image/svg+xml" }), [text]);
	const url = useObjectUrl(blob);
	if (url === null) return null;
	return <ImageViewer url={url} name={name} bytes={blob.size} vector />;
}
