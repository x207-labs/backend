// Buku listing D12 (BE-040, F9): `POST/GET /x207/circles/{circle}/listings`, `GET …/listings/{hash}`, `POST …/listings/{hash}/cancel`.
// Listing tetap ada tanpa lawan sampai dicocokkan, dibatalkan, atau kedaluwarsa; kedaluwarsa dihitung saat dibaca.
import type Database from "better-sqlite3";
import {
  BarterFormatError, listingHash, validateListing, verifyCancelSignature, verifyListingSignature, type Listing,
} from "@x207/core";
import { ApiError, invalidRequest } from "../api/errors.js";
import { row, rows } from "../api/format.js";
import { decodeCursor, encodeCursor, parseLimit } from "../api/pagination.js";
import type { Route } from "../api/router.js";
import { activeMemberKey, memberKeys } from "./auth.js";
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

export function listingView(r: ListingRow, nowS: number) {
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
  };
}

export function findListing(db: Database.Database, circleId: string, hash: string): ListingRow {
  if (!HASH.test(hash)) throw invalidRequest("hash listing harus 64 karakter heksadesimal huruf kecil", { hash });
  const found = row<ListingRow>(db, "SELECT * FROM listings WHERE circle_id = ? AND listing_hash = ?", circleId, hash);
  if (!found) throw new ApiError(404, "listing_not_found", `Listing ${hash} tidak ada`, { listingHash: hash });
  return found;
}

/** Fungsi pemeriksa tambahan sebelum format listing divalidasi (mis. kelas aset, BE-042). */
export type ListingCheck = (listing: Listing) => void;

function parseListingBody(body: unknown): { listing: Listing; signature: string } {
  if (body === null || typeof body !== "object") throw invalidRequest("body harus objek");
  const { listing, signature } = body as { listing?: unknown; signature?: unknown };
  if (typeof signature !== "string") throw invalidRequest("signature wajib string");
  if (listing === null || typeof listing !== "object") throw invalidRequest("listing wajib objek");
  return { listing: listing as Listing, signature };
}

function boolParam(query: URLSearchParams, name: string): boolean | null {
  const raw = query.get(name);
  if (raw === null) return null;
  if (raw !== "true" && raw !== "false") throw invalidRequest(`${name} harus true atau false`, { [name]: raw });
  return raw === "true";
}

export function listingRoutes(checks: readonly ListingCheck[] = []): Route[] {
  return [
    {
      method: "POST",
      pattern: "/x207/circles/{circle}/listings",
      circleScoped: true,
      handler: ({ db, circle, body, now }) => {
        const { listing, signature } = parseListingBody(body);
        for (const check of checks) check(listing);
        try {
          validateListing(listing);
        } catch (error) {
          if (error instanceof BarterFormatError) throw invalidRequest(error.message);
          throw error;
        }
        if (listing.circle !== circle.contract_id) {
          throw invalidRequest("listing.circle harus akun kontrak lingkaran", { expected: circle.contract_id, got: listing.circle });
        }
        const nowS = nowSeconds(now());
        if (listing.expires_at <= nowS) throw invalidRequest("expires_at sudah lewat", { expires_at: listing.expires_at });
        const pubkey = activeMemberKey(db, circle.circle_id, listing.account);
        if (!verifyListingSignature(listing, signature, pubkey)) {
          throw new ApiError(401, "invalid_signature", "Tanda tangan listing tidak cocok dengan kunci voucher anggota", { account: listing.account });
        }
        const hash = listingHash(listing);
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
        if (inserted.changes === 0) throw new ApiError(409, "already_exists", "Listing dengan hash ini sudah tercatat", { listingHash: hash });
        return { status: 201, body: listingView(findListing(db, circle.circle_id, hash), nowS) };
      },
    },
    {
      method: "GET",
      pattern: "/x207/circles/{circle}/listings",
      circleScoped: true,
      handler: ({ db, circle, query, now }) => {
        const limit = parseLimit(query);
        const status = query.get("status") ?? "open";
        if (!(STATUSES as readonly string[]).includes(status)) throw invalidRequest("status tidak dikenal", { status, allowed: STATUSES });
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
        if (cursor && after === null) throw invalidRequest("cursor tidak valid");
        if (after !== null) where.push("id > ?"), args.push(after);
        const found = rows<ListingRow>(db, `SELECT * FROM listings WHERE ${where.join(" AND ")} ORDER BY id LIMIT ?`, ...args, limit + 1);
        const page = found.slice(0, limit);
        const last = page[page.length - 1];
        return {
          status: 200,
          body: { items: page.map((r) => listingView(r, nowS)), nextCursor: found.length > limit && last ? encodeCursor({ a: Number(last.id) }) : null },
        };
      },
    },
    {
      method: "GET",
      pattern: "/x207/circles/{circle}/listings/{hash}",
      circleScoped: true,
      handler: ({ db, circle, params, now }) => ({
        status: 200,
        body: listingView(findListing(db, circle.circle_id, params.hash as string), nowSeconds(now())),
      }),
    },
    {
      method: "POST",
      pattern: "/x207/circles/{circle}/listings/{hash}/cancel",
      circleScoped: true,
      handler: ({ db, circle, params, body, now }) => {
        const found = findListing(db, circle.circle_id, params.hash as string);
        const signature = body !== null && typeof body === "object" ? (body as { signature?: unknown }).signature : undefined;
        if (typeof signature !== "string") throw invalidRequest("signature wajib string");
        const pubkey = memberKeys(db, circle.circle_id, [found.account_id])[found.account_id];
        if (pubkey === undefined || !verifyCancelSignature(found.listing_hash, circle.contract_id, signature, pubkey)) {
          throw new ApiError(401, "invalid_signature", "Pembatalan harus ditandatangani pemasang listing", { account: found.account_id });
        }
        const nowS = nowSeconds(now());
        const status = effectiveStatus(found, nowS);
        if (status !== "open") throw new ApiError(409, "listing_not_open", `Listing berstatus ${status}`, { listingHash: found.listing_hash, status });
        db.prepare("UPDATE listings SET status = 'cancelled', closed_at_ms = ? WHERE id = ?").run(now(), found.id);
        return { status: 200, body: listingView(findListing(db, circle.circle_id, found.listing_hash), nowS) };
      },
    },
  ];
}
