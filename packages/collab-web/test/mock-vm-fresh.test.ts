import { describe, expect, it } from "bun:test";
import { VM_MAX_FRESH, type VmEntry } from "@oh-my-pi/pi-wire/vm";
import { createMockVm, type MockGuest } from "../scripts/mock-vm";

/** The mock with steps that take no time; `guests` are the companions its clones started. */
function setup(options: { guest?: boolean } = {}) {
	const guests: Array<MockGuest & { exit(): void; stopped: boolean }> = [];
	const waiting = new Set<() => void>();
	/** Resolves at the mock's next change (a job finished, a clone left). */
	const nextChange = (): Promise<void> => {
		const { promise, resolve } = Promise.withResolvers<void>();
		const wake = (): void => {
			waiting.delete(wake);
			resolve();
		};
		waiting.add(wake);
		return promise;
	};
	const vm = createMockVm({
		home: "/home/ubuntu",
		sleep: async () => {},
		pairUrl: () => "https://my.omp.sh/#pair:plain",
		onChange: () => {
			for (const wake of [...waiting]) wake();
		},
		guest:
			options.guest === false
				? undefined
				: async clone => {
						const { promise, resolve } = Promise.withResolvers<void>();
						const guest = {
							pairUrl: `https://my.omp.sh/#pair:${clone.name}`,
							exited: promise,
							stopped: false,
							exit: resolve,
							stop() {
								guest.stopped = true;
								resolve();
							},
						};
						guests.push(guest);
						return guest;
					},
	});
	let reqId = 0;
	const list = async (): Promise<VmEntry[]> => {
		const reply = await vm.answer({ t: "vm-list", reqId: ++reqId });
		if (reply.t !== "vm-list") throw new Error("not a list");
		return reply.vms;
	};
	const settle = async (): Promise<void> => {
		for (;;) {
			const changed = nextChange();
			if (!(await list()).some(entry => entry.busy !== undefined)) return;
			await changed;
		}
	};
	const clone = (template: string, name: string) => vm.answer({ t: "vm-clone", reqId: ++reqId, template, name });
	return { vm, guests, nextChange, list, settle, clone };
}

describe("the mock's templates and fresh VMs", () => {
	it("lists a canned template with its home, and builds a template that stays stopped and unpaired", async () => {
		const { vm, list, settle } = setup();
		expect((await list()).find(entry => entry.name === "web-template")).toMatchObject({
			template: true,
			status: "stopped",
			home: "/home/ubuntu",
			repos: ["acme/web"],
		});
		await vm.answer({ t: "vm-create", reqId: 1, name: "api-template", repos: ["acme/api"], template: true });
		await settle();
		const built = (await list()).find(entry => entry.name === "api-template");
		expect(built).toMatchObject({ template: true, status: "stopped" });
		expect(built?.pairUrl).toBeUndefined();
		await expect(vm.answer({ t: "vm-pair", reqId: 2, name: "api-template" })).rejects.toThrow("template");
	});

	it("clones a template: progress while it runs, then a running fresh VM with its companion's link", async () => {
		const { list, settle, clone, guests } = setup();
		expect(await clone("web-template", "web-template-1a2b")).toEqual({
			t: "vm-clone",
			reqId: expect.any(Number),
			accepted: true,
		});
		expect((await list()).find(entry => entry.name === "web-template-1a2b")).toMatchObject({
			status: "creating",
			busy: { action: "clone" },
			fresh: { from: "web-template" },
			home: "/home/ubuntu",
		});
		await settle();
		const fresh = (await list()).find(entry => entry.name === "web-template-1a2b");
		expect(fresh).toMatchObject({ status: "running", pairUrl: "https://my.omp.sh/#pair:web-template-1a2b" });
		expect(fresh?.template).toBeUndefined();
		expect(guests).toHaveLength(1);
	});

	it("removes the clone when its companion exits, and stops the companion when the clone is deleted", async () => {
		const { vm, list, settle, clone, guests, nextChange } = setup();
		await clone("web-template", "web-template-aaaa");
		await clone("web-template", "web-template-bbbb");
		await settle();
		const left = nextChange();
		guests[0]?.exit();
		await left;
		expect((await list()).map(entry => entry.name)).not.toContain("web-template-aaaa");

		await vm.answer({ t: "vm-action", reqId: 50, name: "web-template-bbbb", action: "delete" });
		await settle();
		expect(guests[1]?.stopped).toBe(true);
		expect((await list()).map(entry => entry.name)).not.toContain("web-template-bbbb");
	});

	it("refuses what the CLI refuses: not a template, a running template, a taken name, too many fresh VMs", async () => {
		const { vm, list, settle, clone } = setup();
		await expect(clone("scratch", "scratch-1a2b")).rejects.toThrow("not a template");
		await expect(clone("ghost", "ghost-1a2b")).rejects.toThrow("no VM named ghost");
		await expect(clone("web-template", "scratch")).rejects.toThrow("already exists");
		await expect(clone("web-template", "Bad Name")).rejects.toThrow("invalid VM name");

		for (let n = 0; n < VM_MAX_FRESH; n++) await clone("web-template", `web-template-000${n}`);
		await expect(clone("web-template", "web-template-ffff")).rejects.toThrow("fresh VMs already exist");
		await settle();

		await vm.answer({ t: "vm-action", reqId: 70, name: "web-template-0000", action: "delete" });
		await settle();
		await vm.answer({ t: "vm-action", reqId: 71, name: "web-template", action: "start" });
		await settle();
		expect((await list()).find(entry => entry.name === "web-template")?.status).toBe("running");
		await expect(clone("web-template", "web-template-eeee")).rejects.toThrow("stopped");
	});
});
