// BE-116: verification of a NEP-413 signed message (https://github.com/near/NEPs/blob/master/neps/nep-0413.md). No imports: it runs in Deno (Edge Function) and in Node (tests) with WebCrypto only.
//
// What is signed: sha256( borsh(u32 2147484061) ++ borsh(Payload) ) with Payload = { message: string, nonce: [u8; 32], recipient: string, callbackUrl: Option<string> } (callbackUrl is not used: None).
// borsh string = u32 little endian length ++ UTF-8 bytes; Option None = one 0x00 byte. The signature is ed25519 over those 32 bytes of hash.
//
// x207 rules on top of the standard:
//   - the nonce is 32 bytes (base64): the first 8 bytes are the time in milliseconds (big endian), the other 24 are random. A nonce older than 5 minutes (or more than 1 minute in the future) is refused;
//     the server also refuses a nonce it has seen (the table `nonces_x207`, done by the caller of this module);
//   - the recipient must be `x207.vercel.app`;
//   - the message must be `x207:<action>`, so a signature made for one action does not do for another.

// the type that WebCrypto takes as data (the Node types have no DOM `BufferSource`)
type Buf = Parameters<typeof crypto.subtle.digest>[1];

export const NEP413_TAG = 2147484061; // 2^31 + 413
export const RECIPIENT = "x207.vercel.app";
export const MAX_NONCE_AGE_MS = 5 * 60_000;
export const MAX_NONCE_FUTURE_MS = 60_000;

export type VerifyError = "bad_public_key" | "bad_signature_format" | "bad_nonce" | "nonce_expired" | "wrong_recipient" | "wrong_message" | "invalid_signature";
export type Verified = { ok: true; nonce: string; publicKeyBytes: Uint8Array } | { ok: false; error: VerifyError };

export interface SignedRequest {
  accountId: string;
  publicKey: string;
  signature: string;
  message: string;
  nonce: string;
  recipient: string;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(text: string): Uint8Array | null {
  let value = 0n;
  for (const ch of text) {
    const i = B58.indexOf(ch);
    if (i < 0) return null;
    value = value * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  for (const ch of text) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

export function base64Decode(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(text)) return null;
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
export const bytesToHex = hex;

// y coordinates (little endian hex, sign bit cleared) of the 8 small-order points of ed25519: y = 0, 1, p-1 and the two others (each with both signs).
// A key like that makes a signature that anybody can forge (WebCrypto in Deno accepts the zero key with the zero signature).
const SMALL_ORDER_Y = new Set([
  "00".repeat(32),
  "01" + "00".repeat(31),
  "ec" + "ff".repeat(30) + "7f",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
]);

/** True for a key that is not canonical (y >= p) or of small order. */
export function isWeakPublicKey(bytes: Uint8Array): boolean {
  const y = Uint8Array.from(bytes);
  y[31] = y[31]! & 0x7f;
  const yHex = hex(y);
  if (SMALL_ORDER_Y.has(yHex)) return true;
  // y >= p = 2^255 - 19: every byte from 1 to 30 is ff, the top byte (sign cleared) is 7f, the first byte is >= ed
  return y[31] === 0x7f && y.slice(1, 31).every((b) => b === 0xff) && y[0]! >= 0xed;
}

/** `ed25519:<base58>` to its 32 bytes. */
export function parsePublicKey(publicKey: string): Uint8Array | null {
  if (!publicKey.startsWith("ed25519:")) return null;
  const bytes = base58Decode(publicKey.slice("ed25519:".length));
  return bytes !== null && bytes.length === 32 ? bytes : null;
}

/** The signature as a wallet gives it: base64 (also url-safe) or `ed25519:<base58>`; 64 bytes. */
export function parseSignature(signature: string): Uint8Array | null {
  const bytes = signature.startsWith("ed25519:") ? base58Decode(signature.slice("ed25519:".length)) : base64Decode(signature);
  return bytes !== null && bytes.length === 64 ? bytes : null;
}

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function borshString(s: string): Uint8Array {
  const body = new TextEncoder().encode(s);
  const out = new Uint8Array(4 + body.length);
  out.set(u32le(body.length), 0);
  out.set(body, 4);
  return out;
}

/** The bytes that are hashed: the tag, then the borsh of the payload. Exposed so that the tests can pin the layout. */
export function nep413Preimage(message: string, nonce: Uint8Array, recipient: string): Uint8Array {
  const parts = [u32le(NEP413_TAG), borshString(message), nonce, borshString(recipient), Uint8Array.of(0)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export async function nep413Hash(message: string, nonce: Uint8Array, recipient: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", nep413Preimage(message, nonce, recipient) as Buf));
}

/** Time in the nonce (first 8 bytes, big endian, milliseconds). */
export function nonceTimeMs(nonce: Uint8Array): number {
  return Number(new DataView(nonce.buffer, nonce.byteOffset, 8).getBigUint64(0, false));
}

/**
 * Checks the shape, the recipient, the message, the age of the nonce and the ed25519 signature. It does not know whether the key belongs to the account (the RPC answers that)
 * or whether the nonce was used (the table answers that).
 */
export async function verifyNep413(req: SignedRequest, expectedAction: string, nowMs: number): Promise<Verified> {
  const publicKeyBytes = parsePublicKey(req.publicKey);
  if (publicKeyBytes === null) return { ok: false, error: "bad_public_key" };
  const signature = parseSignature(req.signature);
  if (signature === null) return { ok: false, error: "bad_signature_format" };
  const nonce = base64Decode(req.nonce);
  if (nonce === null || nonce.length !== 32) return { ok: false, error: "bad_nonce" };
  if (req.recipient !== RECIPIENT) return { ok: false, error: "wrong_recipient" };
  if (req.message !== `x207:${expectedAction}`) return { ok: false, error: "wrong_message" };
  const at = nonceTimeMs(nonce);
  if (nowMs - at > MAX_NONCE_AGE_MS || at - nowMs > MAX_NONCE_FUTURE_MS) return { ok: false, error: "nonce_expired" };
  if (isWeakPublicKey(publicKeyBytes)) return { ok: false, error: "invalid_signature" };
  const hash = await nep413Hash(req.message, nonce, req.recipient);
  let valid = false;
  try {
    const key = await crypto.subtle.importKey("raw", publicKeyBytes as Buf, { name: "Ed25519" }, false, ["verify"]);
    valid = await crypto.subtle.verify({ name: "Ed25519" }, key, signature as Buf, hash as Buf);
  } catch {
    valid = false;
  }
  return valid ? { ok: true, nonce: req.nonce, publicKeyBytes } : { ok: false, error: "invalid_signature" };
}
