/**
 * What the sparring screens decide, with no React: how the form turns into a request, which point comes next and where a
 * reload resumes, how a point ended in plain words, the summary and its Markdown copy, and the rows of the list.
 */

import type { BlueprintRef } from "@oh-my-pi/pi-wire/blueprint";
import type { QuizStackPr } from "@oh-my-pi/pi-wire/quiz";
import {
	SPAR_DESIGN_PATH,
	SPAR_MAX_DOC_CHARS,
	SPAR_MAX_ROUNDS,
	type Spar,
	type SparCreate,
	type SparKind,
	type SparMove,
	type SparOutcomeKind,
	type SparPoint,
	type SparRecord,
	type SparRun,
	type SparSummary,
} from "@oh-my-pi/pi-wire/spar";
import { parseLimit, plainText, type QuizSubject } from "../quiz/quiz-flow";

/** What the new-spar form is about: a change as in the quiz form, or a design document alone. */
export type SparSubject = QuizSubject | { kind: "doc" };

/** The design document of the form: pasted text, or a file of the repository. */
export type SparDocInput = { source: "paste"; name: string; text: string } | { source: "file"; path: string };

/** What the sparring screens open on (the quiz sheet's `start`, for the entries that lead here). */
export type SparStart =
	| { view: "spar-home" }
	| { view: "spar-new"; subject: SparSubject; doc?: SparDocInput }
	| { view: "spar"; computerId: string; id: string };

/** What the form starts on, and where it runs. */
export interface SparTarget {
	/** The computer that holds the repository (and the session, for a spar about its changes). */
	computerId: string;
	/** Any folder of the repository on that computer. */
	cwd: string;
	/** The omp session whose conversation may be read to ask why; null when none is at hand. */
	sessionId: string | null;
	subject: SparSubject;
	/** A document to start with: a file of the repository ("Spar with this design"). */
	doc?: SparDocInput;
}

export interface SparFormValues {
	/** Any folder of the repository. */
	cwd: string;
	subject: SparSubject;
	/** The session whose conversation may be read; null: none to offer. */
	sessionId: string | null;
	/** The checkbox "Include why it was done". */
	useConversation: boolean;
	/** Pull requests of the stack in order, as the form lists them; empty: not looked up or none found. */
	stack: readonly QuizStackPr[];
	/** The radio: the whole stack, or only the pull request the form is about. */
	scope: "stack" | "single";
	/** The design document, when one is given (alone, or attached to a change). */
	doc: SparDocInput | null;
	/** The cost-limit field as typed. */
	limit: string;
	/** The model of the points as typed; empty: the companion's default. */
	model: string;
	/** The model of the replies as typed; empty: the default model. */
	replyModel: string;
}

/** The request the form's values make, or what is wrong with them. */
export function buildSparCreate(values: SparFormValues): { request: SparCreate } | { error: string } {
	const maxCostUsd = parseLimit(values.limit);
	if (values.cwd === "") return { error: "There is no repository to spar about." };
	if (maxCostUsd === null) return { error: "The cost limit must be more than $0." };
	const request: SparCreate = { cwd: values.cwd, maxCostUsd };
	const model = values.model.trim();
	if (model !== "") request.model = model;
	const replyModel = values.replyModel.trim();
	if (replyModel !== "") request.replyModel = replyModel;

	const { subject } = values;
	if (subject.kind === "doc" && values.doc === null) return { error: "Add the design: paste it or name a file." };
	if (values.doc !== null) {
		if (values.doc.source === "file") {
			const path = values.doc.path.trim();
			if (path === "") return { error: "Name the file of the design." };
			request.doc = { path };
		} else {
			const text = values.doc.text.trim();
			if (text === "") return { error: "The design is empty." };
			if (text.length > SPAR_MAX_DOC_CHARS)
				return { error: `The design is longer than ${SPAR_MAX_DOC_CHARS.toLocaleString("en-US")} characters.` };
			const name = values.doc.name.trim();
			request.doc = { text, ...(name === "" ? {} : { name }) };
		}
	}

	if (subject.kind === "changes") {
		request.ref = "@worktree";
		request.base = "@default";
		if (values.useConversation && values.sessionId !== null) request.sessionId = values.sessionId;
	} else if (subject.kind === "branch") {
		const name = subject.name.trim();
		if (name === "") return { error: "Pick a branch." };
		request.ref = name;
		request.base = "@default";
	} else if (subject.kind === "pr") {
		if (values.scope === "stack" && values.stack.length > 1) request.stack = values.stack.map(pr => pr.number);
		else request.pr = subject.number;
	} else if (values.useConversation && values.sessionId !== null) {
		// A design alone, written in a session: the conversation says why.
		request.sessionId = values.sessionId;
	}
	return { request };
}

