import { createLazySheet } from "../shell/createLazySheet";
import type { CodemapSheetProps } from "./CodemapSheet";

/**
 * `CodemapSheet`, loaded when first shown. The code map screens and their force layout (d3-force) are large and
 * only needed once the map is opened: keep them out of the entry bundle.
 */
export const LazyCodemapSheet = createLazySheet<CodemapSheetProps>(
	{ label: "code map", title: "Code map", noun: "the code map" },
	() => import("./CodemapSheet").then(module => module.CodemapSheet),
);
