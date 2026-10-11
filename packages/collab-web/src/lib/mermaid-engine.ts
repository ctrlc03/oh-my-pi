/**
 * Mermaid itself. Imported only through `import("./mermaid-engine")` (see mermaid.ts): the library is
 * several megabytes and must stay out of the entry bundle until a diagram is on screen.
 */

import mermaid from "mermaid";

let counter = 0;
/** Mermaid keeps one global configuration and renders into scratch elements: one render at a time. */
let chain: Promise<unknown> = Promise.resolve();

/**
 * Render `source` to SVG text with the given theme variables. `securityLevel: "strict"` encodes the labels
 * and disables click handlers and scripts, and it is in Mermaid's `secure` list, so a `%%{init}%%` directive
 * inside the (agent-written) source cannot loosen it. Labels are plain SVG text rather than HTML in a
 * `foreignObject`, which browsers refuse to rasterise into a PNG.
 * @throws the parser's error for source that is not a diagram.
 */
export function renderMermaidSvg(source: string, variables: Record<string, string | boolean>): Promise<string> {
	const run = chain.then(async () => {
		mermaid.initialize({
			startOnLoad: false,
			securityLevel: "strict",
			theme: "base",
			themeVariables: variables,
			suppressErrorRendering: true,
			htmlLabels: false,
			flowchart: { htmlLabels: false },
		});
		await mermaid.parse(source);
		const { svg } = await mermaid.render(`omp-mermaid-${++counter}`, source);
		return svg;
	});
	chain = run.catch(() => {});
	return run;
}
