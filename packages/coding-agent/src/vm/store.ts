import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { getVmRoot, vmDir, vmRecordPath, vmsDir } from "./paths";
import { VM_NAME_PATTERN, type VmRecord } from "./types";

/** Writes `text` to `file` through a temporary file and a rename, with `mode`. */
export async function writeFileAtomic(file: string, text: string, mode = 0o600): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
	await fs.writeFile(temp, text, { mode });
	await fs.chmod(temp, mode);
	await fs.rename(temp, file);
}

export function assertVmName(name: string): void {
	if (!VM_NAME_PATTERN.test(name)) {
		throw new Error(
			`invalid VM name "${name}": use a lower-case letter, then up to 30 lower-case letters, digits or dashes`,
		);
	}
}

export async function readVmRecord(name: string, root = getVmRoot()): Promise<VmRecord | null> {
	try {
		return parseVmRecord(await fs.readFile(vmRecordPath(name, root), "utf8"));
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
}

export async function writeVmRecord(record: VmRecord, root = getVmRoot()): Promise<void> {
	assertVmName(record.name);
	await writeFileAtomic(vmRecordPath(record.name, root), `${JSON.stringify(record, null, "\t")}\n`);
}

/** Every VM with a readable record, sorted by name. Unreadable records are skipped. */
export async function listVmRecords(root = getVmRoot()): Promise<VmRecord[]> {
	let entries: string[];
	try {
		entries = await fs.readdir(vmsDir(root));
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
	const records: VmRecord[] = [];
	for (const entry of entries.sort()) {
		if (!VM_NAME_PATTERN.test(entry)) continue;
		try {
			const record = await readVmRecord(entry, root);
			if (record) records.push(record);
		} catch {
			// A half-written or foreign file: not a VM this version can manage.
		}
	}
	return records;
}

export async function removeVmDir(name: string, root = getVmRoot()): Promise<void> {
	assertVmName(name);
	await fs.rm(vmDir(name, root), { recursive: true, force: true });
}

function parseVmRecord(text: string): VmRecord {
	const value = JSON.parse(text) as VmRecord;
	if (value?.version !== 1 || typeof value.name !== "string" || !Array.isArray(value.repos)) {
		throw new Error("not a VM record");
	}
	return value;
}
