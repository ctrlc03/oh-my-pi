import { createLazySheet } from "../shell/createLazySheet";
import type { BakeoffSheetProps } from "./BakeoffSheet";

/**
 * `BakeoffSheet`, loaded when first shown. The form, the entries and the verdict are only needed once someone opens a
 * bake-off: keep them out of the entry bundle.
 */
export const LazyBakeoffSheet = createLazySheet<BakeoffSheetProps>(
	{ label: "bake-off", title: "Bake-off", noun: "bake-off" },
	() => import("./BakeoffSheet").then(module => module.BakeoffSheet),
);
