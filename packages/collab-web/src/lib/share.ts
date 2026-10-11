/** Getting transcript text out of the page: the clipboard and the system share sheet. */

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
