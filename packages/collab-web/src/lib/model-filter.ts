/**
 * Ordering and filtering of the model picker. A host with a full catalogue offers hundreds of models, so the picker
 * filters them by what is typed and keeps the provider in use on top.
 */
import type { WireModel } from "@oh-my-pi/pi-wire";
import { fuzzyMatch, substringMatch } from "./fuzzy";

/** A picker with more models than this gets a filter field. */
export const MODEL_FILTER_MIN = 12;

export interface ModelGroup {
	provider: string;
	models: WireModel[];
}

interface Scored {
	model: WireModel;
	score: number;
}

/** Models grouped by provider, in the host's order. */
function groupByProvider(models: readonly WireModel[]): ModelGroup[] {
	const groups = new Map<string, ModelGroup>();
	for (const model of models) {
		const group = groups.get(model.provider);
		if (group) group.models.push(model);
		else groups.set(model.provider, { provider: model.provider, models: [model] });
	}
	return [...groups.values()];
}

/** Whole words first: `sonnet` finds "Claude Sonnet 4.5", ranked by a hit in the name over one in the id or provider. */
function substringScore(query: string, model: WireModel): number | null {
	const inName = substringMatch(query, model.name);
	if (inName !== null) return 2000 + inName.score;
	const inAny = substringMatch(query, `${model.name} ${model.id} ${model.provider}`);
	return inAny === null ? null : 1000 + inAny.score;
}

/** Letters in order: `s45` finds "Claude Sonnet 4.5". Only used when no model contains the query as written. */
function fuzzyScore(query: string, model: WireModel): number | null {
	const inName = fuzzyMatch(query, model.name);
	const inId = fuzzyMatch(query, model.id);
	if (inName === null) return inId === null ? null : inId.score;
	return inId === null ? inName.score : Math.max(inName.score, inId.score);
}

function scoreAll(models: readonly WireModel[], score: (model: WireModel) => number | null): Scored[] {
	const found: Scored[] = [];
	for (const model of models) {
		const value = score(model);
		if (value !== null) found.push({ model, score: value });
	}
	return found;
}

/**
 * The picker's groups. With no query: the host's order, the current model's provider first. With a query: models that
 * contain every word of it (or, when none do, that hold its letters in order), best first, the group of the best
 * match first. An empty result means nothing matched.
 */
export function arrangeModels(
	models: readonly WireModel[],
	current: Pick<WireModel, "provider"> | undefined,
	query: string,
): ModelGroup[] {
	if (query.trim() === "") {
		const groups = groupByProvider(models);
		const at = current === undefined ? -1 : groups.findIndex(group => group.provider === current.provider);
		if (at > 0) groups.unshift(...groups.splice(at, 1));
		return groups;
	}
	let found = scoreAll(models, model => substringScore(query, model));
	if (found.length === 0) found = scoreAll(models, model => fuzzyScore(query, model));
	// Array.sort is stable: equal scores keep the host's order.
	found.sort((a, b) => b.score - a.score);
	return groupByProvider(found.map(entry => entry.model));
}
