// Kotak masuk ajakan pencari (BE-044, FIT-F9-08): `POST/GET /x207/circles/{circle}/referrals`, `POST …/referrals/{hash}/refuse`.
// Pencari tidak bisa menawar atas nama agent lain, jadi ia menandatangani ajakan dan mengirimnya ke kotak masuk agent tujuan; agent menawar sendiri
// (`POST …/offers` dengan `referralHash`). Jatah pencari lalu melekat pada utas penawaran itu dan dipakai saat penerimaan (bundles.ts).
// Pagar spam sisi server (SV-016): pencari dan tujuan anggota aktif, listing terbuka dan `discoverable`, jatah tidak melebihi diskon listing,
// satu ajakan pending per (pencari, tujuan, listing), batas ajakan pending per agent, dan pasangan yang ditolak tidak boleh diajak lagi.
import type Database from "better-sqlite3";
import { BarterFormatError, referralHash, validateReferral, verifyRefuseReferral, verifyReferralSignature, type Referral } from "@x207/core";
import { ApiError, invalidRequest } from "../api/errors.js";
import { row, rows } from "../api/format.js";
import { decodeCursor, encodeCursor, parseLimit } from "../api/pagination.js";
import type { Route } from "../api/router.js";
import { activeMemberKey, memberKeys } from "./auth.js";
import { isoSeconds, nowSeconds } from "./common.js";
import { effectiveStatus, findListing } from "./listings.js";
import type { OfferRow } from "./offers.js";

export const DEFAULT_MAX_PENDING_REFERRALS = 5;
const HASH = /^[0-9a-f]{64}$/;
const STATUSES = ["pending", "taken", "refused", "expired", "all"] as const;

export interface ReferralRow {
  id: bigint;
  referral_hash: string;
  seeker: string;
  to_account: string;
  listing_hash: string;
  mode: string;
  value: string;
  quantity: bigint;
  deliver_by: bigint;
  searcher_share_bps: bigint;
  expires_at: bigint;
  nonce: string;
  signature: string;
  status: string;
  offer_hash: string | null;
  created_at_ms: bigint;
}

const statusOf = (r: ReferralRow, nowS: number): string => (r.status === "pending" && Number(r.expires_at) <= nowS ? "expired" : r.status);

export function referralView(r: ReferralRow, nowS: number) {
  return {
    referralHash: r.referral_hash,
    seeker: r.seeker,
    to: r.to_account,
    listingHash: r.listing_hash,
    mode: r.mode,
    value: r.value,
    quantity: Number(r.quantity),
    deliverBy: isoSeconds(Number(r.deliver_by)),
    searcherShareBps: Number(r.searcher_share_bps),
    expiresAt: isoSeconds(Number(r.expires_at)),
    nonce: r.nonce,
    signature: r.signature,
    status: statusOf(r, nowS),
    offerHash: r.offer_hash,
  };
}

export function findReferral(db: Database.Database, circleId: string, hash: string): ReferralRow {
  if (!HASH.test(hash)) throw invalidRequest("hash ajakan harus 64 karakter heksadesimal huruf kecil", { hash });
  const found = row<ReferralRow>(db, "SELECT * FROM referrals WHERE circle_id = ? AND referral_hash = ?", circleId, hash);
  if (!found) throw new ApiError(404, "referral_not_found", `Ajakan ${hash} tidak ada`, { referralHash: hash });
  return found;
}

/** Ajakan yang melekat pada utas penawaran `offer` (lewat penawaran ronde 1 utas itu), atau `undefined`. */
export function threadReferral(db: Database.Database, circleId: string, offer: OfferRow): ReferralRow | undefined {
  const first = row<{ referral_hash: string | null }>(
    db,
    "SELECT referral_hash FROM offers WHERE circle_id = ? AND listing_hash = ? AND counterparty = ? AND round = 1",
    circleId, offer.listing_hash, offer.counterparty,
  );
  return first?.referral_hash ? row<ReferralRow>(db, "SELECT * FROM referrals WHERE circle_id = ? AND referral_hash = ?", circleId, first.referral_hash) : undefined;
}

