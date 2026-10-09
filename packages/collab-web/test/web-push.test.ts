import { describe, expect, it } from "bun:test";
import { decodeBase64Url, encodeBase64Url } from "../src/lib/link";
import { encryptPushPayload, generateVapidKeys, vapidAuthorization } from "../scripts/web-push";

const b = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(decodeBase64Url(text) as Uint8Array);

// RFC 8291 §5 example.
const RFC = {
	plaintext: "When I grow up, I want to be a watermelon",
	asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
	asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
	uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
	salt: "DGv6ra1nlYgDCS1FRnbzlw",
	auth: "BTBZMqHH6r4Tts7J_aSIgg",
	body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

async function rfcServerKeys(): Promise<CryptoKeyPair> {
	const pub = b(RFC.asPublic);
	const jwk: JsonWebKey = {
		kty: "EC",
		crv: "P-256",
		x: encodeBase64Url(pub.subarray(1, 33)),
		y: encodeBase64Url(pub.subarray(33, 65)),
		d: RFC.asPrivate,
	};
	const curve = { name: "ECDH", namedCurve: "P-256" };
	return {
		privateKey: await crypto.subtle.importKey("jwk", jwk, curve, true, ["deriveBits"]),
		publicKey: await crypto.subtle.importKey("raw", pub, curve, true, []),
	};
}

describe("encryptPushPayload", () => {
	it("matches the RFC 8291 aes128gcm example byte for byte", async () => {
		const body = await encryptPushPayload(
			{ p256dh: RFC.uaPublic, auth: RFC.auth },
			new TextEncoder().encode(RFC.plaintext),
			{ salt: b(RFC.salt), serverKeys: await rfcServerKeys() },
		);
		expect(encodeBase64Url(body)).toBe(RFC.body);
	});
});

describe("vapidAuthorization", () => {
	it("signs an ES256 JWT for the push service origin that verifies with the advertised key", async () => {
		const vapid = await generateVapidKeys();
		const header = await vapidAuthorization("https://web.push.apple.com/abc?x=1", vapid, "https://example.test/");
		const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
		expect(match).not.toBeNull();
		const [, head, claims, sig, k] = match as RegExpExecArray;
		expect(k).toBe(vapid.publicKey);
		const decoded = JSON.parse(new TextDecoder().decode(b(claims as string))) as { aud: string; exp: number };
		expect(decoded.aud).toBe("https://web.push.apple.com");
		expect(decoded.exp).toBeGreaterThan(Date.now() / 1000);
		const key = await crypto.subtle.importKey(
			"raw",
			b(vapid.publicKey),
			{ name: "ECDSA", namedCurve: "P-256" },
			false,
			["verify"],
		);
		const ok = await crypto.subtle.verify(
			{ name: "ECDSA", hash: "SHA-256" },
			key,
			b(sig as string),
			new TextEncoder().encode(`${head}.${claims}`),
		);
		expect(ok).toBe(true);
	});
});
