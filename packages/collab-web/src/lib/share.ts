/** Getting transcript text out of the page: the clipboard and the system share sheet. */

import { type SaveResult, saveBlob, shouldShare } from "./download";

/** Put `text` on the clipboard; false when the browser refuses (insecure origin, permission). */
export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}

/**
 * Hand `text` to the system share sheet, or copy it where there is none. Dismissing the sheet is a
 * choice, not a failure; any other sheet failure falls back to the clipboard. The result says what
 * reached the reader, so a caller can confirm a copy.
 */
export async function shareText(title: string, text: string): Promise<"shared" | "copied" | "failed"> {
	if (typeof navigator.share !== "function") return (await copyText(text)) ? "copied" : "failed";
	try {
		await navigator.share({ title, text });
		return "shared";
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") return "shared";
		return (await copyText(text)) ? "copied" : "failed";
	}
}

/**
 * Hand a Markdown document to the person: as a file where the share sheet saves it (phones, tablets), as text elsewhere
 * (Chrome on macOS says it can share a Markdown file, then refuses with NotAllowedError), and as a download when the share
 * is refused or there is no share sheet. Dismissing the sheet is a choice, not a failure.
 */
export async function shareMarkdown(title: string, text: string, filename: string): Promise<SaveResult> {
	const blob = new Blob([text], { type: "text/markdown" });
	if (typeof navigator.share !== "function") return saveBlob(blob, filename);
	const file = new File([blob], filename, { type: "text/markdown" });
	try {
		await navigator.share(shouldShare(navigator, file) ? { title, files: [file] } : { title, text });
		return "shared";
	} catch (err) {
		if (err instanceof DOMException && err.name === "AbortError") return "cancelled";
		return saveBlob(blob, filename);
	}
}
