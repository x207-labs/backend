// Delivery of an off-chain asset (BE-047, catalogue part F): the handover is not atomic like a class A escrow, so the payment waits for the receiver.
// seller marks "delivered" (optional proof hash) -> buyer signs "confirmed" or "disputed" inside a window -> only then the voucher or the bundle is
// registered. Every step is a signed notice (NEP-413 style, voucher key of the actor). The format is kept here until the SDK takes it over.
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { nep413SigningHash, signHash, verifyHash, type VoucherSecretKey } from "@x207/core";
import { row } from "../api/format.js";

export const DELIVERY_ACTIONS = ["delivered", "confirmed", "disputed", "cancelled"] as const;
export type DeliveryAction = (typeof DELIVERY_ACTIONS)[number];
export const DISPUTE_REASONS = ["not_received", "not_as_described", "other"] as const;
export type DisputeReason = (typeof DISPUTE_REASONS)[number];
export const DELIVERY_STATES = ["awaiting", "delivered", "confirmed", "disputed", "cancelled"] as const;

/** Asset classes whose one-time handover needs the confirmation; class A is atomic and class D is paid per use. */
export const DEFAULT_CONFIRM_CLASSES: readonly string[] = ["B", "C"];
/** How long the receiver has to confirm or dispute after "delivered". */
export const DEFAULT_DISPUTE_WINDOW_SECONDS = 72 * 3600;
/** The `at` of a notice may differ this much from the clock of the server. */
export const MAX_NOTICE_SKEW_SECONDS = 600;

const HASH = /^[0-9a-f]{64}$/;
const ACCOUNT = /^(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/;

export interface DeliveryNotice {
  circle: string;
  listing_hash: string;
  offer_hash: string;
  actor: string;
  action: DeliveryAction;
  /** unix seconds when the actor signed */
  at: number;
  /** sha256 (hex) of the proof the seller keeps off-chain; only with `delivered`, optional */
  proof_hash: string | null;
  /** only with `disputed` */
  reason: DisputeReason | null;
}

export class DeliveryFormatError extends Error {}

export function validateDeliveryNotice(n: DeliveryNotice): void {
  const bad = (m: string): never => {
    throw new DeliveryFormatError(m);
  };
  if (typeof n.circle !== "string" || !ACCOUNT.test(n.circle) || typeof n.actor !== "string" || !ACCOUNT.test(n.actor)) bad("circle dan actor harus account id");
  if (!HASH.test(String(n.listing_hash)) || !HASH.test(String(n.offer_hash))) bad("listing_hash dan offer_hash harus 64 heksadesimal huruf kecil");
  if (!(DELIVERY_ACTIONS as readonly string[]).includes(n.action)) bad("action tidak dikenal");
  if (!Number.isSafeInteger(n.at) || n.at < 1) bad("at harus detik unix bulat");
  if (n.proof_hash !== null && (n.action !== "delivered" || !HASH.test(String(n.proof_hash)))) bad("proof_hash hanya untuk delivered dan berupa 64 heksadesimal huruf kecil");
  if (n.action === "disputed" ? !(DISPUTE_REASONS as readonly string[]).includes(String(n.reason)) : n.reason !== null) bad("reason wajib untuk disputed dan tidak untuk yang lain");
}

/** Canonical JSON: keys `circle, listing_hash, offer_hash, actor, action, at, proof_hash, reason`. */
export function serializeDeliveryNotice(n: DeliveryNotice): string {
  validateDeliveryNotice(n);
  return JSON.stringify({ circle: n.circle, listing_hash: n.listing_hash, offer_hash: n.offer_hash, actor: n.actor, action: n.action, at: n.at, proof_hash: n.proof_hash, reason: n.reason });
}

const sha256 = (text: string): Uint8Array => createHash("sha256").update(text, "utf8").digest();
export const deliveryNoticeHash = (n: DeliveryNotice): string => Buffer.from(sha256(serializeDeliveryNotice(n))).toString("hex");
export const deliveryNoticeSigningHash = (n: DeliveryNotice): Uint8Array => nep413SigningHash(serializeDeliveryNotice(n), sha256(serializeDeliveryNotice(n)), n.circle);
export const signDeliveryNotice = (n: DeliveryNotice, secretKey: VoucherSecretKey): string => signHash(deliveryNoticeSigningHash(n), secretKey);

export function verifyDeliveryNoticeSignature(n: DeliveryNotice, signature: string, publicKey: string): boolean {
  try {
    return verifyHash(deliveryNoticeSigningHash(n), signature, publicKey);
  } catch {
    return false;
  }
}

export interface DeliveryRow {
  id: bigint;
  listing_hash: string;
  offer_hash: string;
  match_id: bigint;
  deliverer: string;
  receiver: string;
  deliver_by: bigint;
  state: string;
  proof_hash: string | null;
  delivered_at: bigint | null;
  confirm_by: bigint | null;
  confirmed_at: bigint | null;
  disputed_at: bigint | null;
  dispute_reason: string | null;
  cancelled_at: bigint | null;
  cancelled_by: string | null;
  created_at_ms: bigint;
}

export function findDelivery(db: Database.Database, circleId: string, listingHashHex: string): DeliveryRow | undefined {
  return row<DeliveryRow>(db, "SELECT * FROM deliveries WHERE circle_id = ? AND listing_hash = ?", circleId, listingHashHex);
}

/** Called inside the transaction of `accept`: a match on a listing whose offered asset needs the confirmation starts in `awaiting`. */
export function startDeliveryIfNeeded(
  db: Database.Database,
  circleId: string,
  match: { id: number | bigint; listing_hash: string; offer_hash: string; seller: string; counterparty: string; offerClass: string; deliverBy: number },
  confirmClasses: readonly string[],
  nowMs: number,
): boolean {
  if (!confirmClasses.includes(match.offerClass)) return false;
  db.prepare(
    `INSERT INTO deliveries (circle_id, listing_hash, offer_hash, match_id, deliverer, receiver, deliver_by, state, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting', ?)`,
  ).run(circleId, match.listing_hash, match.offer_hash, match.id, match.seller, match.counterparty, match.deliverBy, nowMs);
  return true;
}

/** `true` when nothing stands between the match and the payment: no delivery to wait for, or the receiver confirmed. */
export function paymentReleased(db: Database.Database, circleId: string, listingHashHex: string): boolean {
  const d = findDelivery(db, circleId, listingHashHex);
  return d === undefined || d.state === "confirmed";
}
