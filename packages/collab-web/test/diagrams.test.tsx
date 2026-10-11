import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DiagramFigureView } from "../src/components/diagram/DiagramFigure";
import { Markdown, StreamingMarkdown } from "../src/components/transcript/Markdown";
import {
	diagramFileKind,
	diagramKindOf,
	isClosedFence,
	MAX_EXCALIDRAW_CHARS,
	MAX_MERMAID_CHARS,
} from "../src/lib/diagrams";

const SCENE = '{"type":"excalidraw","version":2,"elements":[]}';

describe("diagramKindOf", () => {
	it("recognises diagram fences by language", () => {
		expect(diagramKindOf("mermaid", "flowchart LR\nA-->B")).toBe("mermaid");
		expect(diagramKindOf("MMD", "graph TD")).toBe("mermaid");
		expect(diagramKindOf("excalidraw", SCENE)).toBe("excalidraw");
	});

	it("takes a json fence only when it is an Excalidraw scene", () => {
		expect(diagramKindOf("json", SCENE)).toBe("excalidraw");
		expect(diagramKindOf("", SCENE)).toBe("excalidraw");
		expect(diagramKindOf("json", '{"name":"x"}')).toBeNull();
		expect(diagramKindOf("ts", SCENE)).toBeNull();
	});

	it("leaves ordinary code and prototype names alone", () => {
		expect(diagramKindOf("js", "const a = 1")).toBeNull();
		expect(diagramKindOf("constructor", "x")).toBeNull();
		expect(diagramKindOf("__proto__", "x")).toBeNull();
	});

	it("keeps oversized sources as code blocks", () => {
		expect(diagramKindOf("mermaid", "a".repeat(MAX_MERMAID_CHARS + 1))).toBeNull();
		expect(diagramKindOf("excalidraw", "a".repeat(MAX_EXCALIDRAW_CHARS + 1))).toBeNull();
	});
});

describe("isClosedFence", () => {
	it("is true once the closing fence is written", () => {
		expect(isClosedFence("```mermaid\ngraph TD\n```")).toBe(true);
		expect(isClosedFence("```mermaid\ngraph TD\n```\n")).toBe(true);
		expect(isClosedFence("~~~mermaid\ngraph TD\n~~~")).toBe(true);
	});

	it("is false while the fence is still open", () => {
		expect(isClosedFence("```mermaid\ngraph TD")).toBe(false);
		expect(isClosedFence("```mermaid")).toBe(false);
		expect(isClosedFence("````mermaid\ngraph TD\n```")).toBe(false);
	});
});

describe("diagramFileKind", () => {
	it("names the diagram files by extension", () => {
		expect(diagramFileKind("docs/flow.excalidraw")).toBe("excalidraw");
		expect(diagramFileKind("docs/flow.MMD")).toBe("mermaid");
		expect(diagramFileKind("a.b/flow.mermaid")).toBe("mermaid");
		expect(diagramFileKind("src/app.ts")).toBeNull();
		expect(diagramFileKind("excalidraw")).toBeNull();
		expect(diagramFileKind(".excalidraw")).toBeNull();
	});
});

describe("Markdown diagram fences", () => {
	it("marks a closed mermaid fence as a diagram and keeps its code as the fallback", () => {
		const html = renderToStaticMarkup(<Markdown text={"```mermaid\nflowchart LR\n  A --> B\n```"} />);
		expect(html).toContain('data-diagram="mermaid"');
		expect(html).toContain("tr-diagram");
		expect(html).toContain("flowchart LR");
	});

	it("marks an excalidraw fence and a json scene fence", () => {
		expect(renderToStaticMarkup(<Markdown text={`\`\`\`excalidraw\n${SCENE}\n\`\`\``} />)).toContain(
			'data-diagram="excalidraw"',
		);
		expect(renderToStaticMarkup(<Markdown text={`\`\`\`json\n${SCENE}\n\`\`\``} />)).toContain(
			'data-diagram="excalidraw"',
		);
	});

	it("does not mark ordinary code or a plain json fence", () => {
		expect(renderToStaticMarkup(<Markdown text={"```js\nconst a = 1\n```"} />)).not.toContain("data-diagram");
		expect(renderToStaticMarkup(<Markdown text={'```json\n{"a":1}\n```'} />)).not.toContain("data-diagram");
	});

	it("does not mark a fence the reply has not closed yet", () => {
		const html = renderToStaticMarkup(<Markdown text={"```mermaid\nflowchart LR\n  A --"} />);
		expect(html).not.toContain("data-diagram");
		expect(html).toContain("flowchart LR");
	});

	it("marks diagrams in streaming markdown too", () => {
		const html = renderToStaticMarkup(
			<StreamingMarkdown text={"intro\n\n```mermaid\ngraph TD\n  A-->B\n```\n\nmore"} />,
		);
		expect(html).toContain('data-diagram="mermaid"');
	});
});

describe("DiagramFigureView", () => {
	const noop = (): void => {};
	const view = (state: Parameters<typeof DiagramFigureView>[0]["state"], showSource = false): string =>
		renderToStaticMarkup(
			<DiagramFigureView
				kind="mermaid"
				source={"graph TD\n  A-->"}
				state={state}
				showSource={showSource}
				onToggleSource={noop}
				onOpen={noop}
				onRetry={noop}
			/>,
		);

	it("falls back to the source with a note when the diagram cannot be rendered", () => {
		const html = view({ status: "error", message: "Parse error on line 2" });
		expect(html).toContain("graph TD");
		expect(html).toContain("Could not render this Mermaid diagram: Parse error on line 2");
		expect(html).not.toContain("tr-diagram-svg");
	});

	it("offers a retry when the renderer itself could not be loaded", () => {
		const html = view({ status: "unavailable", message: "offline" });
		expect(html).toContain("The Mermaid renderer could not be loaded: offline");
		expect(html).toContain("Retry");
	});

	it("shows the rendering, with a source toggle and an open action, once ready", () => {
		const html = view({ status: "ready", svg: "<svg viewBox='0 0 10 10'></svg>" });
		expect(html).toContain("tr-diagram-svg");
		expect(html).toContain("Source");
		expect(html).toContain("Open");
		expect(html).not.toContain("language-mermaid");
	});

	it("shows the source instead of the rendering when toggled", () => {
		const html = view({ status: "ready", svg: "<svg viewBox='0 0 10 10'></svg>" }, true);
		expect(html).toContain("language-mermaid");
		expect(html).not.toContain("tr-diagram-svg");
	});
});
