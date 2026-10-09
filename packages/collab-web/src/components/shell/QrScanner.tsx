import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { extractLink } from "../../lib/rooms";

/** Frames analysed per second: enough to feel instant without cooking the phone. */
const SCAN_FPS = 8;
/** Longest edge of the frame handed to the JS decoder; QR codes on a terminal stay legible. */
const DECODE_MAX_PX = 720;

type Decoder = (video: HTMLVideoElement) => Promise<string | null>;

interface BarcodeDetectorLike {
	detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
interface BarcodeDetectorCtor {
	new (opts: { formats: string[] }): BarcodeDetectorLike;
	getSupportedFormats(): Promise<string[]>;
}

/**
 * Native `BarcodeDetector` where it decodes QR (Chromium on Android), else the
 * `jsqr` fallback, loaded on demand so the main bundle stays lean (iOS Safari
 * has no detector).
 */
async function createDecoder(): Promise<Decoder> {
	const Native = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
	if (Native && (await Native.getSupportedFormats().catch((): string[] => [])).includes("qr_code")) {
		const detector = new Native({ formats: ["qr_code"] });
		return async video => (await detector.detect(video))[0]?.rawValue ?? null;
	}
	// Deliberately lazy: the decoder is only needed on browsers without a native QR
	// detector, and only once the user opens the scanner. It ships as its own chunk.
	const { default: jsQR } = await import("jsqr");
	const canvas = document.createElement("canvas");
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	if (!ctx) throw new Error("canvas unavailable");
	return async video => {
		const scale = Math.min(1, DECODE_MAX_PX / Math.max(video.videoWidth, video.videoHeight));
		canvas.width = Math.round(video.videoWidth * scale);
		canvas.height = Math.round(video.videoHeight * scale);
		ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
		const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
		return jsQR(image.data, image.width, image.height, { inversionAttempts: "attemptBoth" })?.data ?? null;
	};
}

export interface QrScannerProps {
	onLink(link: string): void;
	onClose(): void;
}

/** Full-screen camera view that resolves the first QR code holding a collab link. */
export function QrScanner({ onLink, onClose }: QrScannerProps): ReactNode {
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [hint, setHint] = useState<string | null>(null);
	// Latest callback without restarting the camera when the parent re-renders.
	const onLinkRef = useRef(onLink);
	onLinkRef.current = onLink;

	useEffect(() => {
		let stream: MediaStream | null = null;
		let timer: Timer | undefined;
		let stopped = false;

		const start = async (): Promise<void> => {
			if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser cannot open the camera.");
			const [media, decode] = await Promise.all([
				navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false }),
				createDecoder(),
			]);
			stream = media;
			const video = videoRef.current;
			if (stopped || !video) {
				// Closed while the permission prompt was up: the cleanup already ran.
				for (const track of media.getTracks()) track.stop();
				return;
			}
			video.srcObject = media;
			await video.play();
			const tick = async (): Promise<void> => {
				if (stopped) return;
				if (video.readyState >= video.HAVE_CURRENT_DATA && video.videoWidth > 0) {
					const text = await decode(video).catch(() => null);
					if (stopped) return;
					if (text !== null) {
						const link = extractLink(text);
						if (link) {
							stopped = true;
							onLinkRef.current(link);
							return;
						}
						setHint("That QR code is not an omp collab link.");
					}
				}
				timer = setTimeout(tick, 1000 / SCAN_FPS);
			};
			void tick();
		};

		start().catch((err: unknown) => {
			if (stopped) return;
			const name = err instanceof DOMException ? err.name : "";
			setError(
				name === "NotAllowedError"
					? "Camera access was denied. Allow it in the browser's site settings, or paste the link instead."
					: err instanceof Error
						? err.message
						: String(err),
			);
		});

		return () => {
			stopped = true;
			clearTimeout(timer);
			for (const track of stream?.getTracks() ?? []) track.stop();
		};
	}, []);

	return createPortal(
		<div className="sh-scan" role="dialog" aria-label="scan join QR code">
			<video ref={videoRef} className="sh-scan-video" playsInline muted />
			<div className="sh-scan-frame" aria-hidden />
			<div className="sh-scan-top">
				<span>Scan the QR code from /collab</span>
				<button type="button" className="sh-btn sh-btn-icon sh-scan-close" onClick={onClose} aria-label="close">
					<X size={18} />
				</button>
			</div>
			{(error ?? hint) && <div className="sh-scan-msg">{error ?? hint}</div>}
		</div>,
		document.body,
	);
}
