/** Thrown by a backend's `clear` when it must not delete what it holds (Mnemopi under `mnemopi.retention: permanent`). */
export class MemoryClearRefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MemoryClearRefusedError";
	}
}