/** The subject to offer for another spar like `spar`: its pull request (any one of a stack finds the rest), else its design, else the changes. */
export function subjectOf(spar: Spar): SparSubject {
	const part = spar.parts.find(item => item.pr !== undefined);
	if (part?.pr !== undefined) return { kind: "pr", number: part.pr.number, title: part.title };
	return spar.parts.every(item => item.base === undefined) ? { kind: "doc" } : { kind: "changes" };
}

// ── points and records ───────────────────────────────────────────────────────

/** The record of a point in a run; an empty one when it has none yet. */
export function recordOf(run: SparRun, id: string): SparRecord {
	return Object.hasOwn(run.records, id) ? run.records[id]! : { turns: [] };
}

/** The points a run asks, in its order. Ids the spar does not have are skipped. */
export function runPoints(spar: Spar, run: SparRun): SparPoint[] {
	const byId = new Map(spar.points.map(point => [point.id, point]));
	return run.points.flatMap(id => {
		const point = byId.get(id);
		return point === undefined ? [] : [point];
	});
}

/** Times you have answered the point (each is one round). */
export function roundsUsed(record: SparRecord): number {
	return record.turns.filter(turn => turn.by === "you").length;
}

/** Defences left on a point; 0 once it is closed. */
export function roundsLeft(record: SparRecord): number {
	return record.outcome === undefined ? Math.max(0, SPAR_MAX_ROUNDS - roundsUsed(record)) : 0;
}

/** Index of the first point of `points` the run has not closed; -1 when all are closed. */
export function firstOpen(points: readonly SparPoint[], run: SparRun): number {
	return points.findIndex(point => recordOf(run, point.id).outcome === undefined);
}

/** The point to go to after `from` is closed: the next open one after it, else the first open one; null when all are closed. */
export function nextPoint(points: readonly SparPoint[], run: SparRun, from: string): SparPoint | null {
	const at = points.findIndex(point => point.id === from);
	const after = points.slice(at + 1).find(point => recordOf(run, point.id).outcome === undefined);
	if (after !== undefined) return after;
	const first = firstOpen(points, run);
	return first === -1 ? null : points[first]!;
}

/** The run to open on: the latest by start time (ties: the later in the list). */
export function latestRun(runs: readonly SparRun[]): SparRun | undefined {
	let latest: SparRun | undefined;
	for (const run of runs) if (latest === undefined || run.startedAt >= latest.startedAt) latest = run;
	return latest;
}

/** Where opening a spar lands: the first open point of the latest run (so a reload keeps your place), else the summary. */
export type Landing = { kind: "point"; run: string; point: string } | { kind: "summary"; run: string };

export function landingOf(spar: Spar, runs: readonly SparRun[]): Landing | null {
	const run = latestRun(runs);
	if (run === undefined) return null;
	const points = runPoints(spar, run);
	const next = firstOpen(points, run);
	if (run.finishedAt !== undefined || next === -1) return { kind: "summary", run: run.id };
	return { kind: "point", run: run.id, point: points[next]!.id };
}

/** "Point k of m" for `points[at]`. */
export function positionLabel(points: readonly SparPoint[], at: number): string {
	return `Point ${at + 1} of ${points.length}`;
}

