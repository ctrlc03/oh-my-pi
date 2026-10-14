/**
 * Where the companion keeps architecture maps: `<dir>/index.json` (one summary per map, including maps still running
 * or failed) and `<dir>/<id>.json` (a finished map). See ./companion-doc-store for the storage rules.
 */

import { type Blueprint, BLUEPRINT_VERSION, type BlueprintSummary } from "@oh-my-pi/pi-wire/blueprint";
import { isRecord } from "../src/tool-render/util";
import { createDocStore, type DocStore } from "./companion-doc-store";

export type BlueprintStore = DocStore<BlueprintSummary, Blueprint>;

export function createBlueprintStore(dir: string): BlueprintStore {
	return createDocStore<BlueprintSummary, Blueprint>({
		dir,
		indexKey: "maps",
		idPrefix: "bp",
		noun: "map",
		version: BLUEPRINT_VERSION,
		isSummary: value => isRecord(value.head) && typeof value.head.commit === "string",
	});
}
