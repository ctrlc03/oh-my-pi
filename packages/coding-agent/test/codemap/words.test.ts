import { describe, expect, it } from "bun:test";
import { queryWords, splitWords } from "../../src/codemap/words";

describe("splitWords", () => {
	it("splits PascalCase, acronyms, snake_case, paths, and digit runs", () => {
		expect(splitWords("E3Requested")).toEqual(["e", "3", "requested"]);
		expect(splitWords("HTTPServer_v2")).toEqual(["http", "server", "v", "2"]);
		expect(splitWords("crates/sortition/ciphernode_selection.rs")).toEqual([
			"crates",
			"sortition",
			"ciphernode",
			"selection",
			"rs",
		]);
	});

	it("drops stopwords and repeats from queries", () => {
		expect(queryWords("how the decryption share share aggregation")).toEqual(["decryption", "share", "aggregation"]);
	});
});