export function referralRoutes(options: { maxPending?: number } = {}): Route[] {
  const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING_REFERRALS;
  return [
    {
      method: "POST",
      pattern: "/x207/circles/{circle}/referrals",
      circleScoped: true,
      handler: ({ db, circle, body, now }) => {
        if (body === null || typeof body !== "object") throw invalidRequest("body harus objek");
        const { referral, signature } = body as { referral?: unknown; signature?: unknown };
        if (typeof signature !== "string") throw invalidRequest("signature wajib string");
        if (referral === null || typeof referral !== "object") throw invalidRequest("referral wajib objek");
        const r = referral as Referral;
        try {
          validateReferral(r);
        } catch (error) {
          if (error instanceof BarterFormatError) throw invalidRequest(error.message);
          throw error;
        }
        if (r.circle !== circle.contract_id) throw invalidRequest("referral.circle harus akun kontrak lingkaran", { expected: circle.contract_id, got: r.circle });
        const nowS = nowSeconds(now());
        if (r.expires_at <= nowS) throw invalidRequest("expires_at sudah lewat", { expires_at: r.expires_at });
        const seekerKey = activeMemberKey(db, circle.circle_id, r.seeker);
        if (!verifyReferralSignature(r, signature, seekerKey)) {
          throw new ApiError(401, "invalid_signature", "Tanda tangan ajakan tidak cocok dengan kunci voucher pencari", { account: r.seeker });
        }
        activeMemberKey(db, circle.circle_id, r.to);

        const listing = findListing(db, circle.circle_id, r.listing_hash);
        const listingStatus = effectiveStatus(listing, nowS);
        if (listingStatus !== "open") throw new ApiError(409, "listing_not_open", `Listing berstatus ${listingStatus}`, { listingHash: listing.listing_hash, status: listingStatus });
        if (listing.discoverable !== 1n) throw invalidRequest("listing tidak membolehkan pencari (discoverable false)");
        if (r.to === listing.account_id) throw invalidRequest("ajakan tidak ditujukan ke pemasang listing");
        if (r.seeker === listing.account_id) throw invalidRequest("pencari bukan pemasang listing");
        if (BigInt(r.searcher_share_bps) > listing.discount_bps) throw invalidRequest("searcher_share_bps melebihi diskon listing", { discountBps: Number(listing.discount_bps) });
        if (r.mode === "pay" && listing.accept_payment !== 1n) throw invalidRequest("listing tidak menerima pembayaran (accept_payment false)");

        const refused = row<{ n: bigint }>(
          db, "SELECT COUNT(*) AS n FROM referrals WHERE circle_id = ? AND seeker = ? AND to_account = ? AND listing_hash = ? AND status = 'refused'",
          circle.circle_id, r.seeker, r.to, r.listing_hash,
        );
        if (refused && refused.n > 0n) throw new ApiError(409, "referral_refused", "Agent tujuan pernah menolak ajakan ini; pasangan ini tidak diajak lagi", { to: r.to, listingHash: r.listing_hash });
        const open = row<{ n: bigint }>(
          db, "SELECT COUNT(*) AS n FROM referrals WHERE circle_id = ? AND to_account = ? AND status = 'pending' AND expires_at > ?",
          circle.circle_id, r.to, nowS,
        );
        if (open && open.n >= BigInt(maxPending)) throw new ApiError(429, "rate_limited", "Kotak masuk agent tujuan penuh", { to: r.to, maxPending });
        const dup = row<{ n: bigint }>(
          db, "SELECT COUNT(*) AS n FROM referrals WHERE circle_id = ? AND seeker = ? AND to_account = ? AND listing_hash = ? AND status = 'pending' AND expires_at > ?",
          circle.circle_id, r.seeker, r.to, r.listing_hash, nowS,
        );
        if (dup && dup.n > 0n) throw new ApiError(409, "already_exists", "Sudah ada ajakan pending untuk pasangan ini", { to: r.to, listingHash: r.listing_hash });

        const hash = referralHash(r);
        const inserted = db
          .prepare(
            `INSERT OR IGNORE INTO referrals (circle_id, referral_hash, seeker, to_account, listing_hash, mode, value, quantity, deliver_by,
               searcher_share_bps, expires_at, nonce, signature, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(circle.circle_id, hash, r.seeker, r.to, r.listing_hash, r.mode, r.value, r.quantity, r.deliver_by, r.searcher_share_bps, r.expires_at, r.nonce, signature, now());
        if (inserted.changes === 0) throw new ApiError(409, "already_exists", "Ajakan dengan hash ini sudah tercatat", { referralHash: hash });
        return { status: 201, body: referralView(findReferral(db, circle.circle_id, hash), nowS) };
      },
    },
    {
      // Kotak masuk (`box=inbox`, default) atau ajakan terkirim (`box=sent`) satu akun.
      method: "GET",
      pattern: "/x207/circles/{circle}/referrals",
      circleScoped: true,
      handler: ({ db, circle, query, now }) => {
        const account = query.get("account");
        if (account === null) throw invalidRequest("account wajib diisi");
        const box = query.get("box") ?? "inbox";
        if (box !== "inbox" && box !== "sent") throw invalidRequest("box harus inbox atau sent", { box });
        const status = query.get("status") ?? "pending";
        if (!(STATUSES as readonly string[]).includes(status)) throw invalidRequest("status tidak dikenal", { status, allowed: STATUSES });
        const limit = parseLimit(query);
        const cursor = decodeCursor(query);
        const after = cursor && typeof cursor.a === "number" ? cursor.a : null;
        if (cursor && after === null) throw invalidRequest("cursor tidak valid");
        const nowS = nowSeconds(now());
        const where = ["circle_id = ?", box === "inbox" ? "to_account = ?" : "seeker = ?"];
        const args: unknown[] = [circle.circle_id, account];
        if (status === "pending") where.push("status = 'pending' AND expires_at > ?"), args.push(nowS);
        else if (status === "expired") where.push("status = 'pending' AND expires_at <= ?"), args.push(nowS);
        else if (status !== "all") where.push("status = ?"), args.push(status);
        if (after !== null) where.push("id > ?"), args.push(after);
        const found = rows<ReferralRow>(db, `SELECT * FROM referrals WHERE ${where.join(" AND ")} ORDER BY id LIMIT ?`, ...args, limit + 1);
        const page = found.slice(0, limit);
        const last = page[page.length - 1];
        return { status: 200, body: { items: page.map((r) => referralView(r, nowS)), nextCursor: found.length > limit && last ? encodeCursor({ a: Number(last.id) }) : null } };
      },
    },
    {
      method: "POST",
      pattern: "/x207/circles/{circle}/referrals/{hash}/refuse",
      circleScoped: true,
      handler: ({ db, circle, params, body, now }) => {
        const found = findReferral(db, circle.circle_id, params.hash as string);
        const signature = body !== null && typeof body === "object" ? (body as { signature?: unknown }).signature : undefined;
        if (typeof signature !== "string") throw invalidRequest("signature wajib string");
        const key = memberKeys(db, circle.circle_id, [found.to_account])[found.to_account];
        if (key === undefined || !verifyRefuseReferral(found.referral_hash, circle.contract_id, signature, key)) {
          throw new ApiError(401, "invalid_signature", "Penolakan harus ditandatangani agent tujuan", { account: found.to_account });
        }
        const nowS = nowSeconds(now());
        const status = statusOf(found, nowS);
        if (status !== "pending") throw new ApiError(409, "referral_not_open", `Ajakan berstatus ${status}`, { referralHash: found.referral_hash, status });
        db.prepare("UPDATE referrals SET status = 'refused' WHERE id = ?").run(found.id);
        return { status: 200, body: referralView(findReferral(db, circle.circle_id, found.referral_hash), nowS) };
      },
    },
  ];
}
