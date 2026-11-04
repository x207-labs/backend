// Transfer through the official feature of a platform (BE-074, P4, ADR-49). The FORMAT is the one of the SDK (SD-077, `@x207/core`: `TransferDocument`, `transferDocumentHash`,
// `transferResource`, `sellTxt`, `ownTxt`, `parseTxt`, `normalizeTransfer`, `TransferError`); this file keeps what is the backend's own: which asset types are transfer listings, which are
// on the roadmap only, and how the detail of a listing is read.
import type { TransferPlatform } from "@x207/core";

/** The asset types of the transfer listings. A website or an online store (#67) is on the roadmap only (ADR-49 point 3). */
export const TRANSFER_ASSET_TYPES: Readonly<Record<string, TransferPlatform>> = { "transfer:domain": "domain", "transfer:game-item": "game_item", "transfer:ticket": "ticket" };
export const ROADMAP_ONLY_ASSET_TYPES: ReadonlySet<string> = new Set(["transfer:website", "transfer:online-store", "website:site", "store:online-shop"]);

/** The detail of a transfer listing (`Listing.detail` is JSON text with `kind: "transfer"`), or `null`. */
export function transferDetail(detail: string): (Record<string, unknown> & { kind: "transfer" }) | null {
  try {
    const d: unknown = JSON.parse(detail);
    return d !== null && typeof d === "object" && !Array.isArray(d) && (d as { kind?: unknown }).kind === "transfer" ? (d as Record<string, unknown> & { kind: "transfer" }) : null;
  } catch {
    return null;
  }
}