/** Whether a defence can be sent: it has text, within the limit. */
export function canSendDefence(text: string, maxChars: number): boolean {
	const trimmed = text.trim();
	return trimmed !== "" && trimmed.length <= maxChars;
}

// ── how things are said ──────────────────────────────────────────────────────

export interface OutcomeLook {
	label: string;
	/** Colour class suffix; the icon and the label carry the meaning too. */
	tone: "held" | "partly" | "lost" | "open";
}

export function outcomeLook(kind: SparOutcomeKind): OutcomeLook {
	switch (kind) {
		case "held":
			return { label: "Held", tone: "held" };
		case "partly":
			return { label: "Partly held", tone: "partly" };
		case "lost":
			return { label: "Conceded", tone: "lost" };
		case "open":
			return { label: "Open", tone: "open" };
	}
}

/** How a point ended, in plain words. */
export function outcomeText(outcome: NonNullable<SparRecord["outcome"]>): string {
	switch (outcome.kind) {
		case "held":
			return "The partner conceded: your defence stands.";
		case "partly":
			return "Some of it stands. The rest is an open risk.";
		case "lost":
			return "You conceded the point.";
		case "open":
			return outcome.by === "limit"
				? "The rounds ran out with the objection still standing."
				: "You accepted the risk or skipped it.";
	}
}

export function moveLabel(move: SparMove): string {
	switch (move) {
		case "concede":
			return "Concedes";
		case "partly":
			return "Partly";
		case "push":
			return "Pushes back";
	}
}

const KIND_LABELS: Record<SparKind, string> = {
	alternative: "Alternative",
	failure: "Failure",
	cost: "Cost",
	assumption: "Assumption",
	migration: "Migration",
};

export function kindLabel(kind: SparKind): string {
	return KIND_LABELS[kind];
}

export function severityLabel(severity: SparPoint["severity"]): string {
	return severity === 3 ? "Would block a merge" : severity === 2 ? "Worth fixing" : "Minor";
}

/** A few words for the share held. */
export function heldBand(percent: number): string {
	if (percent >= 90) return "Your decisions held up";
	if (percent >= 60) return "Most of it held, with a few soft spots";
	if (percent >= 30) return "Some of it held";
	return "Worth another look at these decisions";
}

/** `path:line`, or `design:line` for the document. */
export function refLabel(ref: BlueprintRef): string {
	return `${ref.path === SPAR_DESIGN_PATH ? "design" : ref.path}:${ref.line}`;
}

// ── the summary ──────────────────────────────────────────────────────────────

export interface SummaryItem {
	point: SparPoint;
	record: SparRecord;
}

export interface SparSummaryModel {
	/** Points the partner conceded. */
	held: SummaryItem[];
	/** Partly held (the residual objection stands) and open (round limit, risk accepted, skipped). */
	open: SummaryItem[];
	/** Lost and partly held points: the changes the partner suggests. Only those with a suggestion. */
	suggested: SummaryItem[];
	/** Points the run asks that are not closed yet. */
	unfinished: SummaryItem[];
	asked: number;
	percentHeld: number;
	band: string;
	/** Points `Spar again` would ask: every one not held. */
	unsettled: number;
}

/** The summary screen's lists, from the run's records and the result the companion computed. */
export function summaryOf(spar: Spar, run: SparRun): SparSummaryModel {
	const items = runPoints(spar, run).map(point => ({ point, record: recordOf(run, point.id) }));
	const held = items.filter(item => item.record.outcome?.kind === "held");
	const open = items.filter(item => item.record.outcome?.kind === "partly" || item.record.outcome?.kind === "open");
	const suggested = items.filter(
		item =>
			(item.record.outcome?.kind === "lost" || item.record.outcome?.kind === "partly") &&
			item.record.reveal?.suggestion !== undefined,
	);
	return {
		held,
		open,
		suggested,
		unfinished: items.filter(item => item.record.outcome === undefined),
		asked: items.length,
		percentHeld: run.result.percentHeld,
		band: heldBand(run.result.percentHeld),
		unsettled: items.length - held.length,
	};
}

