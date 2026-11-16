import { createLazySheet } from "../shell/createLazySheet";
import type { ReviewBoardSheetProps } from "./ReviewBoardSheet";

/**
 * `ReviewBoardSheet`, loaded when first shown: the board, its stack navigator and its comment views are only
 * needed once a change set is opened for review, so they stay out of the entry bundle.
 */
export const LazyReviewBoardSheet = createLazySheet<ReviewBoardSheetProps>(
	{ label: "review board", title: "Review board", noun: "the review board" },
	() => import("./ReviewBoardSheet").then(module => module.ReviewBoardSheet),
);
