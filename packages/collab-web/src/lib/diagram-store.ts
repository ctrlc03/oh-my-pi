/**
 * Opening the diagram viewer, the canvas and the sketch pad from anywhere (a transcript figure, the
 * composer, the code map, a file path in a tool card). Requests stack like sheets do (the canvas opened from
 * the viewer sits over it, and closing it shows the viewer again); the `DiagramHost` mounted by the app
 * renders them, so callers need no props or context to reach it.
 */

import { useSyncExternalStore } from "react";
import type { SkeletonElement } from "./codemap-scene";
import type { DiagramKind } from "./diagrams";
import type { Scene } from "./excalidraw-scene";

/** What a canvas opens with. */
export type CanvasSource =
	| { kind: "blank" }
	| { kind: "scene"; scene: Scene }
	/** A Mermaid diagram, converted to editable shapes when the converter is available. */
	| { kind: "mermaid"; source: string }
	/** Excalidraw's shorthand elements (the code map's graphs), expanded by the canvas. */
	| { kind: "skeleton"; elements: readonly SkeletonElement[] };

export type DiagramRequest =
	/** The full-screen viewer of a rendered diagram. */
	| { t: "view"; kind: DiagramKind; source: string }
	/** The canvas, to edit `source` or to sketch (`blank`). `name` titles the sheet and names the attachments. */
	| { t: "canvas"; title: string; name: string; source: CanvasSource }
	/** A diagram file of the session's repository, read and (for writers) saved through the paired computer. */
	| { t: "file"; path: string };

/** An open request with an identity of its own, so React keeps a sheet's state while others open and close above it. */
export interface OpenDiagram {
	id: number;
	request: DiagramRequest;
}

let lastId = 0;
let stack: readonly OpenDiagram[] = [];
const listeners = new Set<() => void>();

function set(next: readonly OpenDiagram[]): void {
	stack = next;
	for (const listener of listeners) listener();
}

function push(request: DiagramRequest): void {
	set([...stack, { id: ++lastId, request }]);
}

export function openDiagram(kind: DiagramKind, source: string): void {
	push({ t: "view", kind, source });
}

/** A blank canvas whose Done attaches the drawing to the message. */
export function openSketch(): void {
	push({ t: "canvas", title: "Sketch", name: "sketch", source: { kind: "blank" } });
}

export function openCanvas(title: string, name: string, source: CanvasSource): void {
	push({ t: "canvas", title, name, source });
}

export function openDiagramFile(path: string): void {
	push({ t: "file", path });
}

/** Close the top request. */
export function closeDiagram(): void {
	if (stack.length > 0) set(stack.slice(0, -1));
}

/** Close every request (after the drawing was sent to the agent). */
export function closeAllDiagrams(): void {
	if (stack.length > 0) set([]);
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** The open requests, bottom first; the same array until something changes. */
export function useDiagramStack(): readonly OpenDiagram[] {
	return useSyncExternalStore(subscribe, () => stack);
}
