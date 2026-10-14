import { describe, expect, it } from "bun:test";
import type { BakeoffReply, BakeoffRequest } from "@oh-my-pi/pi-wire/bakeoff";
import type { BakeoffAnswerOf, BakeoffCall, CompanionReply, CompanionRequest } from "../src/lib/companion";

/** True only when `A` and `B` are the same type. */
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** Compiles only when `T` is `true`. */
function assertType<T extends true>(): T | undefined {
	return undefined;
}

// Every wire request and reply is part of what the app sends and receives, and nothing is lost on the way.
assertType<Same<Extract<CompanionRequest, { t: BakeoffRequest["t"] }>, BakeoffRequest>>();
assertType<Same<Extract<CompanionReply, { t: BakeoffReply["t"] }>, BakeoffReply>>();
assertType<BakeoffRequest extends CompanionRequest ? true : false>();
assertType<BakeoffReply extends CompanionReply ? true : false>();

// A call is a request without its `reqId`, and the answer of a call is the reply of the same type.
assertType<Same<BakeoffCall["t"], BakeoffRequest["t"]>>();
assertType<Same<keyof Extract<BakeoffCall, { t: "bakeoff-get" }>, "t" | "id">>();
assertType<Same<BakeoffAnswerOf<"bakeoff-get">, Extract<BakeoffReply, { t: "bakeoff-get" }>>>();
assertType<Same<BakeoffAnswerOf<"bakeoff-create">, { t: "bakeoff-create"; reqId: number; id: string }>>();
assertType<Same<BakeoffAnswerOf<"bakeoff-stop">, { t: "bakeoff-stop"; reqId: number }>>();
assertType<Same<BakeoffAnswerOf<BakeoffRequest["t"]>, Exclude<BakeoffReply, { t: "bakeoff-changed" }>>>();

const REQUESTS = {
	"bakeoff-list": { t: "bakeoff-list", reqId: 1, cwd: "/repo" },
	"bakeoff-judge": { t: "bakeoff-judge", reqId: 2 },
	"bakeoff-create": {
		t: "bakeoff-create",
		reqId: 3,
		cwd: "/repo",
		mode: "design",
		ref: "feature/x",
		metrics: [{ id: "simplicity", label: "Simplicity", weight: 3 }],
		models: ["a/b", "c/d"],
		reviewer: "e/f",
	},
	"bakeoff-get": { t: "bakeoff-get", reqId: 4, id: "b1" },
	"bakeoff-excerpt": { t: "bakeoff-excerpt", reqId: 5, id: "b1", entry: "A", refs: [] },
	"bakeoff-stop": { t: "bakeoff-stop", reqId: 6, id: "b1", entry: "B" },
	"bakeoff-take": { t: "bakeoff-take", reqId: 7, id: "b1", entry: "A", removeOthers: true },
	"bakeoff-delete": { t: "bakeoff-delete", reqId: 8, id: "b1" },
	"bakeoff-review": { t: "bakeoff-review", reqId: 9, id: "b1" },
} satisfies { [T in BakeoffRequest["t"]]: Extract<CompanionRequest, { t: T }> };

const REPLIES = {
	"bakeoff-list": { t: "bakeoff-list", reqId: 1, bakeoffs: [] },
	"bakeoff-judge": { t: "bakeoff-judge", reqId: 2, judge: { state: "none" } },
	"bakeoff-create": { t: "bakeoff-create", reqId: 3, id: "b1" },
	"bakeoff-excerpt": { t: "bakeoff-excerpt", reqId: 5, excerpts: [null] },
	"bakeoff-stop": { t: "bakeoff-stop", reqId: 6 },
	"bakeoff-take": { t: "bakeoff-take", reqId: 7, result: { removed: [], skipped: [] } },
	"bakeoff-delete": { t: "bakeoff-delete", reqId: 8 },
	"bakeoff-review": { t: "bakeoff-review", reqId: 9 },
	"bakeoff-changed": { t: "bakeoff-changed", id: "b1" },
} satisfies { [T in Exclude<BakeoffReply["t"], "bakeoff-get">]: Extract<CompanionReply, { t: T }> };

describe("the bake-off wire modules in the app's protocol", () => {
	it("has a sample request for every bake-off request type, as the app would send it", () => {
		for (const [type, sample] of Object.entries(REQUESTS)) expect(sample.t).toBe(type as keyof typeof REQUESTS);
		expect(Object.keys(REQUESTS)).toHaveLength(9);
	});

	it("has a sample reply for every bake-off reply type; only the push carries no reqId", () => {
		for (const [type, sample] of Object.entries(REPLIES)) {
			expect(sample.t).toBe(type as keyof typeof REPLIES);
			expect("reqId" in sample).toBe(type !== "bakeoff-changed");
		}
	});

	it("turns a request into a call by dropping its reqId, and answers it with the reply of the same type", () => {
		const { reqId: _reqId, ...call } = REQUESTS["bakeoff-get"];
		const callTyped: BakeoffCall = call;
		const answer: BakeoffAnswerOf<typeof callTyped.t> = { t: "bakeoff-get", reqId: 4, bakeoff: {} as never };
		expect(callTyped).toEqual({ t: "bakeoff-get", id: "b1" });
		expect(answer.t).toBe(callTyped.t);
	});
});
