// Negotiation (BE-041, F9): signed offers and counter-offers per round.
// Thread = (listing, counterparty): round 1 from the counterparty, then alternating with the lister. `inReplyTo` (hash of the previous offer) is
// routing metadata outside the signed bytes; new values only take effect once the acceptance becomes a bundle proposal (bundles.ts).
import type Database from "better-sqlite3";
import { BarterFormatError, offerHash, validateOffer, verifyOfferSignature, type Offer } from "@x207/core";
import { ApiError, invalidRequest } from "../api/errors.js";
import { row, rows } from "../api/format.js";
import { decodeCursor, encodeCursor, parseLimit } from "../api/pagination.js";
import type { Route } from "../api/router.js";
import { activeMemberKey } from "./auth.js";
import { isoSeconds, nowSeconds } from "./common.js";
import { effectiveStatus, findListing } from "./listings.js";
import { findReferral } from "./referrals.js";

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
  referral_hash?: string | null;
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
  if (!HASH.test(hash)) throw invalidRequest("offer hash must be 64 lowercase hex characters", { hash });
  const found = row<OfferRow>(db, "SELECT * FROM offers WHERE circle_id = ? AND listing_hash = ? AND offer_hash = ?", circleId, listingHashHex, hash);
  if (!found) throw new ApiError(404, "offer_not_found", `Offer ${hash} not found`, { offerHash: hash });
  return found;
}

