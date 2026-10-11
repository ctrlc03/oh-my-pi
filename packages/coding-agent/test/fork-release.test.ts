import { describe, expect, it } from "bun:test";
import {
	buildLabel,
	FORK_TAG_PATTERN,
	IS_FORK_BUILD,
	RELEASE_REPO,
	UPSTREAM_RELEASE_REPO,
} from "@oh-my-pi/pi-coding-agent/build-identity";
import {
	compareForkTags,
	fetchLatestForkBuild,
	forkBuildFromRelease,
	forkInstallerHint,
	parseForkTag,
	selectLatestForkRelease,
	versionFromTag,
} from "@oh-my-pi/pi-coding-agent/cli/fork-release";

const FORK_REPO = "ctrlc03/oh-my-pi";

function release(tag: string, flags: { draft?: boolean; prerelease?: boolean } = {}): Record<string, unknown> {
	return { tag_name: tag, draft: flags.draft ?? false, prerelease: flags.prerelease ?? false, assets: [] };
}

describe("build identity", () => {
	it("is upstream with no tag outside a compiled fork build", () => {
		expect(RELEASE_REPO).toBe(UPSTREAM_RELEASE_REPO);
		expect(IS_FORK_BUILD).toBe(false);
		expect(buildLabel()).toBe(`dev (${UPSTREAM_RELEASE_REPO})`);
		expect(buildLabel("collab-v18.8.9-3", FORK_REPO)).toBe("collab-v18.8.9-3 (ctrlc03/oh-my-pi)");
	});

	it("matches only collab-v<major>.<minor>.<patch>-<n> tags", () => {
		for (const tag of ["collab-v18.8.9-1", "collab-v0.0.1-12"]) expect(FORK_TAG_PATTERN.test(tag)).toBe(true);
		for (const tag of [
			"v18.8.9",
			"collab-v18.8.9",
			"collab-v18.8-1",
			"collab-v18.8.9-1-rc",
			"xcollab-v18.8.9-1",
			"collab-v18.8.9-",
		]) {
			expect(FORK_TAG_PATTERN.test(tag)).toBe(false);
		}
	});
});

describe("fork release tags", () => {
	it("parses the version and build counter", () => {
		expect(parseForkTag("collab-v18.8.9-3")).toEqual({
			tag: "collab-v18.8.9-3",
			version: "18.8.9",
			parts: [18, 8, 9],
			build: 3,
		});
		expect(parseForkTag("v18.8.9")).toBeNull();
	});

	it("maps a tag to the omp version it ships", () => {
		expect(versionFromTag("collab-v18.8.9-3")).toBe("18.8.9");
		expect(versionFromTag("v18.8.9")).toBe("18.8.9");
	});

	it("orders by version, then by build counter, numerically", () => {
		expect(compareForkTags("collab-v18.8.9-2", "collab-v18.8.9-1")).toBeGreaterThan(0);
		expect(compareForkTags("collab-v18.8.9-10", "collab-v18.8.9-9")).toBeGreaterThan(0);
		expect(compareForkTags("collab-v18.9.0-1", "collab-v18.8.9-7")).toBeGreaterThan(0);
		expect(compareForkTags("collab-v18.8.9-1", "collab-v18.8.9-1")).toBe(0);
		expect(compareForkTags("collab-v18.8.9-1", "collab-v18.8.10-1")).toBeLessThan(0);
	});

	it("treats a build without a fork tag as older than any release", () => {
		expect(compareForkTags("collab-v0.0.1-1", null)).toBeGreaterThan(0);
		expect(compareForkTags("collab-v0.0.1-1", "dev")).toBeGreaterThan(0);
	});

	it("rejects a release tag that is not a fork tag", () => {
		expect(() => compareForkTags("v18.8.9", null)).toThrow("Not a fork release tag");
	});
});

