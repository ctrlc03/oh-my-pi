/**
 * Minimal Web Push sender for the companion: RFC 8291 message encryption
 * (`aes128gcm`, RFC 8188) and RFC 8292 VAPID, on WebCrypto only. Push services
 * (Apple, Google, Mozilla) accept these requests straight from this machine, so
 * notifications need no server of our own.
 */

import type { PushSubscriptionJson } from "../src/lib/companion";
import { decodeBase64Url, encodeBase64Url } from "../src/lib/link";

export interface VapidKeys {
	/** Uncompressed P-256 point, base64url: the app's `applicationServerKey`. */
	publicKey: string;
	privateJwk: JsonWebKey;
}

const TEXT = new TextEncoder();
/** Record size advertised in the header; one record always fits a notification. */
const RECORD_SIZE = 4096;
const VAPID_TTL_S = 12 * 60 * 60;

export function isPushSubscription(value: unknown): value is PushSubscriptionJson {
	if (typeof value !== "object" || value === null) return false;
	const v = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
	return (
		typeof v.endpoint === "string" &&
		v.endpoint.startsWith("https://") &&
		typeof v.keys?.p256dh === "string" &&
		typeof v.keys.auth === "string"
	);
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.byteLength;
	}
	return out;
}

function decode(text: string, what: string): Uint8Array<ArrayBuffer> {
	const bytes = decodeBase64Url(text);
	if (!bytes) throw new Error(`invalid base64url ${what}`);
	return concat(bytes);
}

async function hkdf(
	salt: Uint8Array<ArrayBuffer>,
	ikm: Uint8Array<ArrayBuffer>,
	info: Uint8Array<ArrayBuffer>,
	bytes: number,
) {
	const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
	return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

export async function generateVapidKeys(): Promise<VapidKeys> {
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
	const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
	return { publicKey: encodeBase64Url(raw), privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey) };
}

/**
 * Encrypt `plaintext` for one subscription (RFC 8291 §3–4): a single
 * `aes128gcm` record keyed from ECDH between a fresh server key pair and the
 * browser's `p256dh` key, salted with its `auth` secret. `salt` and
 * `serverKeys` are injectable for the RFC test vector only.
 */
export async function encryptPushPayload(
	keys: PushSubscriptionJson["keys"],
	plaintext: Uint8Array,
	fixed?: { salt: Uint8Array; serverKeys: CryptoKeyPair },
): Promise<Uint8Array<ArrayBuffer>> {
	const uaPublic = decode(keys.p256dh, "p256dh");
	const authSecret = decode(keys.auth, "auth");
	const serverKeys =
		fixed?.serverKeys ??
		(await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]));
	const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", serverKeys.publicKey));
	const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
	const ecdhSecret = new Uint8Array(
		await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, serverKeys.privateKey, 256),
	);
	const keyInfo = concat(TEXT.encode("WebPush: info\0"), uaPublic, asPublic);
	const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
	const salt = concat(fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16)));
	const cek = await hkdf(salt, ikm, TEXT.encode("Content-Encoding: aes128gcm\0"), 16);
	const nonce = await hkdf(salt, ikm, TEXT.encode("Content-Encoding: nonce\0"), 12);
	const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
	// 0x02: padding delimiter of the last (and only) record.
	const sealed = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(plaintext, Uint8Array.of(2))),
	);
	const header = new Uint8Array(16 + 4 + 1);
	header.set(salt, 0);
	new DataView(header.buffer).setUint32(16, RECORD_SIZE, false);
	header[20] = asPublic.byteLength;
	return concat(header, asPublic, sealed);
}

/** RFC 8292 `Authorization` header value for a push service origin. */
export async function vapidAuthorization(endpoint: string, vapid: VapidKeys, subject: string): Promise<string> {
	const b64 = (value: object): string => encodeBase64Url(TEXT.encode(JSON.stringify(value)));
	const claims = { aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + VAPID_TTL_S, sub: subject };
	const unsigned = `${b64({ typ: "JWT", alg: "ES256" })}.${b64(claims)}`;
	const key = await crypto.subtle.importKey("jwk", vapid.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, [
		"sign",
	]);
	// WebCrypto ECDSA signatures are already JWS-shaped (raw r ∥ s).
	const signature = new Uint8Array(
		await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, TEXT.encode(unsigned)),
	);
	return `vapid t=${unsigned}.${encodeBase64Url(signature)}, k=${vapid.publicKey}`;
}

/**
 * Deliver one notification. Resolves the push service status: 201 accepted;
 * 404 / 410 mean the subscription is gone and should be dropped.
 */
export async function sendPush(
	subscription: PushSubscriptionJson,
	payload: object,
	vapid: VapidKeys,
	subject: string,
	topic?: string,
): Promise<number> {
	const body = await encryptPushPayload(subscription.keys, TEXT.encode(JSON.stringify(payload)));
	const headers: Record<string, string> = {
		Authorization: await vapidAuthorization(subscription.endpoint, vapid, subject),
		"Content-Encoding": "aes128gcm",
		"Content-Type": "application/octet-stream",
		TTL: "86400",
		Urgency: "high",
	};
	// A newer notice for the same session replaces one still undelivered.
	if (topic) headers.Topic = topic;
	const response = await fetch(subscription.endpoint, { method: "POST", headers, body });
	return response.status;
}
