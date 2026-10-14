import { describe, expect, it } from "bun:test";
import {
	bundlePathFromExe,
	compareTags,
	desktopAssetName,
	expectedSha256,
	isNewer,
	parseBuildInfo,
	parseChecksums,
	parseTag,
	selectUpdate,
} from "../src/main/release";

const REPO = "ctrlc03/oh-my-pi";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function release(
	tag: string,
	over: { assets?: object[]; draft?: boolean; prerelease?: boolean; digest?: string } = {},
): object {
	const base = `https://github.com/${REPO}/releases/download/${tag}`;
	return {
		tag_name: tag,
		draft: over.draft ?? false,
		prerelease: over.prerelease ?? false,
		assets: over.assets ?? [
			{
				name: "collab-desktop-darwin-arm64.zip",
				state: "uploaded",
				size: 1234,
				digest: over.digest ?? `sha256:${SHA_A}`,
				browser_download_url: `${base}/collab-desktop-darwin-arm64.zip`,
			},
			{ name: "SHA256SUMS.txt", state: "uploaded", size: 400, browser_download_url: `${base}/SHA256SUMS.txt` },
			{ name: "omp-darwin-arm64", state: "uploaded", size: 9, browser_download_url: `${base}/omp-darwin-arm64` },
		],
	};
}

const select = (
	releases: unknown,
	current: string | null = "collab-v18.10.4-1",
	arch = "arm64",
	platform: NodeJS.Platform = "darwin",
) => selectUpdate(releases, { current, repo: REPO, platform, arch });

describe("tags", () => {
	it("parses the fork's tag shape only", () => {
		expect(parseTag("collab-v18.10.4-2")).toEqual({ tag: "collab-v18.10.4-2", parts: [18, 10, 4], build: 2 });
		for (const tag of ["v18.10.4", "collab-v18.10.4", "collab-v18.10-1", "collab-v18.10.4-1-rc", "x"])
			expect(parseTag(tag)).toBeNull();
	});

	it("orders by version, then build counter, numerically", () => {
		const t = (tag: string) => parseTag(tag)!;
		expect(compareTags(t("collab-v18.10.4-2"), t("collab-v18.10.4-1"))).toBeGreaterThan(0);
		expect(compareTags(t("collab-v18.10.5-1"), t("collab-v18.10.4-9"))).toBeGreaterThan(0);
		expect(compareTags(t("collab-v18.9.0-1"), t("collab-v18.10.0-1"))).toBeLessThan(0);
		expect(compareTags(t("collab-v18.10.4-10"), t("collab-v18.10.4-9"))).toBeGreaterThan(0);
		expect(compareTags(t("collab-v1.2.3-1"), t("collab-v1.2.3-1"))).toBe(0);
	});

	it("calls a release newer only when it is, and a development build older than any", () => {
		expect(isNewer("collab-v18.10.4-2", "collab-v18.10.4-1")).toBe(true);
		expect(isNewer("collab-v18.10.4-1", "collab-v18.10.4-1")).toBe(false);
		expect(isNewer("collab-v18.10.3-9", "collab-v18.10.4-1")).toBe(false);
		expect(isNewer("collab-v18.10.4-1", null)).toBe(true);
		expect(isNewer("collab-v18.10.4-1", "dev")).toBe(true);
		expect(isNewer("nightly", "collab-v1.0.0-1")).toBe(false);
	});
});

describe("desktopAssetName", () => {
	it("names the macOS zips and nothing else", () => {
		expect(desktopAssetName("darwin", "arm64")).toBe("collab-desktop-darwin-arm64.zip");
		expect(desktopAssetName("darwin", "x64")).toBe("collab-desktop-darwin-x64.zip");
		expect(desktopAssetName("darwin", "ia32")).toBeNull();
		expect(desktopAssetName("linux", "x64")).toBeNull();
		expect(desktopAssetName("win32", "x64")).toBeNull();
	});
});

