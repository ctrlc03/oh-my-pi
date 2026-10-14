/**
 * What the session has told the owner, for the limits of `notify_owner`: `info` and `question` calls per rolling
 * hour (`personal.notifyOwner.maxPerHour`) and questions still unanswered (`maxOpenQuestions`). It lives for the
 * session: a restarted session starts with an empty book, and the companion's own inbox is the record across
 * sessions. An answer that arrives as an owner event closes its question.
 */
import type { NotifyKind } from "@oh-my-pi/pi-wire/personal-ipc";

const HOUR_MS = 60 * 60 * 1000;

export interface NotifyLimits {
	/** 0 = unlimited. */
	maxPerHour: number;
	/** 0 = unlimited. */
	maxOpenQuestions: number;
}

export class NotifyBook {
	readonly #now: () => number;
	#times: number[] = [];
	readonly #open = new Set<string>();

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	/** Why a `kind` notification may not be sent now, or undefined when it may. */
	refusal(kind: NotifyKind, limits: NotifyLimits): string | undefined {
		if (kind !== "info" && kind !== "question") return undefined;
		const cutoff = this.#now() - HOUR_MS;
		this.#times = this.#times.filter(at => at > cutoff);
		if (limits.maxPerHour > 0 && this.#times.length >= limits.maxPerHour) {
			return `Too many notifications: ${limits.maxPerHour} an hour is the limit (personal.notifyOwner.maxPerHour) and ${this.#times.length} went out in the last hour. Keep what you wanted to say for the next one, or fold it into the answer you are about to give.`;
		}
		if (kind === "question" && limits.maxOpenQuestions > 0 && this.#open.size >= limits.maxOpenQuestions) {
			return `Too many open questions: ${this.#open.size} are waiting for the owner (limit ${limits.maxOpenQuestions}). Wait for answers, or decide without asking.`;
		}
		return undefined;
	}

	/** A notification went out as inbox item `itemId`. */
	record(kind: NotifyKind, itemId: string): void {
		if (kind !== "info" && kind !== "question") return;
		this.#times.push(this.#now());
		if (kind === "question") this.#open.add(itemId);
	}

	/** The owner answered the question that was inbox item `itemId`. */
	answered(itemId: string): void {
		this.#open.delete(itemId);
	}

	get openQuestions(): number {
		return this.#open.size;
	}
}
