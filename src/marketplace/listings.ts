// D12 listing book (BE-040, F9): `POST/GET /x207/circles/{circle}/listings`, `GET …/listings/{hash}`, `POST …/listings/{hash}/cancel`.
// A listing stays without a counterparty until it is matched, cancelled, or expired; expiry is computed at read time.
import type Database from "better-sqlite3";
import {
  BarterFormatError, listingHash, validateListing, verifyCancelSignature, verifyListingSignature, type Listing,
} from "@x207/core";
import { ApiError, invalidRequest } from "../api/errors.js";
import { row, rows } from "../api/format.js";
import { decodeCursor, encodeCursor, parseLimit } from "../api/pagination.js";
import type { Route } from "../api/router.js";
import { activeMemberKey, memberKeys } from "./auth.js";
import { appraisalOfDetail } from "../appraiser/appraiser.js";
import { isoSeconds, nowSeconds } from "./common.js";

const STATUSES = ["open", "matched", "cancelled", "expired", "all"] as const;
const HASH = /^[0-9a-f]{64}$/;

export interface ListingRow {
  id: bigint;
  circle_id: string;
  listing_hash: string;
  account_id: string;
  offer_asset_type: string;
  offer_class: string;
  offer_quantity: bigint;
  offer_value: string;
  want_asset_type: string;
  want_class: string;
  want_quantity: bigint;
  want_value: string;
  terms: string;
  detail: string;
  expires_at: bigint;
  discount_bps: bigint;
  accept_payment: bigint;
  discoverable: bigint;
  nonce: string;
  signature: string;
  status: string;
  created_at_ms: bigint;
  closed_at_ms: bigint | null;
}

export const effectiveStatus = (r: ListingRow, nowS: number): string =>
  r.status === "open" && Number(r.expires_at) <= nowS ? "expired" : r.status;

/** BE-119: with `db`, a listing whose `detail` names an appraisal (`appraisal=apr_<24 hex>`) that is done carries its short form in `appraisal`. */
export function listingView(r: ListingRow, nowS: number, db?: Database.Database) {
  const appraisal = db ? appraisalOfDetail(db, r.detail) : null;
  return {
    listingHash: r.listing_hash,
    account: r.account_id,
    offer: { assetType: r.offer_asset_type, assetClass: r.offer_class, quantity: Number(r.offer_quantity), value: r.offer_value },
    want: { assetType: r.want_asset_type, assetClass: r.want_class, quantity: Number(r.want_quantity), value: r.want_value },
    terms: r.terms,
    detail: r.detail,
    expiresAt: isoSeconds(Number(r.expires_at)),
    discountBps: Number(r.discount_bps),
    acceptPayment: r.accept_payment === 1n,
    discoverable: r.discoverable === 1n,
    nonce: r.nonce,
    signature: r.signature,
    status: effectiveStatus(r, nowS),
    ...(appraisal ? { appraisal } : {}),
  };
}

export function findListing(db: Database.Database, circleId: string, hash: string): ListingRow {
  if (!HASH.test(hash)) throw invalidRequest("listing hash must be 64 lowercase hex characters", { hash });
  const found = row<ListingRow>(db, "SELECT * FROM listings WHERE circle_id = ? AND listing_hash = ?", circleId, hash);
  if (!found) throw new ApiError(404, "listing_not_found", `Listing ${hash} not found`, { listingHash: hash });
  return found;
}

/** Extra checker run before the listing format is validated (e.g. asset class, BE-042). */
export type ListingCheck = (listing: Listing, context: { db: Database.Database; circleId: string; nowS: number }) => void;
/** BE-074: a check that asks the outside (the DNS of a domain) and so is async; it runs after the signature and the duplicate, with the hash of the listing. */
export type ListingAsyncCheck = (listing: Listing, hash: string, context: { db: Database.Database; circleId: string; nowS: number }) => Promise<void>;

function parseListingBody(body: unknown): { listing: Listing; signature: string } {
  if (body === null || typeof body !== "object") throw invalidRequest("body must be an object");
  const { listing, signature } = body as { listing?: unknown; signature?: unknown };
  if (typeof signature !== "string") throw invalidRequest("signature must be a string");
  if (listing === null || typeof listing !== "object") throw invalidRequest("listing must be an object");
  return { listing: listing as Listing, signature };
}

