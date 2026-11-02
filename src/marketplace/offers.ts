// Negosiasi (BE-041, F9): penawaran dan penawaran balik bertanda tangan per ronde.
// Utas = (listing, lawan): ronde 1 dari lawan, lalu bergantian dengan pemasang. `inReplyTo` (hash penawaran sebelumnya) adalah
// metadata routing di luar byte yang ditandatangani; nilai baru berlaku hanya setelah penerimaan menjadi usulan bundle (bundles.ts).
import type Database from "better-sqlite3";
import { BarterFormatError, offerHash, validateOffer, verifyOfferSignature, type Offer } from "@x207/core";
import { ApiError, invalidRequest } from "../api/errors.js";
import { row, rows } from "../api/format.js";
import { decodeCursor, encodeCursor, parseLimit } from "../api/pagination.js";
import type { Route } from "../api/router.js";
import { activeMemberKey } from "./auth.js";
import { isoSeconds, nowSeconds } from "./common.js";
import { effectiveStatus, findListing } from "./listings.js";

export const DEFAULT_MAX_ROUNDS = 10;
const OFFER_STATUSES = ["pending", "countered", "accepted", "closed", "all"] as const;
const HASH = /^[0-9a-f]{64}$/;

export interface OfferRow {
  id: bigint;
  offer_hash: string;
  listing_hash: string;
  proposer: string;
  counterparty: string;
  awaiting: string;
  round: bigint;
  mode: string;
  value: string;
  quantity: bigint;
  deliver_by: bigint;
  signature: string;
  in_reply_to: string | null;
  status: string;
  created_at_ms: bigint;
}

export function offerView(r: OfferRow) {
  return {
    offerHash: r.offer_hash,
    listingHash: r.listing_hash,
    proposer: r.proposer,
    counterparty: r.counterparty,
    awaiting: r.awaiting,
    round: Number(r.round),
    mode: r.mode,
    value: r.value,
    quantity: Number(r.quantity),
    deliverBy: isoSeconds(Number(r.deliver_by)),
    signature: r.signature,
    inReplyTo: r.in_reply_to,
    status: r.status,
  };
}

export function findOffer(db: Database.Database, circleId: string, listingHashHex: string, hash: string): OfferRow {
  if (!HASH.test(hash)) throw invalidRequest("hash penawaran harus 64 karakter heksadesimal huruf kecil", { hash });
  const found = row<OfferRow>(db, "SELECT * FROM offers WHERE circle_id = ? AND listing_hash = ? AND offer_hash = ?", circleId, listingHashHex, hash);
  if (!found) throw new ApiError(404, "offer_not_found", `Penawaran ${hash} tidak ada`, { offerHash: hash });
  return found;
}

function parseOfferBody(body: unknown): { offer: Offer; signature: string; inReplyTo: string | null } {
  if (body === null || typeof body !== "object") throw invalidRequest("body harus objek");
  const { offer, signature, inReplyTo } = body as { offer?: unknown; signature?: unknown; inReplyTo?: unknown };
  if (typeof signature !== "string") throw invalidRequest("signature wajib string");
  if (offer === null || typeof offer !== "object") throw invalidRequest("offer wajib objek");
  if (inReplyTo !== undefined && inReplyTo !== null && (typeof inReplyTo !== "string" || !HASH.test(inReplyTo))) {
    throw invalidRequest("inReplyTo harus hash penawaran 64 karakter heksadesimal huruf kecil");
  }
  return { offer: offer as Offer, signature, inReplyTo: (inReplyTo as string | null | undefined) ?? null };
}

