// Signing of a canonical JSON notice, shared by the notices of invoices, orders and purchases (BE-051, BE-054, BE-056): ed25519 over the NEP-413 style hash of the JSON,
// `nep413SigningHash(json, sha256(json), circle)`, with the voucher key of the actor. The same scheme as the delivery notice (delivery-core.ts).
import { createHash } from "node:crypto";
import { nep413SigningHash, signHash, verifyHash, type VoucherSecretKey } from "@x207/core";

export const HASH = /^[0-9a-f]{64}$/;
export const ACCOUNT = /^(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/;
/** The `at` of a notice may differ this much from the clock of the server. */
export const NOTICE_SKEW_SECONDS = 600;

export class NoticeFormatError extends Error {}

export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
export const sha256Bytes = (text: string): Uint8Array => createHash("sha256").update(text, "utf8").digest();

export const noticeSigningHash = (json: string, circle: string): Uint8Array => nep413SigningHash(json, sha256Bytes(json), circle);
export const signNoticeJson = (json: string, circle: string, secretKey: VoucherSecretKey): string => signHash(noticeSigningHash(json, circle), secretKey);
export function verifyNoticeJson(json: string, circle: string, signature: string, publicKey: string): boolean {
  try {
    return verifyHash(noticeSigningHash(json, circle), signature, publicKey);
  } catch {
    return false;
  }
}

/** `throw new NoticeFormatError(message)` as an expression, for the validators. */
export const badNotice = (message: string): never => {
  throw new NoticeFormatError(message);
};
