// Transfer through the official feature of a platform (BE-074, P4, ADR-49). LOCAL TYPES until the SDK has SD-077 (`transferDocumentHash`, `TransferError`): the names are the ones agreed
// with Main B (resource `x207:transfer:<hash>`, document `circle, seller, platform, transfer_ref, proof_method, estimate_seconds, value, nonce`, the TXT texts
// `x207-sell=<listing_hash>` and `x207-own=<purchase_id>`), and the hash below is a stand-in (sha256 of the canonical JSON) that is replaced by the SDK function.
import { createHash } from "node:crypto";

export const TRANSFER_PLATFORMS = ["domain", "game_item", "ticket"] as const;
export type TransferPlatform = (typeof TRANSFER_PLATFORMS)[number];
export const PROOF_METHODS = ["dns_txt", "trade_api", "buyer_confirm"] as const;
export type ProofMethod = (typeof PROOF_METHODS)[number];

/** The mapping is fixed: a domain is proved by DNS, a game item by the trade API, a ticket by the buyer. */
export const PLATFORM_METHOD: Readonly<Record<TransferPlatform, ProofMethod>> = { domain: "dns_txt", game_item: "trade_api", ticket: "buyer_confirm" };
/** How long the voucher is held while the transfer is made (ADR-49): a domain 7 days, a ticket 1 day, a game item 1 hour. */
export const PLATFORM_WINDOW_SECONDS: Readonly<Record<TransferPlatform, number>> = { domain: 7 * 86_400, ticket: 86_400, game_item: 3_600 };
/** A ticket is limited to 100 credit (ADR-49 point 4). */
export const TICKET_LIMIT = 100n * 1_000_000n;

/** The asset types of the transfer listings. A website or an online store (#67) is on the roadmap only (ADR-49 point 3). */
export const TRANSFER_ASSET_TYPES: Readonly<Record<string, TransferPlatform>> = { "transfer:domain": "domain", "transfer:game-item": "game_item", "transfer:ticket": "ticket" };
export const ROADMAP_ONLY_ASSET_TYPES: ReadonlySet<string> = new Set(["transfer:website", "transfer:online-store", "website:site", "store:online-shop"]);

export interface TransferDocument {
  circle: string;
  seller: string;
  platform: TransferPlatform;
  transfer_ref: string;
  proof_method: ProofMethod;
  estimate_seconds: number;
  value: string;
  nonce: string;
}

const canonical = (doc: TransferDocument): string =>
  JSON.stringify({
    circle: doc.circle, seller: doc.seller, platform: doc.platform, transfer_ref: doc.transfer_ref, proof_method: doc.proof_method,
    estimate_seconds: doc.estimate_seconds, value: doc.value, nonce: doc.nonce,
  });

/** Stand-in for `transferDocumentHash` of the SDK (SD-077). */
export const transferDocumentHash = (doc: TransferDocument): string => createHash("sha256").update(canonical(doc), "utf8").digest("hex");
export const transferResource = (hash: string): string => `x207:transfer:${hash}`;
export const txtSell = (listingHash: string): string => `x207-sell=${listingHash}`;
export const txtOwn = (purchaseId: number | string): string => `x207-own=${purchaseId}`;

/** The detail of a transfer listing (`Listing.detail` is JSON text with `kind: "transfer"`), or `null`. */
export function transferDetail(detail: string): (Record<string, unknown> & { kind: "transfer" }) | null {
  try {
    const d: unknown = JSON.parse(detail);
    return d !== null && typeof d === "object" && !Array.isArray(d) && (d as { kind?: unknown }).kind === "transfer" ? (d as Record<string, unknown> & { kind: "transfer" }) : null;
  } catch {
    return null;
  }
}