function boolParam(query: URLSearchParams, name: string): boolean | null {
  const raw = query.get(name);
  if (raw === null) return null;
  if (raw !== "true" && raw !== "false") throw invalidRequest(`${name} must be true or false`, { [name]: raw });
  return raw === "true";
}

/**
 * Everything that `POST listings` checks before it stores a listing: the checks of the asset kinds (D10 class, scope, RWA whitelist, USDT of the circle, metered
 * resource), the format, the circle, the time, the signature and the duplicate. One function, so that the dry run (`POST listings/check`) cannot say anything else.
 * Returns the listing, its signature and its hash; throws the same `ApiError` as the POST.
 */
async function checkListingRequest(
  { db, circle, body, nowMs }: { db: Database.Database; circle: { circle_id: string; contract_id: string }; body: unknown; nowMs: number },
  checks: readonly ListingCheck[],
  asyncChecks: readonly ListingAsyncCheck[] = [],
): Promise<{ listing: Listing; signature: string; hash: string; nowS: number }> {
  const { listing, signature } = parseListingBody(body);
  const nowS = nowSeconds(nowMs);
  for (const check of checks) check(listing, { db, circleId: circle.circle_id, nowS });
  try {
    validateListing(listing);
  } catch (error) {
    if (error instanceof BarterFormatError) throw invalidRequest(error.message);
    throw error;
  }
  if (listing.circle !== circle.contract_id) {
    throw invalidRequest("listing.circle must be the circle contract account", { expected: circle.contract_id, got: listing.circle });
  }
  if (listing.expires_at <= nowS) throw invalidRequest("expires_at has already passed", { expires_at: listing.expires_at });
  const pubkey = activeMemberKey(db, circle.circle_id, listing.account);
  if (!verifyListingSignature(listing, signature, pubkey)) {
    throw new ApiError(401, "invalid_signature", "Listing signature does not match the member's voucher key", { account: listing.account });
  }
  const hash = listingHash(listing);
  if (row(db, "SELECT 1 AS x FROM listings WHERE circle_id = ? AND listing_hash = ?", circle.circle_id, hash)) {
    throw new ApiError(409, "already_exists", "A listing with this hash is already recorded", { listingHash: hash });
  }
  for (const check of asyncChecks) await check(listing, hash, { db, circleId: circle.circle_id, nowS });
  return { listing, signature, hash, nowS };
}

