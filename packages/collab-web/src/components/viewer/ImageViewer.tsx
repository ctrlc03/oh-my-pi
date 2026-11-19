import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { fmtBytes } from "../../lib/format";
import type { Size } from "../../lib/pan-zoom";
import { PanZoom } from "../diagram/PanZoom";
import "../diagram/diagram.css";
import "./viewer.css";

/** What a browser draws a vector image at when it has no size of its own. */
const SVG_FALLBACK: Size = { width: 300, height: 150 };

export interface ImageViewerProps {
	/** Where the browser reads the image from: an object URL of its bytes. */
	url: string;
	name: string;
	/** Size of the file in bytes, for the info line. */
	bytes: number;
	/** The image is an SVG: drawn as an image (so its scripts never run), and said to be vector. */
	vector?: boolean;
}

interface Decoded {
	size: Size;
	/** The size is the image's own, not the fallback for a vector image that has none. */
	intrinsic: boolean;
}

/**
 * An image on a checkerboard (so transparency shows), fitted to the viewer and never blown up past 100%. Drag to pan,
 * the wheel or a pinch to zoom, double-click or the fit button to fit it, the 1:1 button for its pixels. The
 * info line gives the pixel size and the file's bytes.
 */
export function ImageViewer({ url, name, bytes, vector }: ImageViewerProps): ReactNode {
	const [decoded, setDecoded] = useState<Decoded | null>(null);
	const [failed, setFailed] = useState(false);

	// The image is decoded once, off screen, for its pixel size: the pan/zoom surface needs the size to place it.
	// The size of the previous image stays until the next is decoded, and a new image of the same size keeps the
	// same object, so an SVG redrawn as it is edited does not send the view back to the fit.
	useEffect(() => {
		setFailed(false);
		const probe = new Image();
		let live = true;
		probe.onload = () => {
			if (!live) return;
			const { naturalWidth: width, naturalHeight: height } = probe;
			const next: Decoded =
				width > 0 && height > 0
					? { size: { width, height }, intrinsic: true }
					: { size: SVG_FALLBACK, intrinsic: false };
			setDecoded(prev =>
				prev !== null &&
				prev.intrinsic === next.intrinsic &&
				prev.size.width === next.size.width &&
				prev.size.height === next.size.height
					? prev
					: next,
			);
		};
		probe.onerror = () => {
			if (live) setFailed(true);
		};
		probe.src = url;
		return () => {
			live = false;
			probe.onload = null;
			probe.onerror = null;
		};
	}, [url]);

	if (failed) return <div className="sh-connect-error">This image could not be decoded.</div>;
	return (
		<div className="sh-view">
			<div className="sh-view-bar sh-view-info">
				{decoded === null ? (
					<span className="sh-view-dim">
						<LoaderCircle size={13} className="sh-spin" /> Decoding…
					</span>
				) : (
					<>
						<span title="Pixel size">
							{decoded.intrinsic ? `${decoded.size.width} × ${decoded.size.height} px` : "no fixed size"}
						</span>
						<span className="sh-view-dim">{fmtBytes(bytes)}</span>
						{vector === true && <span className="sh-view-dim">vector</span>}
					</>
				)}
			</div>
			{decoded !== null && (
				<PanZoom
					size={decoded.size}
					readableScale={0}
					maxFit={1}
					showZoom
					label={`Image ${name}: drag to pan, scroll or pinch to zoom`}
				>
					<img
						className="sh-view-img"
						src={url}
						alt={name}
						width={decoded.size.width}
						height={decoded.size.height}
						draggable={false}
					/>
				</PanZoom>
			)}
		</div>
	);
}
