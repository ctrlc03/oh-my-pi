/**
 * Prompt image attachments: photos, screenshots, and pasted images become
 * `ImageContent` blocks on the guest `prompt` frame, which the host forwards to
 * the model as-is.
 *
 * Phone photos are 3–8 MB and far larger than a model looks at, so anything
 * over {@link MAX_EDGE_PX} or {@link PASSTHROUGH_BYTES} is redrawn and
 * re-encoded as JPEG. That keeps a frame of {@link MAX_ATTACHMENTS} images
 * around a megabyte, well inside what the relay carries.
 */

import type { ImageContent } from "@oh-my-pi/pi-wire";

export const MAX_ATTACHMENTS = 4;
/** Longest edge sent; Anthropic downsamples anything larger anyway. */
const MAX_EDGE_PX = 1568;
/** Images at or under this size (and edge) are sent byte-for-byte. */
const PASSTHROUGH_BYTES = 750_000;
const PASSTHROUGH_TYPES: Record<string, true> = {
	"image/png": true,
	"image/jpeg": true,
	"image/gif": true,
	"image/webp": true,
};
const JPEG_QUALITY = 0.85;

/** Base64 of `blob`'s bytes (no `data:` prefix). Goes through `FileReader`, not `btoa(String.fromCharCode(...bytes))`, which overflows the stack on large buffers. */
export function blobToBase64(blob: Blob): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const reader = new FileReader();
	reader.onload = () => {
		const url = String(reader.result);
		resolve(url.slice(url.indexOf(",") + 1));
	};
	reader.onerror = () => reject(reader.error ?? new Error("could not read the file"));
	reader.readAsDataURL(blob);
	return promise;
}

/** Decode (EXIF orientation applied), downscale if needed, and base64 one image. */
export async function toImageContent(file: Blob): Promise<ImageContent> {
	const bitmap = await createImageBitmap(file);
	try {
		const scale = Math.min(1, MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height));
		if (scale === 1 && file.size <= PASSTHROUGH_BYTES && PASSTHROUGH_TYPES[file.type]) {
			return { type: "image", mimeType: file.type, data: await blobToBase64(file) };
		}
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(bitmap.width * scale));
		canvas.height = Math.max(1, Math.round(bitmap.height * scale));
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("canvas is unavailable");
		// JPEG has no alpha: transparent screenshots would otherwise turn black.
		ctx.fillStyle = "#fff";
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		const { promise, resolve } = Promise.withResolvers<Blob | null>();
		canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY);
		const jpeg = await promise;
		if (!jpeg) throw new Error("could not encode the image");
		return { type: "image", mimeType: "image/jpeg", data: await blobToBase64(jpeg) };
	} finally {
		bitmap.close();
	}
}