describe("selectLatestForkRelease", () => {
	it("picks the highest published fork release", () => {
		const listing = [
			release("collab-v18.8.9-2"),
			release("collab-v18.8.9-10"),
			release("v99.0.0"),
			release("collab-v18.8.9-9"),
		];
		expect(selectLatestForkRelease(listing)).toEqual({ tag: "collab-v18.8.9-10", version: "18.8.9" });
	});

	it("skips drafts and prereleases", () => {
		const listing = [
			release("collab-v18.9.0-1", { draft: true }),
			release("collab-v18.9.0-2", { prerelease: true }),
			release("collab-v18.8.9-1"),
		];
		expect(selectLatestForkRelease(listing)).toEqual({ tag: "collab-v18.8.9-1", version: "18.8.9" });
	});

	it("is undefined when there is no fork release", () => {
		expect(selectLatestForkRelease([release("v18.8.9")])).toBeUndefined();
		expect(selectLatestForkRelease([])).toBeUndefined();
		expect(selectLatestForkRelease({ message: "Not Found" })).toBeUndefined();
	});
});

describe("fork release assets", () => {
	const digest = "a".repeat(64);
	function withAsset(tag: string, url: string): Record<string, unknown> {
		return {
			...release(tag),
			assets: [
				{
					name: "omp-darwin-arm64",
					state: "uploaded",
					size: 1234,
					digest: `sha256:${digest}`,
					browser_download_url: url,
				},
			],
		};
	}

	it("accepts the fork's own download URL and reports the omp version", () => {
		const tag = "collab-v18.8.9-3";
		const url = `https://github.com/${FORK_REPO}/releases/download/${tag}/omp-darwin-arm64`;
		expect(forkBuildFromRelease(withAsset(tag, url), tag, "omp-darwin-arm64", FORK_REPO)).toEqual({
			version: "18.8.9",
			download: url,
			file: { name: "omp-darwin-arm64", size: 1234, sha256: digest },
		});
	});

	it("rejects a download URL on another repository", () => {
		const tag = "collab-v18.8.9-3";
		const upstream = `https://github.com/${UPSTREAM_RELEASE_REPO}/releases/download/${tag}/omp-darwin-arm64`;
		expect(() => forkBuildFromRelease(withAsset(tag, upstream), tag, "omp-darwin-arm64", FORK_REPO)).toThrow(
			"unexpected download URL",
		);
	});

	it("rejects a release that is a draft, a prerelease, or missing the platform asset", () => {
		const tag = "collab-v18.8.9-3";
		const url = `https://github.com/${FORK_REPO}/releases/download/${tag}/omp-darwin-arm64`;
		const published = withAsset(tag, url);
		expect(() => forkBuildFromRelease({ ...published, draft: true }, tag, "omp-darwin-arm64", FORK_REPO)).toThrow(
			"draft",
		);
		expect(() =>
			forkBuildFromRelease({ ...published, prerelease: true }, tag, "omp-darwin-arm64", FORK_REPO),
		).toThrow("prerelease");
		expect(() => forkBuildFromRelease(published, tag, "omp-linux-x64", FORK_REPO)).toThrow("0 assets named");
	});

	it("resolves the newest published release from the listing", async () => {
		const older = "collab-v18.8.9-3";
		const newer = "collab-v18.10.3-1";
		const urlOf = (tag: string) => `https://github.com/${FORK_REPO}/releases/download/${tag}/omp-darwin-arm64`;
		const listing = [withAsset(older, urlOf(older)), withAsset(newer, urlOf(newer))];
		const requested: string[] = [];
		const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
			requested.push(String(input));
			return Response.json(listing);
		};
		const latest = await fetchLatestForkBuild(FORK_REPO, "omp-darwin-arm64", { fetchImpl, token: "t" });
		expect(requested).toEqual([`https://api.github.com/repos/${FORK_REPO}/releases?per_page=30`]);
		expect(latest.tag).toBe(newer);
		expect(latest.build.version).toBe("18.10.3");
		expect(latest.build.download).toBe(urlOf(newer));
	});

	it("points recovery at the fork's installer", () => {
		expect(forkInstallerHint(FORK_REPO)).toBe("curl -fsSL https://ctrlc03.github.io/oh-my-pi/install.sh | sh");
	});
});