describe("selectUpdate", () => {
	it("picks the newest newer release that carries the app and the checksums", () => {
		const offer = select([release("collab-v18.10.4-1"), release("collab-v18.10.5-1"), release("collab-v18.10.4-3")]);
		expect(offer).toMatchObject({
			tag: "collab-v18.10.5-1",
			name: "collab-desktop-darwin-arm64.zip",
			size: 1234,
			githubSha256: SHA_A,
			url: `https://github.com/${REPO}/releases/download/collab-v18.10.5-1/collab-desktop-darwin-arm64.zip`,
			checksumsUrl: `https://github.com/${REPO}/releases/download/collab-v18.10.5-1/SHA256SUMS.txt`,
		});
	});

	it("offers nothing when already current or ahead", () => {
		expect(select([release("collab-v18.10.4-1")])).toBeUndefined();
		expect(select([release("collab-v18.10.3-1")])).toBeUndefined();
		expect(select([])).toBeUndefined();
		expect(select("nonsense")).toBeUndefined();
	});

	it("skips drafts, prereleases and other tag shapes", () => {
		expect(
			select([
				release("collab-v18.10.5-1", { draft: true }),
				release("collab-v18.10.6-1", { prerelease: true }),
				release("v19.0.0"),
			]),
		).toBeUndefined();
	});

	it("falls back to an older release when the newest has no app for this platform", () => {
		const without = release("collab-v18.10.6-1", {
			assets: [{ name: "omp-darwin-arm64", state: "uploaded", size: 1 }],
		});
		expect(select([without, release("collab-v18.10.5-1")])?.tag).toBe("collab-v18.10.5-1");
	});

	it("needs the checksums file and a fully uploaded app", () => {
		const base = `https://github.com/${REPO}/releases/download/collab-v18.10.5-1`;
		const app = {
			name: "collab-desktop-darwin-arm64.zip",
			state: "uploaded",
			size: 5,
			browser_download_url: `${base}/collab-desktop-darwin-arm64.zip`,
		};
		expect(select([release("collab-v18.10.5-1", { assets: [app] })])).toBeUndefined();
		const sums = {
			name: "SHA256SUMS.txt",
			state: "uploaded",
			size: 5,
			browser_download_url: `${base}/SHA256SUMS.txt`,
		};
		expect(select([release("collab-v18.10.5-1", { assets: [{ ...app, state: "starter" }, sums] })])).toBeUndefined();
		expect(select([release("collab-v18.10.5-1", { assets: [app, sums] })])?.githubSha256).toBeNull();
	});

	it("refuses download URLs that are not GitHub's for that release", () => {
		const evil = release("collab-v18.10.5-1", {
			assets: [
				{
					name: "collab-desktop-darwin-arm64.zip",
					state: "uploaded",
					size: 5,
					browser_download_url: "https://evil.example/collab-desktop-darwin-arm64.zip",
				},
				{
					name: "SHA256SUMS.txt",
					state: "uploaded",
					size: 5,
					browser_download_url: `https://github.com/${REPO}/releases/download/collab-v18.10.5-1/SHA256SUMS.txt`,
				},
			],
		});
		expect(select([evil])).toBeUndefined();
	});

	it("matches the architecture and has nothing for platforms without a release", () => {
		const x64 = release("collab-v18.10.5-1", { assets: [] });
		expect(select([x64], "collab-v18.10.4-1", "x64")).toBeUndefined();
		expect(select([release("collab-v18.10.5-1")], "collab-v18.10.4-1", "arm64", "linux")).toBeUndefined();
	});

	it("treats a development build as older than every release", () => {
		expect(select([release("collab-v1.0.0-1")], null)?.tag).toBe("collab-v1.0.0-1");
	});
});

describe("checksums", () => {
	const text = `${SHA_A}  collab-desktop-darwin-arm64.zip\n${SHA_B} *omp-linux-x64\nnot a line\n${"c".repeat(63)}  short\n`;

	it("reads sha256sum output, both text and binary mode", () => {
		expect([...parseChecksums(text)]).toEqual([
			["collab-desktop-darwin-arm64.zip", SHA_A],
			["omp-linux-x64", SHA_B],
		]);
	});

	it("returns the listed checksum, which must agree with GitHub's digest", () => {
		expect(expectedSha256(text, "collab-desktop-darwin-arm64.zip", null)).toBe(SHA_A);
		expect(expectedSha256(text, "collab-desktop-darwin-arm64.zip", SHA_A)).toBe(SHA_A);
		expect(() => expectedSha256(text, "collab-desktop-darwin-arm64.zip", SHA_B)).toThrow("disagree");
		expect(() => expectedSha256(text, "missing.zip", null)).toThrow("no entry");
	});
});

describe("bundlePathFromExe", () => {
	it("finds the bundle an executable lives in", () => {
		expect(bundlePathFromExe("/Applications/omp collab.app/Contents/MacOS/omp collab")).toBe(
			"/Applications/omp collab.app",
		);
		expect(bundlePathFromExe("/Users/u/Applications/omp collab.app/Contents/MacOS/omp collab")).toBe(
			"/Users/u/Applications/omp collab.app",
		);
		expect(bundlePathFromExe("/usr/local/bin/electron")).toBeNull();
	});
});

describe("parseBuildInfo", () => {
	it("reads the tag and repository the build recorded", () => {
		expect(parseBuildInfo('{"tag":"collab-v18.10.4-1","repo":"me/fork"}')).toEqual({
			tag: "collab-v18.10.4-1",
			repo: "me/fork",
		});
	});
	it("is a development build for anything else", () => {
		expect(parseBuildInfo(null)).toEqual({ tag: null, repo: "ctrlc03/oh-my-pi" });
		expect(parseBuildInfo('{"tag":"dev","repo":"../x"}')).toEqual({ tag: null, repo: "ctrlc03/oh-my-pi" });
		expect(parseBuildInfo("{")).toEqual({ tag: null, repo: "ctrlc03/oh-my-pi" });
	});
});
