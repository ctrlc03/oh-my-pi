/**
 * What the window may do. The page is the collab web app served by the companion on loopback, and nothing else is
 * ever loaded into the window: other origins open in the system browser, and every permission the page asks for is
 * refused unless the app needs it and the request comes from the app's own origin.
 */

/** Permissions the web app uses: notifications, the clipboard (pasting a pairing link, copying text), and the microphone and camera (voice input, scanning a pairing code). */
const GRANTED: Record<string, true> = {
	notifications: true,
	"clipboard-read": true,
	"clipboard-sanitized-write": true,
	media: true,
};

/** `media` is for the microphone and the camera only; a request for the screen is refused. */
function mediaAllowed(mediaTypes: readonly string[] | undefined): boolean {
	return (
		mediaTypes !== undefined &&
		mediaTypes.length > 0 &&
		mediaTypes.every(type => type === "audio" || type === "video")
	);
}

export function permissionAllowed(
	permission: string,
	requestingUrl: string,
	origin: string,
	mediaTypes?: readonly string[],
): boolean {
	if (!Object.hasOwn(GRANTED, permission) || !isAppUrl(requestingUrl, origin)) return false;
	return permission === "media" ? mediaAllowed(mediaTypes) : true;
}

/** `url` belongs to the app: same origin as the companion's loopback address. */
export function isAppUrl(url: string, origin: string): boolean {
	try {
		return new URL(url).origin === origin;
	} catch {
		return false;
	}
}

/** The URL to hand to the system browser for a link the page tried to open, or null for anything that is not a plain web or mail link. */
export function externalUrl(url: string): string | null {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" || parsed.protocol === "http:" || parsed.protocol === "mailto:"
			? parsed.href
			: null;
	} catch {
		return null;
	}
}

/** Whether an IPC message comes from the app's page: its own origin, in the window's top frame. */
export function trustedSender(senderUrl: string, isMainFrame: boolean, origin: string): boolean {
	return isMainFrame && isAppUrl(senderUrl, origin);
}
