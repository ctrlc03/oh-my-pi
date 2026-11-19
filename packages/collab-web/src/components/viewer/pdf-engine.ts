/**
 * PDF.js, loaded only when a PDF is first opened (see `PdfViewer`): this module is its own lazy chunk, so neither the
 * app's entry bundle nor phones that never open a PDF carry it.
 *
 * Why PDF.js and not the browser's own viewer: the local app's Content-Security-Policy (scripts/local-app.ts) has
 * `default-src 'none'` and `object-src 'none'` with no `frame-src`, so a PDF in an `<iframe>` or `<object>`, the only
 * way to reach a built-in viewer, is blocked. The Electron desktop app loads the same page from the same local server
 * under the same policy, and a bare webview gives no guarantee of a PDF plugin either.
 * PDF.js needs only what the policy already allows: a module worker from a `blob:` URL (`worker-src 'self' blob:`)
 * and a canvas. The worker's source is bundled into this chunk as text and started from a Blob, so there is no
 * extra file for the build, the service worker or the release binary to carry. Nothing evals (`isEvalSupported` is
 * off, so `script-src` needs no `unsafe-eval`) and nothing is fetched at run time (`useWasm` is off, which leaves JPEG 2000
 * images to PDF.js's JavaScript decoder, and the bytes come from the caller, not a URL).
 *
 * The legacy build is used for the browsers (older Safari, the desktop webview) that lack the language features the
 * modern build assumes.
 */
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerSource from "pdfjs-dist/legacy/build/pdf.worker.min.mjs" with { type: "text" };

export type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";

let workerUrl: string | undefined;

function startWorkerSource(): void {
	workerUrl ??= URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
	pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
}

/**
 * Open a PDF from its bytes. `bytes` is handed to the worker and left empty: pass a copy you do not need again.
 * @throws when the bytes are not a PDF or it needs a password (`pdfOpenMessage` words either).
 */
export async function openPdf(bytes: Uint8Array<ArrayBuffer>): Promise<PDFDocumentProxy> {
	startWorkerSource();
	const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false, useWasm: false });
	return await task.promise;
}
