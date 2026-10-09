import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Codemap, runFlow } from "../../src/codemap";
import { isTestPath } from "../../src/codemap/rows";

const SOLIDITY = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Registry {
	event CommitteeSealed(uint256 indexed e3Id);
	event CommitteeOther(uint256 indexed e3Id);

	function sealCommittee(uint256 e3Id) external {
		emit CommitteeSealed(e3Id);
	}

	function transfer(address to) external {}

	function validateState(uint256 e3Id) external {}
}
`;

// The event is re-declared in a `sol!` block (not extracted); the decoder names it through multi-segment paths.
const RUST = `sol! {
	interface IRegistry {
		event CommitteeSealed(uint256 e3Id);
	}
}

pub struct CommitteeSealedWithChainId(pub IRegistry::CommitteeSealed, pub u64);

pub struct CommitteeFinalized {
	pub e3_id: u64,
}

pub enum Data {
	Finalized(CommitteeFinalized),
}

impl From<CommitteeSealedWithChainId> for CommitteeFinalized {
	fn from(value: CommitteeSealedWithChainId) -> Self {
		CommitteeFinalized { e3_id: 1 }
	}
}

impl From<CommitteeSealedWithChainId> for Data {
	fn from(value: CommitteeSealedWithChainId) -> Self {
		Data::Finalized(value.into())
	}
}

pub fn extractor(data: &LogData, topics: &[B256], chain_id: u64) -> Option<Data> {
	match topics.first() {
		Some(&IRegistry::CommitteeSealed::SIGNATURE_HASH) => {
			let Ok(event) = IRegistry::CommitteeSealed::decode_log_data(data) else {
				return None;
			};
			Some(Data::from(CommitteeSealedWithChainId(event, chain_id)))
		}
		_ => None,
	}
}

// Holds two events: state, not the wrapper of either decode, so its method return types are not conversions.
pub struct Projection {
	sealed: HashMap<u64, IRegistry::CommitteeSealed>,
	other: Vec<IRegistry::CommitteeOther>,
}

pub struct Ids(pub u64);

impl Projection {
	pub fn confirmed(&self) -> Ids {
		Ids(1)
	}

	pub fn validateState(&self) -> bool {
		true
	}
}

pub fn check(p: &Projection) -> bool {
	p.validateState()
}

pub fn seal(contract: &Contract) {
	contract.sealCommittee(1);
	contract.transfer(2);
}
`;

let root: string;
let cacheDir: string;
const previousCache = process.env.OMP_JUDGMENT_CACHE_DB;

beforeAll(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codemap-bridges-")));
	cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "codemap-cache-"));
	process.env.OMP_JUDGMENT_CACHE_DB = path.join(cacheDir, "judgment-cache.db");
	fs.mkdirSync(path.join(root, "contracts"));
	fs.mkdirSync(path.join(root, "crates/evm/src"), { recursive: true });
	fs.writeFileSync(path.join(root, "contracts/Registry.sol"), SOLIDITY);
	fs.writeFileSync(path.join(root, "crates/evm/src/events.rs"), RUST);
});

afterAll(() => {
	if (previousCache === undefined) delete process.env.OMP_JUDGMENT_CACHE_DB;
	else process.env.OMP_JUDGMENT_CACHE_DB = previousCache;
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(cacheDir, { recursive: true, force: true });
});

describe("cross-language bridges", () => {
	it("links a Solidity event to its Rust decoder and the struct it becomes, ranking structs over enums", async () => {
		const codemap = await Codemap.open(root, { cwd: root });
		try {
			const result = codemap.query.trace("CommitteeSealed", 3);
			const heading = (name: string) => result.sections.find(section => section.heading.startsWith(name));
			expect(heading("Emitted by")?.items.map(site => site.name)).toEqual(["Registry.sealCommittee"]);
			const decoded = heading("Decoded by")?.items ?? [];
			expect(decoded.map(site => site.name)).toEqual(["extractor"]);
			expect(decoded[0]?.note).toContain("decoder");
			// The wrapper is the bridge, never the target; the struct leads the enum.
			expect(heading("Becomes")?.items.map(site => site.name)).toEqual(["CommitteeFinalized", "Data"]);
			expect(decoded.map(site => site.name)).not.toContain("Projection");

			const chain = result.tree?.roots[0];
			const decoder = chain?.children.find(child => child.text.startsWith("decoded by"));
			expect(decoder?.children.map(child => child.text.split(" (")[0])).toEqual([
				"becomes CommitteeFinalized",
				"becomes Data",
			]);
			expect(chain?.children.find(child => child.text.startsWith("emitted by"))?.children[0]?.text).toBe(
				"called from Rust seal",
			);
		} finally {
			codemap.close();
		}
	});

	it("shows Rust callers of a Solidity function but not of a generic name", async () => {
		const codemap = await Codemap.open(root, { cwd: root });
		try {
			const sealed = codemap.query.trace("sealCommittee", 1);
			expect(sealed.sections.find(s => s.heading.startsWith("Called from Rust"))?.items.map(s => s.name)).toEqual([
				"seal",
			]);
			expect(sealed.sections.some(s => s.heading.startsWith("Callers"))).toBe(false);

			// Rust defines `validateState` itself, so a call to it is not a contract call.
			const validate = codemap.query.trace("validateState", 1);
			expect(validate.sections.some(s => s.heading.startsWith("Called from Rust"))).toBe(false);
			expect(codemap.query.trace("check", 1).sections.some(s => s.heading === "Calls contract")).toBe(false);

			const generic = codemap.query.trace("transfer", 1);
			expect(generic.sections.some(s => s.heading.startsWith("Called from Rust"))).toBe(false);
			expect(generic.sections.find(s => s.heading.startsWith("Callers"))?.items.map(s => s.name)).toEqual(["seal"]);

			const rust = codemap.query.trace("seal", 1);
			expect(rust.sections.find(s => s.heading === "Calls contract")?.items.map(s => s.name)).toEqual([
				"Registry.sealCommittee",
			]);
		} finally {
			codemap.close();
		}
	});

	it("walks emitter, decoder, and internal type in a structural flow from the event", async () => {
		const codemap = await Codemap.open(root, { cwd: root });
		try {
			const flow = await runFlow(codemap, {
				question: "what happens when a committee is sealed",
				from: "CommitteeSealed",
			});
			expect(flow.mode).toBe("structural");
			const reached = flow.steps.map(step => `${step.label ?? "entry"}:${step.node.name}`);
			expect(reached).toContain("emitted by:Registry.sealCommittee");
			expect(reached).toContain("decoded by:extractor");
			expect(reached).toContain("becomes:CommitteeFinalized");
			expect(reached).toContain("called from Rust:seal");
		} finally {
			codemap.close();
		}
	});
});

describe("isTestPath", () => {
	it("matches test directories and file affixes but not words that contain `test`", () => {
		for (const rel of [
			"crates/evm/src/tests.rs",
			"pkg/test/a.sol",
			"a/__tests__/x.ts",
			"src/foo.test.ts",
			"src/foo_test.go",
			"contracts/A.t.sol",
		]) {
			expect(isTestPath(rel)).toBe(true);
		}
		for (const rel of [
			"contracts/DkgFoldAttestationVerifier.sol",
			"src/VotesToken.sol",
			"src/testnet/config.rs",
			"crates/attestation/mod.rs",
		]) {
			expect(isTestPath(rel)).toBe(false);
		}
	});
});
