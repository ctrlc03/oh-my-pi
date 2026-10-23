import { describe, expect, it } from "bun:test";
import type { VmEntry, VmReadiness } from "@oh-my-pi/pi-wire/vm";
import { renderToStaticMarkup } from "react-dom/server";
import { AddComputer } from "../src/components/shell/AddComputer";
import { EMPTY_VM_DRAFT, vmDraftOptions } from "../src/components/shell/VmCreateForm";
import { VmReadinessNote, VmRow, VmRows, vmActionsFor } from "../src/components/shell/VmSettings";
import { CompanionClient } from "../src/lib/companion";
import { generateRoomKey } from "../src/lib/codec";
import { formatCollabLink, generateRoomId } from "../src/lib/link";
import type { ComputerHandle } from "../src/lib/computers";

const READY: VmReadiness = {
	ok: true,
	drivers: { lima: "2.3.0", qemu: null },
	github: { configured: true, slug: "omp-vm", owners: ["acme"] },
	supervisor: true,
};

const NOT_SET_UP: VmReadiness = {
	ok: false,
	reason: "No GitHub App is set up for VMs yet.",
	drivers: { lima: "2.3.0", qemu: null },
	github: { configured: false },
	supervisor: false,
};

function vm(patch: Partial<VmEntry> = {}): VmEntry {
	return {
		name: "api",
		repos: ["acme/api"],
		cpus: 4,
		memoryGiB: 8,
		diskGiB: 60,
		network: "open",
		driver: "lima",
		status: "running",
		createdAt: 1,
		...patch,
	};
}

const noop = (): void => {};
const noopAsync = async (): Promise<void> => {};

function row(entry: VmEntry, patch: Partial<Parameters<typeof VmRow>[0]> = {}): string {
	return renderToStaticMarkup(
		<VmRow
			vm={entry}
			pending={false}
			confirming={null}
			error={null}
			onAction={noop}
			onConfirm={noop}
			onPair={noop}
			{...patch}
		/>,
	);
}

describe("VmReadinessNote", () => {
	it("says nothing while a VM can be created", () => {
		expect(renderToStaticMarkup(<VmReadinessNote ready={READY} />)).toBe("");
	});

	it("says what is missing, and which command sets up the GitHub App on which computer", () => {
		const html = renderToStaticMarkup(<VmReadinessNote ready={NOT_SET_UP} computerName="Studio" />);
		expect(html).toContain("No GitHub App is set up for VMs yet.");
		expect(html).toContain("<code>omp vm github setup</code>");
		expect(html).toContain("on Studio");
		expect(renderToStaticMarkup(<VmReadinessNote ready={NOT_SET_UP} />)).toContain("on the computer");
	});

	it("gives only the reason when the GitHub App is set up and something else is wrong", () => {
		const html = renderToStaticMarkup(
			<VmReadinessNote
				ready={{
					...READY,
					ok: false,
					reason: "Lima 2.3 or newer is required.",
					drivers: { lima: null, qemu: null },
				}}
			/>,
		);
		expect(html).toContain("Lima 2.3 or newer is required.");
		expect(html).not.toContain("omp vm github setup");
	});
});

describe("VmRows", () => {
	it("shows each VM's name, repositories, size, network and status", () => {
		const html = renderToStaticMarkup(
			<VmRows
				vms={[
					vm(),
					vm({
						name: "scratch",
						repos: ["acme/a", "acme/b", "acme/c"],
						status: "stopped",
						network: "allowlist",
						memoryGiB: 4,
					}),
				]}
				onAction={noopAsync}
				onPair={noopAsync}
			/>,
		);
		expect(html).toContain("api");
		expect(html).toContain("acme/api · 4 CPUs · 8 GiB · 60 GiB disk · open network");
		expect(html).toContain("Running");
		expect(html).toContain("acme/a, acme/b +1 · 4 CPUs · 4 GiB · 60 GiB disk · allowlist network");
		expect(html).toContain("Stopped");
	});

	it("offers Stop and Pair on a running VM and Start on a stopped one, Reset and Delete on both", () => {
		const running = row(vm());
		expect(running).toContain('aria-label="Stop api"');
		expect(running).toContain('aria-label="Pair api"');
		expect(running).toContain('aria-label="Reset api"');
		expect(running).toContain('aria-label="Delete api"');
		expect(running).not.toContain('aria-label="Start api"');
		const stopped = row(vm({ status: "stopped" }));
		expect(stopped).toContain('aria-label="Start api"');
		expect(stopped).not.toContain('aria-label="Stop api"');
		expect(stopped).not.toContain('aria-label="Pair api"');
		expect(stopped).toContain('aria-label="Reset api"');
	});

	it("shows what a running job is doing and holds the buttons until it is done", () => {
		const html = row(
			vm({ status: "creating", busy: { action: "create", step: "boot", message: "Booting the VM…" } }),
		);
		expect(html).toContain("Creating");
		expect(html).toContain("Booting the VM…");
		expect(html).toContain("<code>boot</code>");
		expect(html).toContain('role="status"');
		// Delete is the one action a VM that is still creating has, and it is held too.
		expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Delete api"/);
		expect(html).not.toContain('aria-label="Reset api"');
	});

	it("holds the buttons while a request about the VM is on its way", () => {
		const html = row(vm(), { pending: true });
		expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Stop api"/);
	});

	it("shows why a VM failed", () => {
		const html = row(vm({ status: "failed", error: "Lima could not start the instance" }));
		expect(html).toContain("Failed");
		expect(html).toContain("Lima could not start the instance");
		expect(html).toContain('aria-label="Reset api"');
		expect(html).toContain('aria-label="Delete api"');
	});

	it("shows an error from the last request on the row", () => {
		expect(row(vm(), { error: "api is busy (stopping); wait for it to finish" })).toContain("api is busy (stopping)");
	});

	it("asks before deleting and before resetting, saying what is lost", () => {
		const deleting = row(vm(), { confirming: "delete" });
		expect(deleting).toContain('role="alertdialog"');
		expect(deleting).toContain("Delete removes the VM and its disk");
		expect(deleting).toContain("Delete api");
		expect(deleting).toContain("Cancel");
		expect(deleting).not.toContain('aria-label="Stop api"');
		const resetting = row(vm(), { confirming: "reset" });
		expect(resetting).toContain("Reset recreates the VM");
		expect(resetting).toContain("Reset api");
	});
});

