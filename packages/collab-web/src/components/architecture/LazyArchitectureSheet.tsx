import { createLazySheet } from "../shell/createLazySheet";
import type { ArchitectureSheetProps } from "./ArchitectureSheet";

/**
 * `ArchitectureSheet`, loaded when first shown. The viewer, its layout and the export are only needed once a map
 * is opened: keep them out of the entry bundle.
 */
export const LazyArchitectureSheet = createLazySheet<ArchitectureSheetProps>(
	{ label: "architecture maps", title: "Architecture maps", noun: "the architecture maps" },
	() => import("./ArchitectureSheet").then(module => module.ArchitectureSheet),
);
