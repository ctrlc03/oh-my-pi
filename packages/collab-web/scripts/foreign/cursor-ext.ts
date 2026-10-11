/**
 * Cursor's ACP extension methods (https://cursor.com/docs/cli/acp): the shapes of what the agent sends
 * and the answers it waits for. The host turns the blocking ones (`cursor/ask_question`,
 * `cursor/create_plan`) into prompts for the guests and the todo notification (`cursor/update_todos`)
 * into a plan card.
 */

import type { PlanEntry } from "@oh-my-pi/pi-utils/acp/protocol";
import { isRecord } from "../../src/tool-render/util";

export interface CursorQuestion {
	id: string;
	prompt: string;
	options: { id: string; label: string }[];
	multi: boolean;
}

export interface CursorAsk {
	toolCallId: string;
	questions: CursorQuestion[];
}

export type CursorTodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface CursorTodo {
	id: string;
	content: string;
	status: CursorTodoStatus;
}

export interface CursorPlan {
	toolCallId: string;
	name: string | undefined;
	overview: string | undefined;
	plan: string;
	todos: CursorTodo[];
}

export interface CursorTodoUpdate {
	toolCallId: string;
	todos: CursorTodo[];
	merge: boolean;
}

/** Bounds on what one request can make the host render. */
const MAX_QUESTIONS = 12;
const MAX_OPTIONS = 40;
const MAX_TODOS = 200;

function isTodoStatus(value: unknown): value is CursorTodoStatus {
	return value === "pending" || value === "in_progress" || value === "completed" || value === "cancelled";
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

function parseTodos(value: unknown): CursorTodo[] | null {
	if (!Array.isArray(value) || value.length > MAX_TODOS) return null;
	const todos: CursorTodo[] = [];
	for (const item of value) {
		if (!isRecord(item) || typeof item.id !== "string" || typeof item.content !== "string") return null;
		if (!isTodoStatus(item.status)) return null;
		todos.push({ id: item.id, content: item.content, status: item.status });
	}
	return todos;
}

export function parseAskQuestion(params: unknown): CursorAsk | null {
	if (!isRecord(params) || typeof params.toolCallId !== "string") return null;
	if (!Array.isArray(params.questions) || params.questions.length === 0 || params.questions.length > MAX_QUESTIONS)
		return null;
	const questions: CursorQuestion[] = [];
	for (const item of params.questions) {
		if (!isRecord(item) || typeof item.id !== "string" || typeof item.prompt !== "string") return null;
		if (!Array.isArray(item.options) || item.options.length === 0 || item.options.length > MAX_OPTIONS) return null;
		const options: CursorQuestion["options"] = [];
		for (const option of item.options) {
			if (!isRecord(option) || typeof option.id !== "string" || typeof option.label !== "string") return null;
			options.push({ id: option.id, label: option.label });
		}
		questions.push({ id: item.id, prompt: item.prompt, options, multi: item.allowMultiple === true });
	}
	return { toolCallId: params.toolCallId, questions };
}

export function parseCreatePlan(params: unknown): CursorPlan | null {
	if (!isRecord(params) || typeof params.toolCallId !== "string" || typeof params.plan !== "string") return null;
	const todos = parseTodos(params.todos);
	if (todos === null) return null;
	return {
		toolCallId: params.toolCallId,
		name: optionalString(params.name),
		overview: optionalString(params.overview),
		plan: params.plan,
		todos,
	};
}

export function parseUpdateTodos(params: unknown): CursorTodoUpdate | null {
	if (!isRecord(params) || typeof params.toolCallId !== "string") return null;
	const todos = parseTodos(params.todos);
	return todos === null ? null : { toolCallId: params.toolCallId, todos, merge: params.merge === true };
}

/** The todo list after an update: replaced, or `incoming` merged into `current` by id (new ids appended). */
export function applyTodoUpdate(
	current: readonly CursorTodo[],
	incoming: readonly CursorTodo[],
	merge: boolean,
): CursorTodo[] {
	if (!merge) return [...incoming];
	const next = [...current];
	for (const todo of incoming) {
		const at = next.findIndex(existing => existing.id === todo.id);
		if (at < 0) next.push(todo);
		else next[at] = todo;
	}
	return next;
}

/** The plan card's entries; a cancelled todo is no longer part of the work, so it is left out. */
export function planEntries(todos: readonly CursorTodo[]): PlanEntry[] {
	return todos.flatMap(todo =>
		todo.status === "cancelled" ? [] : [{ content: todo.content, priority: "medium" as const, status: todo.status }],
	);
}

/** The plan as the markdown the guests read before they are asked to approve it. */
export function planMarkdown(plan: CursorPlan): string {
	const parts = [plan.name === undefined ? "" : `## ${plan.name}`, plan.overview ?? "", plan.plan];
	return `${parts.filter(part => part !== "").join("\n\n")}\n\n`;
}
