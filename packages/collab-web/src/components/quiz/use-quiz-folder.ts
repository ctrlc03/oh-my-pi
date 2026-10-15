import type { QuizFolder } from "@oh-my-pi/pi-wire/quiz";
import { useCallback } from "react";
import type { CompanionClient } from "../../lib/companion";
import { useRequest } from "../../lib/use-request";
import { getQuizFolder } from "./quiz-api";

/** Folders already looked at, per computer: reopening the form for the same folder does not ask again. */
const looked = new WeakMap<CompanionClient, Map<string, QuizFolder>>();

/**
 * What a topic quiz of `cwd` can draw on, asked of the computer once per folder. Null while it is loading, when the
 * lookup failed, or when `enabled` is false: the form then assumes nothing and lets the companion refuse.
 */
export function useQuizFolder(client: CompanionClient | null, cwd: string, enabled: boolean): QuizFolder | null {
	const load = useCallback(async (): Promise<QuizFolder | null> => {
		if (!enabled || client === null || cwd === "") return null;
		const known = looked.get(client)?.get(cwd);
		if (known !== undefined) return known;
		const folder = await getQuizFolder(client, cwd);
		const byFolder = looked.get(client) ?? new Map<string, QuizFolder>();
		byFolder.set(cwd, folder);
		looked.set(client, byFolder);
		return folder;
	}, [client, cwd, enabled]);
	const { state } = useRequest(load);
	return state.status === "ready" ? state.value : null;
}