function oneLine(markdown: string, max: number): string {
	const text = plainText(markdown);
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The first paragraph of a point's challenge: the objection in brief. */
export function objectionOf(point: SparPoint): string {
	const paragraphs = point.challenge.split(/\n\s*\n/).map(part => part.trim());
	return oneLine(paragraphs[paragraphs.length > 1 ? 1 : 0] ?? point.challenge, 400);
}

/** The summary as a Markdown document, for copying or sharing: a heading per list, each item with its objection, how it ended and `path:line` references. */
export function sparMarkdown(spar: Spar, run: SparRun): string {
	const model = summaryOf(spar, run);
	const out = [`# Sparring: ${spar.title}`, ""];
	out.push(
		`Held ${model.held.length} of ${model.asked} points (${model.percentHeld}%).${model.unfinished.length > 0 ? ` ${model.unfinished.length} not yet answered.` : ""}`,
		"",
	);
	const refs = (list: readonly BlueprintRef[] | undefined): string =>
		list === undefined || list.length === 0 ? "" : ` (${list.map(ref => `\`${refLabel(ref)}\``).join(", ")})`;
	out.push("## Held", "");
	if (model.held.length === 0) out.push("Nothing was held.");
	for (const { point } of model.held) out.push(`- **${point.title}**: the partner conceded.${refs(point.refs)}`);
	out.push("", "## Open risks", "");
	if (model.open.length === 0) out.push("None.");
	for (const { point, record } of model.open) {
		const how = record.outcome === undefined ? "" : ` ${outcomeText(record.outcome)}`;
		const note = record.outcome?.note ? ` Your note: ${oneLine(record.outcome.note, 400)}` : "";
		out.push(
			`- **${point.title}** (${kindLabel(point.kind)}, ${severityLabel(point.severity).toLowerCase()}): ${objectionOf(point)}${how}${note}${refs(point.refs)}`,
		);
	}
	out.push("", "## Suggested changes", "");
	if (model.suggested.length === 0) out.push("None.");
	for (const { point, record } of model.suggested)
		out.push(`- **${point.title}**: ${oneLine(record.reveal?.suggestion ?? "", 600)}${refs(record.reveal?.refs)}`);
	return `${out.join("\n")}\n`;
}

// ── the list ─────────────────────────────────────────────────────────────────

export type RowStatus =
	| { kind: "generating"; text: string }
	| { kind: "failed"; text: string }
	| { kind: "progress"; text: string }
	| { kind: "score"; text: string; percent: number }
	| { kind: "new"; text: string };

/** What a row of the list says about a spar: how it is being prepared, or where you stand. */
export function rowStatus(spar: SparSummary): RowStatus {
	if (spar.status === "running") return { kind: "generating", text: "Preparing…" };
	if (spar.status === "failed") return { kind: "failed", text: "Failed" };
	const latest = spar.latest;
	if (latest === undefined) return { kind: "new", text: "Not started" };
	if (!latest.finished) return { kind: "progress", text: "In progress" };
	return {
		kind: "score",
		text: `${latest.held}/${latest.asked} held · ${latest.percentHeld}%`,
		percent: latest.percentHeld,
	};
}

/** The rows grouped by repository, the groups ordered by their newest spar. */
export function groupByRepo(spars: readonly SparSummary[]): { repoRoot: string; name: string; spars: SparSummary[] }[] {
	const groups = new Map<string, SparSummary[]>();
	for (const spar of [...spars].sort((a, b) => b.createdAt - a.createdAt)) {
		const group = groups.get(spar.repoRoot);
		if (group === undefined) groups.set(spar.repoRoot, [spar]);
		else group.push(spar);
	}
	return [...groups].map(([repoRoot, items]) => ({
		repoRoot,
		name: repoRoot.replace(/\/+$/, "").split("/").pop() || repoRoot,
		spars: items,
	}));
}
