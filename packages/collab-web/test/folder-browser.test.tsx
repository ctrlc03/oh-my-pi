import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FolderBrowser } from "../src/components/shell/FolderBrowser";
import { FolderList } from "../src/components/shell/StartSessionSheet";
import type { CompanionClient } from "../src/lib/companion";

const recent = {
	status: "ready" as const,
	value: [{ cwd: "/Users/me/code/app", lastActive: 0, sessions: [] }],
};

describe("Choose another folder in the folder list", () => {
	const render = (state: Parameters<typeof FolderList>[0]["state"], onBrowse: (() => void) | undefined): string =>
		renderToStaticMarkup(
			<FolderList state={state} canScratch={false} onPick={() => {}} onBrowse={onBrowse} onRetry={() => {}} />,
		);

	it("is offered when the companion can browse, beside the recent folders", () => {
		const html = render(recent, () => {});
		expect(html).toContain("Choose another folder…");
		expect(html).toContain("app");
	});

	it("is not offered by an older companion, which still lists its folders", () => {
		const html = render(recent, undefined);
		expect(html).not.toContain("Choose another folder");
		expect(html).toContain("app");
	});

	it("is offered while the folders load, when they fail and when there are none", () => {
		for (const state of [
			{ status: "loading" as const },
			{ status: "error" as const, message: "nope" },
			{ status: "ready" as const, value: [] },
		]) {
			expect(render(state, () => {})).toContain("Choose another folder…");
			expect(render(state, undefined)).not.toContain("Choose another folder");
		}
	});

	it("sits with No project when both are offered", () => {
		const html = renderToStaticMarkup(
			<FolderList state={recent} canScratch onPick={() => {}} onBrowse={() => {}} onRetry={() => {}} />,
		);
		expect(html).toContain("No project");
		expect(html).toContain("Choose another folder…");
	});
});

describe("the folder browser", () => {
	it("shows the path field, the hidden toggle and a disabled Use this folder while the first listing loads", () => {
		const html = renderToStaticMarkup(<FolderBrowser client={{} as CompanionClient} onPick={() => {}} />);
		expect(html).toContain('aria-label="Folder path"');
		expect(html).toContain("Show hidden folders");
		expect(html).toContain("Loading folders…");
		expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Use this folder<\/button>/);
		expect(html).toMatch(/<button[^>]*aria-label="Go to parent folder"[^>]*disabled=""/);
	});
});
