/**
 * Files for the mock project's image and PDF viewers (see ./mock-repo-intel), made in code so the repository carries
 * no binary fixtures: a PNG with transparent corners (the viewer's checkerboard shows through them), a three-page
 * PDF, and an SVG.
 */
import * as zlib from "node:zlib";

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Uint8Array): Uint8Array {
	const body = new Uint8Array(4 + data.length);
	body.set(new TextEncoder().encode(type), 0);
	body.set(data, 4);
	const chunk = new Uint8Array(4 + body.length + 4);
	const view = new DataView(chunk.buffer);
	view.setUint32(0, data.length);
	chunk.set(body, 4);
	view.setUint32(4 + body.length, Bun.hash.crc32(body));
	return chunk;
}

/**
 * A `width` x `height` RGBA PNG: a disc with a diagonal colour gradient and a soft edge, fully transparent outside it,
 * so the corners show the viewer's checkerboard.
 */
export function pngFixture(width = 320, height = 200): Uint8Array {
	const raw = new Uint8Array((width * 4 + 1) * height);
	const radius = Math.min(width, height) / 2 - 6;
	for (let y = 0; y < height; y++) {
		const row = y * (width * 4 + 1);
		// Filter type 0: the row's bytes are stored as they are.
		raw[row] = 0;
		for (let x = 0; x < width; x++) {
			const distance = Math.hypot(x - width / 2, y - height / 2);
			const edge = Math.max(0, Math.min(1, radius - distance));
			const at = row + 1 + x * 4;
			raw[at] = Math.round(244 - (x / width) * 150);
			raw[at + 1] = Math.round(114 + (y / height) * 60);
			raw[at + 2] = Math.round(192 + (x / width) * 50);
			raw[at + 3] = Math.round(edge * 255);
		}
	}
	const header = new Uint8Array(13);
	const view = new DataView(header.buffer);
	view.setUint32(0, width);
	view.setUint32(4, height);
	// Bit depth 8, colour type 6 (RGBA), the one compression and filter method, no interlacing.
	header.set([8, 6, 0, 0, 0], 8);
	const parts = [
		PNG_SIGNATURE,
		pngChunk("IHDR", header),
		pngChunk("IDAT", zlib.deflateSync(raw)),
		pngChunk("IEND", new Uint8Array(0)),
	];
	const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		png.set(part, offset);
		offset += part.length;
	}
	return png;
}

/** One line of text on a PDF page: `size` points at (`x`, `y`) measured from the page's bottom left. */
export interface PdfLine {
	text: string;
	x: number;
	y: number;
	size: number;
}

function pdfText(text: string): string {
	return text.replace(/[\\()]/g, char => `\\${char}`);
}

/**
 * A PDF of Letter-size pages, each a title, a few lines, and a box, in the standard Helvetica font (every viewer has
 * it, so the file needs no embedded font). Object offsets are exact, so the cross-reference table is valid.
 */
export function pdfFixture(pages: readonly (readonly PdfLine[])[]): Uint8Array {
	const objects: string[] = [];
	// 1 is the catalog, 2 the page tree, 3 the font; each page is a page object then its content stream.
	const first = 4;
	const kids = pages.map((_, i) => `${first + i * 2} 0 R`).join(" ");
	objects.push(
		"<< /Type /Catalog /Pages 2 0 R >>",
		`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	);
	for (const [index, lines] of pages.entries()) {
		const content = [
			"0.96 0.45 0.75 RG 2 w 48 48 516 696 re S",
			...lines.map(
				line =>
					`BT /F1 ${line.size} Tf ${line.x} ${line.y} Td (${pdfText(line.text)}) Tj ET`,
			),
			`BT /F1 10 Tf 280 24 Td (Page ${index + 1} of ${pages.length}) Tj ET`,
		].join("\n");
		objects.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${first + index * 2 + 1} 0 R >>`,
			`<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
		);
	}
	let pdf = "%PDF-1.4\n";
	const offsets: number[] = [];
	for (const [i, body] of objects.entries()) {
		offsets.push(pdf.length);
		pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
	}
	const xref = pdf.length;
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(pdf);
}

/** The mock project's handbook: three short pages. */
export function handbookPdf(): Uint8Array {
	return pdfFixture([
		[
			{ text: "mock-service handbook", x: 72, y: 690, size: 28 },
			{ text: "A PDF drawn by the editor's viewer, one page at a time.", x: 72, y: 650, size: 14 },
			{ text: "Use the arrows or Page Up and Page Down to turn pages.", x: 72, y: 626, size: 14 },
		],
		[
			{ text: "Sessions", x: 72, y: 690, size: 24 },
			{ text: "Cookies are signed and last thirty minutes.", x: 72, y: 650, size: 14 },
			{ text: "See src/auth/session.ts for the rules.", x: 72, y: 626, size: 14 },
		],
		[
			{ text: "Zoom", x: 72, y: 690, size: 24 },
			{ text: "Fit to width is the default; the buttons and Ctrl + wheel zoom.", x: 72, y: 650, size: 14 },
		],
	]);
}

/** A vector logo with the transparency a checkerboard would show. */
export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 120" width="240" height="120">
  <title>mock-service logo</title>
  <rect x="8" y="8" width="224" height="104" rx="16" fill="#f472c0" fill-opacity="0.85"/>
  <circle cx="60" cy="60" r="28" fill="#fff"/>
  <text x="104" y="68" font-family="Helvetica, Arial, sans-serif" font-size="26" fill="#2a1825">mock-service</text>
</svg>
`;
