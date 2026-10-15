import type { BakeoffFolder } from "@oh-my-pi/pi-wire/bakeoff";
import { useCallback } from "react";
import type { CompanionClient } from "../../lib/companion";
import { useRequest } from "../../lib/use-request";
import { getBakeoffFolder } from "./bakeoff-api";

/** Folders already looked at, per computer: reopening the sheet for the same folder does not ask again. */
const looked = new WeakMap<CompanionClient, Map<string, BakeoffFolder>>();

/**
 * Whether `cwd` is a git repository, asked of the computer once per folder. Null while it is loading, when the lookup
 * failed, or when `enabled` is false: the form then assumes a repository and lets the companion refuse.
 */
export function useBakeoffFolder(client: CompanionClient | null, cwd: string, enabled: boolean): BakeoffFolder | null {
	const load = useCallback(async (): Promise<BakeoffFolder | null> => {
		if (!enabled || client === null || cwd === "") return null;
		const known = looked.get(client)?.get(cwd);
		if (known !== undefined) return known;
		const folder = await getBakeoffFolder(client, cwd);
		const byFolder = looked.get(client) ?? new Map<string, BakeoffFolder>();
		byFolder.set(cwd, folder);
		looked.set(client, byFolder);
		return folder;
	}, [client, cwd, enabled]);
	const { state } = useRequest(load);
	return state.status === "ready" ? state.value : null;
}
