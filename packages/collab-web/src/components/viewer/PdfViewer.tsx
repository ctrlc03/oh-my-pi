import { ChevronLeft, ChevronRight, LoaderCircle, Maximize, Minus, Plus } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
	clampPage,
	clampPdfZoom,
	parsePageInput,
	pdfFitWidthZoom,
	pdfOpenMessage,
	stepPdfZoom,
} from "../../lib/file-viewer";
import { importChunk } from "../../lib/stale-build";
import type * as PdfEngineModule from "./pdf-engine";
import type { PDFDocumentProxy, PDFPageProxy } from "./pdf-engine";
import "./viewer.css";

type PdfEngine = typeof PdfEngineModule;

let engine: Promise<PdfEngine> | undefined;

/** PDF.js, fetched on first use and shared after that; a failed fetch is retried next time. */
function loadEngine(): Promise<PdfEngine> {
	engine ??= importChunk(() => import("./pdf-engine")).catch((error: unknown) => {
		engine = undefined;
		throw error;
	});
	return engine;
}

/** Most pixels a page's canvas may have: iOS Safari refuses larger canvases (about 16.7 million). */
const MAX_CANVAS_PIXELS = 16_000_000;

type Document =
	| { status: "loading" }
	| { status: "ready"; pdf: PDFDocumentProxy }
	| { status: "error"; message: string };

interface PageInfo {
	page: PDFPageProxy;
	/** The page's size in PDF points (a point is 1/72 inch: a CSS pixel at zoom 1). */
	width: number;
	height: number;
}

export interface PdfViewerProps {
	/** The PDF's bytes. */
	blob: Blob;
	name: string;
}

/**
 * A PDF one page at a time: previous and next, a page number field, zoom (buttons, Ctrl/Cmd and the wheel, or fit to
 * the width, the default). Pages are drawn onto a canvas with PDF.js (`pdf-engine.ts`); there is no text layer, so the
 * text is not selectable, and links and form fields are not live.
 */