function parseOfferBody(body: unknown): { offer: Offer; signature: string; inReplyTo: string | null; referralHash: string | null } {
  if (body === null || typeof body !== "object") throw invalidRequest("body must be an object");
  const { offer, signature, inReplyTo, referralHash } = body as { offer?: unknown; signature?: unknown; inReplyTo?: unknown; referralHash?: unknown };
  if (referralHash !== undefined && referralHash !== null && (typeof referralHash !== "string" || !HASH.test(referralHash))) {
    throw invalidRequest("referralHash must be a 64-character lowercase hex referral hash");
  }
  if (typeof signature !== "string") throw invalidRequest("signature must be a string");
  if (offer === null || typeof offer !== "object") throw invalidRequest("offer must be an object");
  if (inReplyTo !== undefined && inReplyTo !== null && (typeof inReplyTo !== "string" || !HASH.test(inReplyTo))) {
    throw invalidRequest("inReplyTo must be a 64-character lowercase hex offer hash");
  }
  return { offer: offer as Offer, signature, inReplyTo: (inReplyTo as string | null | undefined) ?? null, referralHash: (referralHash as string | null | undefined) ?? null };
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
        const { offer, signature, inReplyTo, referralHash } = parseOfferBody(body);
        try {
          validateOffer(offer);
        } catch (error) {
          if (error instanceof BarterFormatError) throw invalidRequest(error.message);
          throw error;
        }
        if (offer.circle !== circle.contract_id) throw invalidRequest("offer.circle must be the circle contract account", { expected: circle.contract_id, got: offer.circle });
        if (offer.listing_hash !== listing.listing_hash) throw invalidRequest("offer.listing_hash does not match the listing in the path");
        const nowS = nowSeconds(now());
        const status = effectiveStatus(listing, nowS);
        if (status !== "open") throw new ApiError(409, "listing_not_open", `Listing is ${status}`, { listingHash: listing.listing_hash, status });
        if (offer.mode === "pay" && listing.accept_payment !== 1n) throw invalidRequest("listing does not accept payment (accept_payment false)");
        if (offer.round > maxRounds) throw new ApiError(409, "negotiation_closed", `Maximum round is ${maxRounds}`, { maxRounds, round: offer.round });
        const pubkey = activeMemberKey(db, circle.circle_id, offer.proposer);
        if (!verifyOfferSignature(offer, signature, pubkey)) {
          throw new ApiError(401, "invalid_signature", "Offer signature does not match the member's voucher key", { account: offer.proposer });
        }

        let counterparty: string;
        let awaiting: string;
        let previous: OfferRow | undefined;
        if (offer.round === 1) {
          if (inReplyTo !== null) throw invalidRequest("round 1 does not reply to another offer");
          if (offer.proposer === listing.account_id) throw invalidRequest("the listing poster cannot make an offer on their own listing");
          const existing = row<{ n: bigint }>(db, "SELECT COUNT(*) AS n FROM offers WHERE circle_id = ? AND listing_hash = ? AND counterparty = ?", circle.circle_id, listing.listing_hash, offer.proposer);
          if (existing && existing.n > 0n) throw new ApiError(409, "already_exists", "A negotiation thread from this account already exists for this listing", { counterparty: offer.proposer });
          counterparty = offer.proposer;
          awaiting = listing.account_id;
        } else {
          if (inReplyTo === null) throw invalidRequest("later rounds must include inReplyTo");
          previous = findOffer(db, circle.circle_id, listing.listing_hash, inReplyTo);
          if (previous.status !== "pending") throw new ApiError(409, "offer_not_open", `Previous offer is ${previous.status}`, { offerHash: previous.offer_hash, status: previous.status });
          if (BigInt(offer.round) !== previous.round + 1n) throw invalidRequest("round must increase by one from the previous offer", { expected: Number(previous.round) + 1 });
          if (offer.proposer !== previous.awaiting) throw invalidRequest("later rounds must come from the other party", { expected: previous.awaiting });
          counterparty = previous.counterparty;
          awaiting = previous.proposer;
        }
        // Searcher referral (BE-044): a round 1 offer that refers to a referral must equal the referral's content, and the referral must still be pending
        if (referralHash !== null) {
          if (offer.round !== 1) throw invalidRequest("referralHash is only for round 1 offers");
          const referral = findReferral(db, circle.circle_id, referralHash);
          const state = referral.status === "pending" && Number(referral.expires_at) <= nowS ? "expired" : referral.status;
          if (state !== "pending") throw new ApiError(409, "referral_not_open", `Referral is ${state}`, { referralHash, status: state });
          if (referral.to_account !== offer.proposer) throw invalidRequest("this referral is addressed to another agent", { to: referral.to_account });
          if (referral.listing_hash !== listing.listing_hash) throw invalidRequest("this referral is for another listing");
          if (referral.mode !== offer.mode || referral.value !== offer.value || Number(referral.quantity) !== offer.quantity) {
            throw invalidRequest("the offer must match the referral (mode, value, quantity)", { mode: referral.mode, value: referral.value, quantity: Number(referral.quantity) });
          }
        }
        const hash = offerHash(offer);
        const inserted = db
          .prepare(
            `INSERT OR IGNORE INTO offers (circle_id, offer_hash, listing_hash, proposer, counterparty, awaiting, round, mode, value, quantity,
               deliver_by, signature, in_reply_to, referral_hash, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(circle.circle_id, hash, listing.listing_hash, offer.proposer, counterparty, awaiting, offer.round, offer.mode, offer.value,
            offer.quantity, offer.deliver_by, signature, inReplyTo, referralHash, now());
        if (inserted.changes === 0) throw new ApiError(409, "already_exists", "An offer with this hash is already recorded", { offerHash: hash });
        if (referralHash !== null) db.prepare("UPDATE referrals SET status = 'taken', offer_hash = ? WHERE circle_id = ? AND referral_hash = ?").run(hash, circle.circle_id, referralHash);
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
        if (!(OFFER_STATUSES as readonly string[]).includes(status)) throw invalidRequest("status is not recognized", { status, allowed: OFFER_STATUSES });
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
      // Inbox per agent (FIT-F9-08): offers waiting for an answer from this account, or `box=sent` for the ones it sent.
      method: "GET",
      pattern: "/x207/circles/{circle}/offers",
      circleScoped: true,
      handler: ({ db, circle, query, now }) => {
        const account = query.get("account");
        if (account === null) throw invalidRequest("account is required");
        const box = query.get("box") ?? "inbox";
        if (box !== "inbox" && box !== "sent") throw invalidRequest("box must be inbox or sent", { box });
        const status = query.get("status") ?? "pending";
        if (!(OFFER_STATUSES as readonly string[]).includes(status)) throw invalidRequest("status is not recognized", { status, allowed: OFFER_STATUSES });
        const limit = parseLimit(query);
        const cursor = decodeCursor(query);
        const after = cursor && typeof cursor.a === "number" ? cursor.a : null;
        if (cursor && after === null) throw invalidRequest("cursor is not valid");
        const where = ["o.circle_id = ?", box === "inbox" ? "o.awaiting = ?" : "o.proposer = ?"];
        const args: unknown[] = [circle.circle_id, account];
        if (status !== "all") where.push("o.status = ?"), args.push(status);
        // A pending offer disappears from the inbox together with the expired listing.
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
