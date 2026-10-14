import { createLazySheet } from "../shell/createLazySheet";
import type { SparSheetProps } from "./SparSheet";

/**
 * `SparSheet`, loaded when first shown. The points, the exchange with the partner and the summary are only needed
 * once someone opens sparring: keep them out of the entry bundle.
 */
export const LazySparSheet = createLazySheet<SparSheetProps>(
	{ label: "sparring", title: "Sparring", noun: "sparring" },
	() => import("./SparSheet").then(module => module.SparSheet),
);