export function PdfViewer({ blob, name }: PdfViewerProps): ReactNode {
	const [doc, setDoc] = useState<Document>({ status: "loading" });
	const [page, setPage] = useState(1);
	const [pageInfo, setPageInfo] = useState<PageInfo | null>(null);
	// "fit": the page fills the viewer's width. A number: the user's zoom.
	const [zoomMode, setZoomMode] = useState<"fit" | number>("fit");
	const [stageWidth, setStageWidth] = useState(0);
	const [pageField, setPageField] = useState<string | null>(null);
	const stage = useRef<HTMLDivElement>(null);
	const canvasHost = useRef<HTMLDivElement>(null);

	// Open the document; a new blob (the file changed on disk) replaces it, a closed viewer destroys it.
	useEffect(() => {
		let live = true;
		let opened: PDFDocumentProxy | null = null;
		setDoc({ status: "loading" });
		// A page of the previous document is destroyed with it and must not be drawn for the new one.
		setPageInfo(null);
		void (async () => {
			try {
				const pdfEngine = await loadEngine();
				// PDF.js takes the buffer over: a copy per document, the blob stays whole for the next open.
				const bytes = new Uint8Array(await blob.arrayBuffer());
				const pdf = await pdfEngine.openPdf(bytes);
				if (!live) {
					void pdf.destroy();
					return;
				}
				opened = pdf;
				setDoc({ status: "ready", pdf });
				setPage(current => clampPage(current, pdf.numPages));
			} catch (err) {
				if (live) setDoc({ status: "error", message: pdfOpenMessage(err) });
			}
		})();
		return () => {
			live = false;
			void opened?.destroy();
		};
	}, [blob]);

	const pdf = doc.status === "ready" ? doc.pdf : null;
	const total = pdf?.numPages ?? 0;

	// The page's size, needed before it can be fitted to the width.
	useEffect(() => {
		if (pdf === null) return;
		let live = true;
		void pdf.getPage(page).then(
			loaded => {
				if (!live) return;
				const size = loaded.getViewport({ scale: 1 });
				setPageInfo({ page: loaded, width: size.width, height: size.height });
			},
			(err: unknown) => {
				if (live) setDoc({ status: "error", message: `Could not read page ${page}: ${String(err)}` });
			},
		);
		return () => {
			live = false;
		};
	}, [pdf, page]);

	useLayoutEffect(() => {
		const node = stage.current;
		if (node === null) return;
		const read = (): void => setStageWidth(node.clientWidth);
		read();
		const observer = new ResizeObserver(read);
		observer.observe(node);
		return () => observer.disconnect();
	}, [doc.status]);

	const zoom =
		zoomMode === "fit" ? (pageInfo === null ? 1 : pdfFitWidthZoom(pageInfo.width, stageWidth)) : zoomMode;

	// Draw the page onto a canvas of its own and swap it in when done: the page in view stays until the next is ready.
	useEffect(() => {
		const host = canvasHost.current;
		if (pdf === null || pageInfo === null || host === null || pageInfo.page.pageNumber !== page) return;
		let live = true;
		const canvas = document.createElement("canvas");
		const ratio = window.devicePixelRatio || 1;
		const cssSize = pageInfo.page.getViewport({ scale: zoom });
		const sharp = Math.min(ratio, Math.sqrt(MAX_CANVAS_PIXELS / (cssSize.width * cssSize.height)));
		const viewport = pageInfo.page.getViewport({ scale: zoom * sharp });
		canvas.width = Math.floor(viewport.width);
		canvas.height = Math.floor(viewport.height);
		canvas.style.width = `${Math.floor(cssSize.width)}px`;
		canvas.style.height = `${Math.floor(cssSize.height)}px`;
		canvas.className = "sh-pdf-canvas";
		const task = pageInfo.page.render({ canvas, viewport });
		void task.promise.then(
			() => {
				if (live) host.replaceChildren(canvas);
			},
			(err: unknown) => {
				// A render the next one replaced is not a failure.
				if (live && !(err instanceof Error && err.name === "RenderingCancelledException"))
					setDoc({ status: "error", message: `Could not draw page ${page}: ${String(err)}` });
			},
		);
		return () => {
			live = false;
			task.cancel();
		};
	}, [pdf, pageInfo, page, zoom]);

	// A new page starts at its top.
	useEffect(() => {
		stage.current?.scrollTo({ top: 0, left: 0 });
	}, [page]);

	const goTo = useCallback(
		(next: number) => {
			if (pdf !== null) setPage(clampPage(next, pdf.numPages));
		},
		[pdf],
	);

	// A wheel listener must be non-passive to stop the page scrolling under a zoom; React's is passive.
	const zoomRef = useRef(zoom);
	zoomRef.current = zoom;
	useEffect(() => {
		const node = stage.current;
		if (node === null) return;
		const onWheel = (e: WheelEvent): void => {
			if (!e.ctrlKey && !e.metaKey) return;
			e.preventDefault();
			setZoomMode(clampPdfZoom(zoomRef.current * Math.exp(-Math.max(-120, Math.min(120, e.deltaY)) * 0.0025)));
		};
		node.addEventListener("wheel", onWheel, { passive: false });
		return () => node.removeEventListener("wheel", onWheel);
	}, [doc.status]);

	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
		if (e.target instanceof HTMLInputElement) return;
		if (e.key === "PageDown") goTo(page + 1);
		else if (e.key === "PageUp") goTo(page - 1);
		else if (e.key === "Home") goTo(1);
		else if (e.key === "End") goTo(total);
		else if (e.key === "+" || e.key === "=") setZoomMode(stepPdfZoom(zoom, 1));
		else if (e.key === "-") setZoomMode(stepPdfZoom(zoom, -1));
		else if (e.key === "0") setZoomMode("fit");
		else return;
		e.preventDefault();
	};

	if (doc.status === "error") return <div className="sh-connect-error">{doc.message}</div>;
	return (
		<div className="sh-pdf" aria-label={`PDF: ${name}`}>
			<div className="sh-view-bar" role="toolbar" aria-label="PDF controls">
				<button
					type="button"
					className="sh-btn sh-btn-icon"
					onClick={() => goTo(page - 1)}
					disabled={pdf === null || page <= 1}
					aria-label="Previous page"
					title="Previous page (Page Up)"
				>
					<ChevronLeft size={16} />
				</button>
				<span className="sh-pdf-pages">
					<input
						className="sh-input sh-pdf-page-input"
						inputMode="numeric"
						value={pageField ?? String(page)}
						disabled={pdf === null}
						aria-label="Page number"
						onFocus={e => e.currentTarget.select()}
						onChange={e => setPageField(e.target.value)}
						onBlur={() => setPageField(null)}
						onKeyDown={e => {
							if (e.key === "Enter") {
								const next = parsePageInput(e.currentTarget.value, total);
								if (next !== null) goTo(next);
								setPageField(null);
								e.currentTarget.blur();
							} else if (e.key === "Escape") {
								e.stopPropagation();
								setPageField(null);
								e.currentTarget.blur();
							}
						}}
					/>
					<span className="sh-view-dim">of {total}</span>
				</span>
				<button
					type="button"
					className="sh-btn sh-btn-icon"
					onClick={() => goTo(page + 1)}
					disabled={pdf === null || page >= total}
					aria-label="Next page"
					title="Next page (Page Down)"
				>
					<ChevronRight size={16} />
				</button>
				<span className="sh-view-sep" aria-hidden />
				<button
					type="button"
					className="sh-btn sh-btn-icon"
					onClick={() => setZoomMode(stepPdfZoom(zoom, -1))}
					disabled={pdf === null}
					aria-label="Zoom out"
					title="Zoom out (-)"
				>
					<Minus size={15} />
				</button>
				<span className="sh-view-dim sh-view-zoom">{Math.round(zoom * 100)}%</span>
				<button
					type="button"
					className="sh-btn sh-btn-icon"
					onClick={() => setZoomMode(stepPdfZoom(zoom, 1))}
					disabled={pdf === null}
					aria-label="Zoom in"
					title="Zoom in (+)"
				>
					<Plus size={15} />
				</button>
				<button
					type="button"
					className={zoomMode === "fit" ? "sh-btn sh-btn-icon sh-btn-on" : "sh-btn sh-btn-icon"}
					onClick={() => setZoomMode("fit")}
					disabled={pdf === null}
					aria-label="Fit to width"
					aria-pressed={zoomMode === "fit"}
					title="Fit to width (0)"
				>
					<Maximize size={15} />
				</button>
			</div>
			<div ref={stage} className="sh-pdf-stage" tabIndex={0} role="document" onKeyDown={onKeyDown}>
				{doc.status === "loading" && (
					<div className="sh-companion-empty sh-file-status">
						<LoaderCircle size={14} className="sh-spin" /> Opening the PDF…
					</div>
				)}
				<div ref={canvasHost} className="sh-pdf-page" />
			</div>
		</div>
	);
}
