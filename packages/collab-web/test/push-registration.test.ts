import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { encodeBase64Url } from "../src/lib/link";
import { registrationFor } from "../src/lib/push";

const keyBytes = (fill: number): Uint8Array => new Uint8Array(65).fill(fill);
const KEY_A = encodeBase64Url(keyBytes(4));
const KEY_B = encodeBase64Url(keyBytes(5));

/** The slice of a ServiceWorkerRegistration `registrationFor` reads. */
function registration(
	name: string,
	subscription: { key: Uint8Array } | null,
): { registration: ServiceWorkerRegistration; name: string } {
	const fake = {
		name,
		active: { state: "activated", addEventListener: () => {} },
		installing: null,
		waiting: null,
		pushManager: {
			getSubscription: async () =>
				subscription === null ? null : { options: { applicationServerKey: subscription.key.buffer } },
		},
	};
	// The fake carries only the members the function reads.
	return { registration: fake as unknown as ServiceWorkerRegistration, name };
}

describe("which service worker registration a computer subscribes through", () => {
	const registered: { script: string; scope: string | undefined }[] = [];
	const original = Object.getOwnPropertyDescriptor(globalThis.navigator, "serviceWorker");

	beforeEach(() => {
		registered.length = 0;
		Object.defineProperty(globalThis.navigator, "serviceWorker", {
			configurable: true,
			value: {
				register: async (script: string, options?: RegistrationOptions) => {
					registered.push({ script, scope: options?.scope });
					return registration(`scoped ${options?.scope}`, null).registration;
				},
			},
		});
	});

	afterEach(() => {
		if (original) Object.defineProperty(globalThis.navigator, "serviceWorker", original);
		else Reflect.deleteProperty(globalThis.navigator, "serviceWorker");
	});

	it("keeps a subscription made before there were several computers on the page's own registration", async () => {
		const own = registration("own", { key: keyBytes(4) }).registration;
		expect(await registrationFor(own, "laptop", KEY_A)).toBe(own);
		expect(registered).toEqual([]);
	});

	it("gives every other computer its own scope, as a browser ties a subscription to one server key", async () => {
		const own = registration("own", { key: keyBytes(4) }).registration;
		const moonstone = await registrationFor(own, "moonstone", KEY_B);
		expect(moonstone).not.toBe(own);
		expect(registered).toEqual([{ script: "./sw.js", scope: "./push/moonstone/" }]);
	});

	it("uses a scope per computer when the page has no subscription", async () => {
		const own = registration("own", null).registration;
		await registrationFor(own, "laptop", KEY_A);
		await registrationFor(own, "moonstone", KEY_B);
		expect(registered.map(entry => entry.scope)).toEqual(["./push/laptop/", "./push/moonstone/"]);
	});
});
