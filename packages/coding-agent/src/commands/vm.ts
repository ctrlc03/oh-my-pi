/**
 * `omp vm` — per-repository Linux VMs that pair with your devices as their own computers.
 */
import { Args, CliUsageError, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { vmHelp as commandHelp } from "../cli/command-help";
import { runVmCommand, VM_ACTIONS, type VmAction } from "../vm/cli";

function number(value: string | undefined, flag: string): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) throw new CliUsageError(`${flag} takes a number, not "${value}"`);
	return parsed;
}

export default class Vm extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({ description: "Sub-command", required: false, options: [...VM_ACTIONS] }),
		rest: Args.string({
			description: "VM name (github: setup, status, or protect <owner/repo>)",
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Machine-readable output (NDJSON progress for long actions)" }),
		repo: Flags.string({ description: "Repository to clone, owner/repo (create; repeatable)", multiple: true }),
		cpus: Flags.integer({ description: "Virtual CPUs (create; default 4)" }),
		memory: Flags.string({ description: "Memory in GiB (create; default 8)" }),
		disk: Flags.integer({ description: "Disk in GiB (create; default 40)" }),
		network: Flags.string({
			description: "open: direct internet; allowlist: listed hosts only, through a host proxy (create)",
			options: ["open", "allowlist"],
		}),
		"allow-host": Flags.string({
			description: "Extra host the VM may reach in allowlist mode, exact or *.suffix (create; repeatable)",
			multiple: true,
		}),
		model: Flags.string({
			description: "Model the VM may use, provider/id or provider/* (create; repeatable; default all)",
			multiple: true,
		}),
		"daily-tokens": Flags.integer({ description: "Daily token budget for the VM's model calls (create)" }),
		"daily-cost": Flags.string({ description: "Daily cost budget in USD for the VM's model calls (create)" }),
		owner: Flags.string({ description: "Organization that owns the GitHub App (github setup)" }),
		"app-id": Flags.integer({ description: "Adopt an existing GitHub App by id (github setup)" }),
		key: Flags.string({ description: "Private key file of that App (github setup --app-id)" }),
		yes: Flags.boolean({ description: "Do not ask for confirmation (github protect)" }),
		"idle-exit": Flags.boolean({ description: "Stop after 5 minutes without any VM (serve)" }),
	};

	static examples = [
		"# Check what is installed and set up\n  omp vm init",
		"# Create the GitHub App VMs push with (once per computer)\n  omp vm github setup",
		"# A VM for one repository, paired as a new computer\n  omp vm create api --repo acme/api",
		"# Bigger, internet limited to an allowlist, with a daily budget\n  omp vm create web --repo acme/web --cpus 8 --memory 16 --network allowlist --daily-cost 20",
		"# Lifecycle\n  omp vm list\n  omp vm stop api\n  omp vm start api\n  omp vm reset api\n  omp vm delete api",
		"# A shell inside the VM\n  omp vm shell api",
		"# A fresh pairing link for another device\n  omp vm pair api",
		"# Protect a repository's default branch and release tags from VM pushes\n  omp vm github protect acme/api",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Vm);
		if (!args.action) {
			renderCommandHelp("omp", "vm", Vm);
			return;
		}
		await runVmCommand(args.action as VmAction, args.rest ?? [], {
			json: flags.json,
			repo: flags.repo,
			cpus: flags.cpus,
			memory: number(flags.memory, "--memory"),
			disk: flags.disk,
			network: flags.network,
			allowHost: flags["allow-host"],
			model: flags.model,
			dailyTokens: flags["daily-tokens"],
			dailyCost: number(flags["daily-cost"], "--daily-cost"),
			owner: flags.owner,
			appId: flags["app-id"],
			key: flags.key,
			yes: flags.yes,
			idleExit: flags["idle-exit"],
		});
	}
}
