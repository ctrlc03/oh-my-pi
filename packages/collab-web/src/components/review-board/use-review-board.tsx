import { Columns4 } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";
import type { GuestClient, GuestSnapshot } from "../../lib/client";
import { type PaletteEntry, usePaletteEntries } from "../../lib/palette";
import type { BoardCompanion } from "./board-data";
import { LazyReviewBoardSheet } from "./LazyReviewBoardSheet";
import type { BoardStart } from "./ReviewBoardSheet";

/**
 * The review board and the ways to open it. `open` is for the sheets that offer it (a pull request's page, a turn's
 * changes, the branch review); the palette entries (registered once, by the pane that asks) open it on this session's
 * changes, its branch, or a pull request to pick. The board's comments go back to this session.
 */
export function useReviewBoard(
	client: GuestClient,
	snap: GuestSnapshot,
	sessionId: string | null,
	companion: BoardCompanion | null,
	registerPalette = false,
): { open(start: BoardStart): void; sheet: ReactNode } {
	const [start, setStart] = useState<{ start: BoardStart; id: number } | null>(null);
	// Each opening is a fresh board, even on top of an open one.
	const open = useCallback((next: BoardStart) => setStart({ start: next, id: Date.now() }), []);
	const close = useCallback(() => setStart(null), []);
	const canSession = !snap.readOnly && snap.phase === "live" && Object.hasOwn(snap.features, "turn-diff");
	const canBranch = companion !== null;
	const canPr = companion?.canBoard === true;
	const entries = useMemo<PaletteEntry[]>(
		() =>
			registerPalette
				? [
						...(canSession
							? [
									{
										id: "review-board:session",
										title: "Review board: this session",
										section: "View",
										keywords: ["review", "diff", "changes", "comments", "agent", "reasoning"],
										icon: Columns4,
										run: () => open({ view: "session" }),
									},
								]
							: []),
						...(canBranch
							? [
									{
										id: "review-board:branch",
										title: "Review board: branch",
										section: "View",
										keywords: ["review", "diff", "merge-base", "comments", "agent", "reasoning"],
										icon: Columns4,
										run: () => open({ view: "branch" }),
									},
								]
							: []),
						...(canPr
							? [
									{
										id: "review-board:pr",
										title: "Review board: PR…",
										section: "View",
										keywords: ["review", "pull request", "stack", "comments", "agent", "reasoning"],
										icon: Columns4,
										run: () => open({ view: "pr", number: null }),
									},
								]
							: []),
					]
				: [],
		[registerPalette, canSession, canBranch, canPr, open],
	);
	usePaletteEntries(entries);
	const sheet =
		start === null ? null : (
			<LazyReviewBoardSheet
				key={start.id}
				client={client}
				snap={snap}
				sessionId={sessionId}
				companion={companion}
				initial={start.start}
				onClose={close}
			/>
		);
	return { open, sheet };
}
