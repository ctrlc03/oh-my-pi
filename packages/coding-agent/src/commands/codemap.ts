/**
 * Persistent code index: build it, inspect it, trace symbols through it.
 */

import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { CODEMAP_ACTIONS, type CodemapAction, runCodemapCommand } from "../cli/codemap-cli";
import { codemapHelp as commandHelp } from "../cli/command-help";

export default class Codemap extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "build, stats, trace, search, or flow",
			required: true,
			options: [...CODEMAP_ACTIONS],
		}),
		first: Args.string({
			description: "build/stats: PATH; trace: SYMBOL; search: WORDS; flow: QUESTION",
			required: false,
		}),
		second: Args.string({
			description: "trace/search/flow: PATH of the repository root (default: .)",
			required: false,
		}),
	};
	static flags = {
		depth: Flags.integer({ description: "trace: follow event and caller chains this deep (1-3)", default: 1 }),
		from: Flags.string({ description: "flow: symbol to start from instead of discovering entry points" }),
		hops: Flags.integer({ description: "flow: edges to follow from the entry points (1-8)", default: 5 }),
		json: Flags.boolean({ description: "Emit the result as JSON" }),
	};
	static examples = [
		"omp codemap build ~/src/repo",
		"omp codemap stats ~/src/repo",
		"omp codemap trace CommitteeFinalized ~/src/repo --depth 2",
		'omp codemap search "decryption share aggregation" ~/src/repo',
		'omp codemap flow "what happens after the committee is finalized on-chain?" ~/src/repo --hops 6',
		'omp codemap flow "how does a finalized committee reach the keyshare nodes?" ~/src/repo --from SortitionCommitteeFinalized',
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Codemap);
		await runCodemapCommand({
			action: args.action as CodemapAction,
			first: args.first,
			second: args.second,
			depth: flags.depth,
			from: flags.from,
			hops: flags.hops,
			json: flags.json ?? false,
		});
	}
}
