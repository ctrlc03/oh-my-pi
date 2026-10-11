/** A drawing's scene as SVG for the transcript figure and viewer. Loaded on demand (see diagram-svg.ts): it carries the scene validator. */

import type { DiagramSvg } from "./diagram-svg";
import { messageOf } from "./diagram-svg";
import { loadExcalidraw } from "./excalidraw-load";
import { parseScene } from "./excalidraw-scene";
import { isSafeSvg } from "./svg";
import type { SystemTheme } from "./theme";

export async function renderExcalidraw(source: string, theme: SystemTheme): Promise<DiagramSvg> {
	const parsed = parseScene(source);
	if (!parsed.ok) return { ok: false, error: parsed.error };
	const engine = await loadExcalidraw();
	try {
		const { elements, files } = engine.loadScene(parsed.scene);
		const root = await engine.exportToSvg({
			elements,
			appState: { exportBackground: false, exportWithDarkMode: theme === "dark", exportPadding: 16 },
			files,
		});
		// Excalidraw's dark export inverts the whole drawing, which turns pastel fills into saturated slabs.
		if (theme === "dark") root.setAttribute("filter", `${root.getAttribute("filter") ?? ""} saturate(0.6)`.trim());
		const svg = new XMLSerializer().serializeToString(root);
		return isSafeSvg(svg) ? { ok: true, svg } : { ok: false, error: "the drawing contained unsafe markup" };
	} catch (error) {
		return { ok: false, error: messageOf(error) };
	}
}