export function listingRoutes(checks: readonly ListingCheck[] = [], asyncChecks: readonly ListingAsyncCheck[] = []): Route[] {
  return [
    {
      method: "POST",
      pattern: "/x207/circles/{circle}/listings",
      circleScoped: true,
      handler: async ({ db, circle, body, now }) => {
        const { listing, signature, hash, nowS } = await checkListingRequest({ db, circle, body, nowMs: now() }, checks, asyncChecks);
        const inserted = db
          .prepare(
            `INSERT OR IGNORE INTO listings (circle_id, listing_hash, account_id, offer_asset_type, offer_class, offer_quantity, offer_value,
               want_asset_type, want_class, want_quantity, want_value, terms, detail, expires_at, discount_bps, accept_payment, discoverable,
               nonce, signature, created_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(circle.circle_id, hash, listing.account, listing.offer.asset_type, listing.offer.asset_class, listing.offer.quantity,
            listing.offer.value, listing.want.asset_type, listing.want.asset_class, listing.want.quantity, listing.want.value,
            listing.terms, listing.detail, listing.expires_at, listing.discount_bps, listing.accept_payment ? 1 : 0,
            listing.discoverable ? 1 : 0, listing.nonce, signature, now());
        if (inserted.changes === 0) throw new ApiError(409, "already_exists", "A listing with this hash is already recorded", { listingHash: hash });
        return { status: 201, body: listingView(findListing(db, circle.circle_id, hash), nowS, db) };
      },
    },
    {
      // BE-052: dry run of `POST listings`. The same body, the same checks in the same order and the same errors; nothing is stored. The owner calls it BEFORE
      // `offer_grant` and the deposit, so that a listing the backend would refuse does not leave an asset in escrow (security-review-batch1.md, X4).
      method: "POST",
      pattern: "/x207/circles/{circle}/listings/check",
      circleScoped: true,
      handler: async ({ db, circle, body, now }) => {
        const { listing, hash } = await checkListingRequest({ db, circle, body, nowMs: now() }, checks, asyncChecks);
        return { status: 200, body: { valid: true, listingHash: hash, account: listing.account, offerAssetType: listing.offer.asset_type, expiresAt: listing.expires_at, stored: false } };
      },
    },
    {
      method: "GET",
      pattern: "/x207/circles/{circle}/listings",
      circleScoped: true,
      handler: ({ db, circle, query, now }) => {
        const limit = parseLimit(query);
        const status = query.get("status") ?? "open";
        if (!(STATUSES as readonly string[]).includes(status)) throw invalidRequest("status is not recognized", { status, allowed: STATUSES });
        const nowS = nowSeconds(now());
        const where = ["circle_id = ?"];
        const args: unknown[] = [circle.circle_id];
        if (status === "open") where.push("status = 'open' AND expires_at > ?"), args.push(nowS);
        else if (status === "expired") where.push("status = 'open' AND expires_at <= ?"), args.push(nowS);
        else if (status !== "all") where.push("status = ?"), args.push(status);
        const text: Array<[string, string]> = [
          ["account", "account_id"], ["offerType", "offer_asset_type"], ["wantType", "want_asset_type"],
          ["offerClass", "offer_class"], ["wantClass", "want_class"],
        ];
        for (const [param, column] of text) {
          const value = query.get(param);
          if (value !== null) where.push(`${column} = ?`), args.push(value);
        }
        for (const [param, column] of [["discoverable", "discoverable"], ["acceptPayment", "accept_payment"]] as const) {
          const value = boolParam(query, param);
          if (value !== null) where.push(`${column} = ?`), args.push(value ? 1 : 0);
        }
        const cursor = decodeCursor(query);
        const after = cursor && typeof cursor.a === "number" ? cursor.a : null;
        if (cursor && after === null) throw invalidRequest("cursor is not valid");
        if (after !== null) where.push("id > ?"), args.push(after);
        const found = rows<ListingRow>(db, `SELECT * FROM listings WHERE ${where.join(" AND ")} ORDER BY id LIMIT ?`, ...args, limit + 1);
        const page = found.slice(0, limit);
        const last = page[page.length - 1];
        return {
          status: 200,
          body: { items: page.map((r) => listingView(r, nowS, db)), nextCursor: found.length > limit && last ? encodeCursor({ a: Number(last.id) }) : null },
        };
      },
    },
    {
      method: "GET",
      pattern: "/x207/circles/{circle}/listings/{hash}",
      circleScoped: true,
      handler: ({ db, circle, params, now }) => ({
        status: 200,
        body: listingView(findListing(db, circle.circle_id, params.hash as string), nowSeconds(now()), db),
      }),
    },
    {
      method: "POST",
      pattern: "/x207/circles/{circle}/listings/{hash}/cancel",
      circleScoped: true,
      handler: ({ db, circle, params, body, now }) => {
        const found = findListing(db, circle.circle_id, params.hash as string);
        const signature = body !== null && typeof body === "object" ? (body as { signature?: unknown }).signature : undefined;
        if (typeof signature !== "string") throw invalidRequest("signature must be a string");
        const pubkey = memberKeys(db, circle.circle_id, [found.account_id])[found.account_id];
        if (pubkey === undefined || !verifyCancelSignature(found.listing_hash, circle.contract_id, signature, pubkey)) {
          throw new ApiError(401, "invalid_signature", "The cancellation must be signed by the listing's poster", { account: found.account_id });
        }
        const nowS = nowSeconds(now());
        const status = effectiveStatus(found, nowS);
        if (status !== "open") throw new ApiError(409, "listing_not_open", `Listing is ${status}`, { listingHash: found.listing_hash, status });
        db.prepare("UPDATE listings SET status = 'cancelled', closed_at_ms = ? WHERE id = ?").run(now(), found.id);
        return { status: 200, body: listingView(findListing(db, circle.circle_id, found.listing_hash), nowS, db) };
      },
    },
  ];
}