describe("vmActionsFor", () => {
	it("offers what a status allows", () => {
		expect(vmActionsFor("running")).toEqual({ start: false, stop: true, pair: true, reset: true });
		expect(vmActionsFor("stopped")).toEqual({ start: true, stop: false, pair: false, reset: true });
		expect(vmActionsFor("creating")).toEqual({ start: false, stop: false, pair: false, reset: false });
		expect(vmActionsFor("failed").reset).toBe(true);
	});
});

describe("the New VM form's request", () => {
	const draft = (patch: Partial<typeof EMPTY_VM_DRAFT>) => vmDraftOptions({ ...EMPTY_VM_DRAFT, ...patch });

	it("reads repositories one per line, from names, addresses and URLs, without repeats", () => {
		const result = draft({
			name: " my-project ",
			repos: "acme/api\nhttps://github.com/acme/web.git\ngit@github.com:acme/docs.git\nacme/api\n",
		});
		expect(result).toEqual({
			options: {
				name: "my-project",
				repos: ["acme/api", "acme/web", "acme/docs"],
				cpus: 4,
				memoryGiB: 8,
				diskGiB: 60,
				network: "open",
				dailyCostUsd: undefined,
			},
		});
	});

	it("sends the size, network and daily cost that were typed", () => {
		expect(
			draft({
				name: "a",
				repos: "x/y",
				cpus: "2",
				memoryGiB: "16",
				diskGiB: "100",
				network: "allowlist",
				dailyCostUsd: "2.5",
			}),
		).toEqual({
			options: {
				name: "a",
				repos: ["x/y"],
				cpus: 2,
				memoryGiB: 16,
				diskGiB: 100,
				network: "allowlist",
				dailyCostUsd: 2.5,
			},
		});
	});

	it("names the first problem", () => {
		expect(draft({ name: "Bad", repos: "x/y" })).toHaveProperty("problem", expect.stringContaining("name"));
		expect(draft({ name: "ok", repos: "" })).toHaveProperty("problem", expect.stringContaining("repository"));
		expect(draft({ name: "ok", repos: "nonsense" })).toHaveProperty("problem", expect.stringContaining("owner/repo"));
		expect(draft({ name: "ok", repos: "a/b\nc/d" })).toHaveProperty(
			"problem",
			expect.stringContaining("one GitHub owner"),
		);
		expect(draft({ name: "ok", repos: "a/b", cpus: "0" })).toHaveProperty("problem", expect.stringContaining("CPUs"));
		expect(draft({ name: "ok", repos: "a/b", memoryGiB: "x" })).toHaveProperty(
			"problem",
			expect.stringContaining("Memory"),
		);
		expect(draft({ name: "ok", repos: "a/b", dailyCostUsd: "-1" })).toHaveProperty(
			"problem",
			expect.stringContaining("cost"),
		);
	});
});

describe("AddComputer", () => {
	function computer(id: string, patch: { canVms: boolean; phase?: "live" | "offline" }): ComputerHandle {
		const client = new CompanionClient(
			{ link: formatCollabLink("https://relay.invalid", generateRoomId(), generateRoomKey()) },
			() => {},
		);
		return {
			id,
			name: id,
			client,
			snap: { ...client.getSnapshot(), phase: patch.phase ?? "live", canVms: patch.canVms },
			error: null,
		};
	}

	it("offers a New virtual machine button when a connected computer can run VMs", () => {
		const html = renderToStaticMarkup(
			<AddComputer onPair={noop} computers={[computer("studio", { canVms: true })]} />,
		);
		expect(html).toContain("New virtual machine");
		expect(html).toContain("Add computer");
	});

	it("does not when no computer can, or the one that can is not connected", () => {
		expect(renderToStaticMarkup(<AddComputer onPair={noop} />)).not.toContain("New virtual machine");
		expect(
			renderToStaticMarkup(<AddComputer onPair={noop} computers={[computer("old", { canVms: false })]} />),
		).not.toContain("New virtual machine");
		expect(
			renderToStaticMarkup(
				<AddComputer onPair={noop} computers={[computer("away", { canVms: true, phase: "offline" })]} />,
			),
		).not.toContain("New virtual machine");
	});
});
