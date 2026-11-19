import type { ShellSheetProps } from "./ShellSheet";
import { createLazySheet } from "./createLazySheet";

/**
 * `ShellSheet`, loaded when first shown. The terminal emulator (xterm.js) is sizeable and only needed once a
 * terminal opens: keep it out of the entry bundle.
 */
export const LazyShellSheet = createLazySheet<ShellSheetProps>(
	{ label: "shell", pane: "shell", title: "Terminal", noun: "the terminal" },
	() => import("./ShellSheet").then(module => module.ShellSheet),
);
