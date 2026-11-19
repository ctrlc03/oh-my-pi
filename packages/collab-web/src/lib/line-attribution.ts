/**
 * Line attribution: which lines of a file an agent wrote, answered by the companion (`file-attribution`, feature
 * `canAttribution`) and shown as a gutter marker in the editor and the diffs. The companion works it out from the
 * sessions that ran in the file's worktree (see `scripts/companion-attribution.ts`); this holds the answer's shape,
 * the hover text, and the hook the diff views use.
 */
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { useEffect, useMemo, useState } from "react";
import type { CompanionClient } from "./companion";
import { useEditorLayout } from "./editor-layout";
import { relTime } from "./format";
import type { HunkNote } from "./review-board";
import { promptTurns } from "./turn-changes";

/** The turn that wrote some lines. */
export interface AttributionRef {
	sessionId: string;
	/** The session's title; null when it has none. */
	sessionTitle: string | null;
	/** 1-based prompt turn; 0 for an edit before the first prompt. */
	turn: number;
	/** The turn's prompt, whitespace collapsed and cut to its first words; empty when it has no text. */
	prompt: string;
	/** The model that made the edit; null when the session does not say. */
	model: string | null;
	/** Epoch ms of the latest edit of the turn that wrote lines of this file; 0 when unknown. */
	at: number;
}

/** A run of lines (1-based, inclusive) one turn wrote that the file still has as written. */
export interface AttributionRange {
	start: number;
	end: number;
	/** Index into {@link FileAttribution.refs}. */
	ref: number;
}

export interface FileAttribution {
	/** The file's path as the companion resolved it, relative to its repository. */
	path: string;
	/** Version of the file's text the lines are numbered in (what `file` answers); null when the file could not be read as text. */
	version: string | null;
	refs: AttributionRef[];
	ranges: AttributionRange[];
}

/** One marked line of an editor: the hover text is the line's turn's. */
export interface LineMark {
	line: number;
	tip: string;
}

/** The hover text of a line a turn wrote: session, turn and its prompt, model and when. */
export function attributionTip(ref: AttributionRef): string {
	const lines = [
		"Written by an agent",
		`${ref.sessionTitle ?? "Untitled session"}${ref.turn > 0 ? ` · turn ${ref.turn}` : ""}`,
	];
	if (ref.prompt !== "") lines.push(`“${ref.prompt}”`);
	const when =
		ref.at > 0
			? `${relTime(ref.at)} (${new Date(ref.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })})`
			: null;
	const how = [ref.model, when].filter((part): part is string => part !== null && part !== "");
	if (how.length > 0) lines.push(how.join(" · "));
	return lines.join("\n");
}

/** Every attributed line with its hover text, ascending by line. */
export function attributionMarks(attribution: FileAttribution): LineMark[] {
	const tips = attribution.refs.map(attributionTip);
	const marks: LineMark[] = [];
	for (const range of attribution.ranges) {
		const tip = tips[range.ref];
		if (tip === undefined) continue;
		for (let line = range.start; line <= range.end; line++) marks.push({ line, tip });
	}
	return marks.sort((a, b) => a.line - b.line);
}

/** The hover text of a new-file line, or null when no agent wrote it. */
export type AgentLines = (line: number) => string | null;

/** {@link AgentLines} over one file's attribution. */
export function agentLinesOf(attribution: FileAttribution): AgentLines {
	const byLine = new Map<number, string>();
	for (const mark of attributionMarks(attribution)) byLine.set(mark.line, mark.tip);
	return line => byLine.get(line) ?? null;
}

/**
 * The agent lines of `path` in the session's worktree, for a diff's added rows; null while loading, when the
 * companion cannot tell, or when the editor layout's _Agent-written lines_ toggle is off. A failed request leaves the
 * diff as it was: attribution is decoration, never a reason to show an error.
 */
export function useAgentLines(client: CompanionClient | null, instanceId: string | null, path: string): AgentLines | null {
	const { attribution } = useEditorLayout();
	const [found, setFound] = useState<FileAttribution | null>(null);
	useEffect(() => {
		if (!attribution || client === null || instanceId === null || !client.getSnapshot().canAttribution) {
			setFound(null);
			return;
		}
		let stale = false;
		client.requestAttribution(instanceId, path).then(
			value => {
				if (!stale) setFound(value);
			},
			() => {
				if (!stale) setFound(null);
			},
		);
		return () => {
			stale = true;
		};
	}, [attribution, client, instanceId, path]);
	return useMemo(() => (found === null ? null : agentLinesOf(found)), [found]);
}

/**
 * What a session's turn wrote, as an {@link AttributionRef}: the prompt's first words, the model of the first reply
 * and when it was asked. Null when `entryId` is not a prompt of `entries`.
 */
export function turnRef(
	entries: readonly SessionEntry[],
	entryId: string,
	sessionId: string,
	sessionTitle: string | null,
): AttributionRef | null {
	const turn = promptTurns(entries).find(candidate => candidate.id === entryId);
	if (turn === undefined) return null;
	const start = entries.findIndex(entry => entry.id === entryId);
	let model: string | null = null;
	for (const entry of entries.slice(start + 1)) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			model = entry.message.model;
			break;
		}
		if (entry.type === "message" && entry.message.role === "user") break;
	}
	const at = Date.parse(entries[start]!.timestamp);
	return {
		sessionId,
		sessionTitle,
		turn: turn.turn,
		prompt: turn.label,
		model,
		at: Number.isNaN(at) ? 0 : at,
	};
}

/** The hover text for the lines of a hunk a session's note says it wrote; null for a note no session wrote. */
export function noteTip(note: HunkNote): string | null {
	if (note.source !== "session" || note.sessionId === undefined) return null;
	return attributionTip({
		sessionId: note.sessionId,
		sessionTitle: note.sessionTitle ?? null,
		turn: note.turn ?? 0,
		prompt: note.intent ?? "",
		model: null,
		at: note.at ?? 0,
	});
}