export function offerRoutes(options: { maxRounds?: number } = {}): Route[] {
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  return [
    {
      method: "POST",
      pattern: "/x207/circles/{circle}/listings/{hash}/offers",
      circleScoped: true,
      handler: ({ db, circle, params, body, now }) => {
        const listing = findListing(db, circle.circle_id, params.hash as string);
        const { offer, signature, inReplyTo } = parseOfferBody(body);
        try {
          validateOffer(offer);
        } catch (error) {
          if (error instanceof BarterFormatError) throw invalidRequest(error.message);
          throw error;
        }
        if (offer.circle !== circle.contract_id) throw invalidRequest("offer.circle harus akun kontrak lingkaran", { expected: circle.contract_id, got: offer.circle });
        if (offer.listing_hash !== listing.listing_hash) throw invalidRequest("offer.listing_hash tidak sama dengan listing di path");
        const nowS = nowSeconds(now());
        const status = effectiveStatus(listing, nowS);
        if (status !== "open") throw new ApiError(409, "listing_not_open", `Listing berstatus ${status}`, { listingHash: listing.listing_hash, status });
        if (offer.mode === "pay" && listing.accept_payment !== 1n) throw invalidRequest("listing tidak menerima pembayaran (accept_payment false)");
        if (offer.round > maxRounds) throw new ApiError(409, "negotiation_closed", `Ronde maksimal ${maxRounds}`, { maxRounds, round: offer.round });
        const pubkey = activeMemberKey(db, circle.circle_id, offer.proposer);
        if (!verifyOfferSignature(offer, signature, pubkey)) {
          throw new ApiError(401, "invalid_signature", "Tanda tangan penawaran tidak cocok dengan kunci voucher anggota", { account: offer.proposer });
        }

        let counterparty: string;
        let awaiting: string;
        let previous: OfferRow | undefined;
        if (offer.round === 1) {
          if (inReplyTo !== null) throw invalidRequest("ronde 1 tidak membalas penawaran lain");
          if (offer.proposer === listing.account_id) throw invalidRequest("pemasang listing tidak menawar listingnya sendiri");
          const existing = row<{ n: bigint }>(db, "SELECT COUNT(*) AS n FROM offers WHERE circle_id = ? AND listing_hash = ? AND counterparty = ?", circle.circle_id, listing.listing_hash, offer.proposer);
          if (existing && existing.n > 0n) throw new ApiError(409, "already_exists", "Sudah ada utas negosiasi dari akun ini untuk listing ini", { counterparty: offer.proposer });
          counterparty = offer.proposer;
          awaiting = listing.account_id;
        } else {
          if (inReplyTo === null) throw invalidRequest("ronde berikutnya wajib menyertakan inReplyTo");
          previous = findOffer(db, circle.circle_id, listing.listing_hash, inReplyTo);
          if (previous.status !== "pending") throw new ApiError(409, "offer_not_open", `Penawaran sebelumnya berstatus ${previous.status}`, { offerHash: previous.offer_hash, status: previous.status });
          if (BigInt(offer.round) !== previous.round + 1n) throw invalidRequest("round harus naik satu dari penawaran sebelumnya", { expected: Number(previous.round) + 1 });
          if (offer.proposer !== previous.awaiting) throw invalidRequest("ronde berikutnya harus dari pihak lawan", { expected: previous.awaiting });
          counterparty = previous.counterparty;
          awaiting = previous.proposer;
        }
        const hash = offerHash(offer);
        const inserted = db
          .prepare(
            `INSERT OR IGNORE INTO offers (circle_id, offer_hash, listing_hash, proposer, counterparty, awaiting, round, mode, value, quantity,
               deliver_by, signature, in_reply_to, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(circle.circle_id, hash, listing.listing_hash, offer.proposer, counterparty, awaiting, offer.round, offer.mode, offer.value,
            offer.quantity, offer.deliver_by, signature, inReplyTo, now());
        if (inserted.changes === 0) throw new ApiError(409, "already_exists", "Penawaran dengan hash ini sudah tercatat", { offerHash: hash });
        if (previous) db.prepare("UPDATE offers SET status = 'countered' WHERE id = ?").run(previous.id);
        return { status: 201, body: offerView(findOffer(db, circle.circle_id, listing.listing_hash, hash)) };
      },
    },
    {
      method: "GET",
      pattern: "/x207/circles/{circle}/listings/{hash}/offers",
      circleScoped: true,
      handler: ({ db, circle, params, query }) => {
        const listing = findListing(db, circle.circle_id, params.hash as string);
        const status = query.get("status") ?? "all";
        if (!(OFFER_STATUSES as readonly string[]).includes(status)) throw invalidRequest("status tidak dikenal", { status, allowed: OFFER_STATUSES });
        const where = ["circle_id = ?", "listing_hash = ?"];
        const args: unknown[] = [circle.circle_id, listing.listing_hash];
        if (status !== "all") where.push("status = ?"), args.push(status);
        const counterparty = query.get("counterparty");
        if (counterparty !== null) where.push("counterparty = ?"), args.push(counterparty);
        const found = rows<OfferRow>(db, `SELECT * FROM offers WHERE ${where.join(" AND ")} ORDER BY counterparty, round`, ...args);
        return { status: 200, body: { items: found.map(offerView) } };
      },
    },
    {
      // Kotak masuk per agent (FIT-F9-08): penawaran yang menunggu jawaban akun ini, atau `box=sent` untuk yang ia kirim.
      method: "GET",
      pattern: "/x207/circles/{circle}/offers",
      circleScoped: true,
      handler: ({ db, circle, query, now }) => {
        const account = query.get("account");
        if (account === null) throw invalidRequest("account wajib diisi");
        const box = query.get("box") ?? "inbox";
        if (box !== "inbox" && box !== "sent") throw invalidRequest("box harus inbox atau sent", { box });
        const status = query.get("status") ?? "pending";
        if (!(OFFER_STATUSES as readonly string[]).includes(status)) throw invalidRequest("status tidak dikenal", { status, allowed: OFFER_STATUSES });
        const limit = parseLimit(query);
        const cursor = decodeCursor(query);
        const after = cursor && typeof cursor.a === "number" ? cursor.a : null;
        if (cursor && after === null) throw invalidRequest("cursor tidak valid");
        const where = ["o.circle_id = ?", box === "inbox" ? "o.awaiting = ?" : "o.proposer = ?"];
        const args: unknown[] = [circle.circle_id, account];
        if (status !== "all") where.push("o.status = ?"), args.push(status);
        // Tawaran menunggu hilang dari kotak masuk bersama listing yang kedaluwarsa.
        if (status === "pending") where.push("l.status = 'open' AND l.expires_at > ?"), args.push(nowSeconds(now()));
        if (after !== null) where.push("o.id > ?"), args.push(after);
        const found = rows<OfferRow>(
          db,
          `SELECT o.* FROM offers o JOIN listings l ON l.circle_id = o.circle_id AND l.listing_hash = o.listing_hash
           WHERE ${where.join(" AND ")} ORDER BY o.id LIMIT ?`,
          ...args,
          limit + 1,
        );
        const page = found.slice(0, limit);
        const last = page[page.length - 1];
        return { status: 200, body: { items: page.map(offerView), nextCursor: found.length > limit && last ? encodeCursor({ a: Number(last.id) }) : null } };
      },
    },
  ];
}
