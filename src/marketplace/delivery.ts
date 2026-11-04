// Routes of the delivery flow (BE-047). See delivery-core.ts for the format and the states, and docs/delivery.md for the rules.
import type Database from "better-sqlite3";
import { ApiError, invalidRequest } from "../api/errors.js";
import { rows } from "../api/format.js";
import type { Route } from "../api/router.js";
import { activeMemberKey } from "./auth.js";
import { isoSeconds, nowSeconds } from "./common.js";
import { refreshProposalOfMatch, settleDeliveries } from "./bundles.js";
import { DEFAULT_BOND_THRESHOLD } from "./invoices.js";
import { findListing } from "./listings.js";
import {
  DEFAULT_DISPUTE_WINDOW_SECONDS, deliveryNoticeHash, DeliveryFormatError, findDeliveries, findDelivery, MAX_NOTICE_SKEW_SECONDS, validateDeliveryNotice,
  verifyDeliveryNoticeSignature, type DeliveryNotice, type DeliveryRow,
} from "./delivery-core.js";

interface NoticeRow {
  notice_hash: string;
  side: string;
  actor: string;
  action: string;
  at_s: bigint;
  proof_hash: string | null;
  reason: string | null;
  signature: string;
}

const iso = (s: bigint | null): string | null => (s === null ? null : isoSeconds(Number(s)));

function sideView(db: Database.Database, circleId: string, d: DeliveryRow) {
  const notices = rows<NoticeRow>(db, "SELECT * FROM delivery_notices WHERE circle_id = ? AND listing_hash = ? AND side = ? ORDER BY id", circleId, d.listing_hash, d.side);
  return {
    side: d.side,
    offerHash: d.offer_hash,
    deliverer: d.deliverer,
    receiver: d.receiver,
    state: d.state,
    deliverBy: isoSeconds(Number(d.deliver_by)),
    proofHash: d.proof_hash,
    deliveredAt: iso(d.delivered_at),
    confirmBy: iso(d.confirm_by),
    confirmedAt: iso(d.confirmed_at),
    // true when the receiver said nothing for the whole window and the passing of time confirmed it
    autoConfirmed: d.auto_confirmed === 1n,
    disputedAt: iso(d.disputed_at),
    disputeReason: d.dispute_reason,
    cancelledAt: iso(d.cancelled_at),
    cancelledBy: d.cancelled_by,
    notices: notices.map((n) => ({ noticeHash: n.notice_hash, actor: n.actor, action: n.action, at: isoSeconds(Number(n.at_s)), proofHash: n.proof_hash, reason: n.reason, signature: n.signature })),
  };
}

function matchView(db: Database.Database, circleId: string, listingHashHex: string, bondThreshold: bigint) {
  const list = findDeliveries(db, circleId, listingHashHex);
  const match = db.prepare("SELECT listing_value FROM matches WHERE circle_id = ? AND listing_hash = ? ORDER BY id DESC LIMIT 1").get(circleId, listingHashHex) as { listing_value: string | number | bigint } | undefined;
  return {
    listingHash: listingHashHex,
    // CT-094: a deal at or above the bond threshold asks for a bond (an arbiter). Only flagged here, like `needsBond` of invoices and orders; the bond itself is a bundle of two legs on the contract.
    needsBond: match !== undefined && BigInt(match.listing_value) >= bondThreshold,
    // the voucher or the bundle of this match may be registered only when this is true: every handover of the match is confirmed
    payable: list.every((d) => d.state === "confirmed"),
    deliveries: list.map((d) => sideView(db, circleId, d)),
  };
}

export function deliveryRoutes(options: { disputeWindowSeconds?: number; bondThreshold?: bigint } = {}): Route[] {
  const window = options.disputeWindowSeconds ?? DEFAULT_DISPUTE_WINDOW_SECONDS;
  const bondThreshold = options.bondThreshold ?? DEFAULT_BOND_THRESHOLD;
  return [
    {
      method: "GET",
      pattern: "/x207/circles/{circle}/listings/{hash}/delivery",
      circleScoped: true,
      handler: ({ db, circle, params, now }) => {
        const listing = findListing(db, circle.circle_id, params.hash as string);
        settleDeliveries(db, circle.circle_id, now());
        const view = matchView(db, circle.circle_id, listing.listing_hash, bondThreshold);
        if (view.deliveries.length === 0) {
          throw new ApiError(404, "delivery_not_found", "This listing has no delivery flow (not matched yet, or its asset class does not need one)", { listingHash: listing.listing_hash });
        }
        return { status: 200, body: view };
      },
    },
    {
      method: "POST",
      pattern: "/x207/circles/{circle}/listings/{hash}/delivery",
      circleScoped: true,
      handler: ({ db, circle, params, body, now }) => {
        const listing = findListing(db, circle.circle_id, params.hash as string);
        settleDeliveries(db, circle.circle_id, now());
        if (body === null || typeof body !== "object") throw invalidRequest("body must be an object");
        const { notice, signature } = body as { notice?: unknown; signature?: unknown };
        if (typeof signature !== "string") throw invalidRequest("signature must be a string");
        if (notice === null || typeof notice !== "object") throw invalidRequest("notice must be an object");
        const n = notice as DeliveryNotice;
        try {
          validateDeliveryNotice(n);
        } catch (error) {
          if (error instanceof DeliveryFormatError) throw invalidRequest(error.message);
          throw error;
        }
        const d = findDelivery(db, circle.circle_id, listing.listing_hash, n.side);
        if (!d) throw new ApiError(404, "delivery_not_found", `This match has no handover for side ${n.side}`, { listingHash: listing.listing_hash, side: n.side });
        if (n.circle !== circle.contract_id) throw invalidRequest("notice.circle must be the circle contract account", { expected: circle.contract_id, got: n.circle });
        if (n.listing_hash !== d.listing_hash || n.offer_hash !== d.offer_hash) throw invalidRequest("notice.listing_hash and offer_hash must be the ones from this match");
        const nowS = nowSeconds(now());
        if (Math.abs(n.at - nowS) > MAX_NOTICE_SKEW_SECONDS) throw invalidRequest(`notice.at is more than ${MAX_NOTICE_SKEW_SECONDS} seconds off the server clock`, { at: n.at, now: nowS });
        const pubkey = activeMemberKey(db, circle.circle_id, n.actor);
        if (!verifyDeliveryNoticeSignature(n, signature, pubkey)) {
          throw new ApiError(401, "invalid_signature", "Notice signature does not match the member's voucher key", { account: n.actor });
        }
        const isDeliverer = n.actor === d.deliverer;
        const isReceiver = n.actor === d.receiver;
        if (!isDeliverer && !isReceiver) throw new ApiError(403, "not_a_party", "Only the giver or receiver of this handover may send a notice", { actor: n.actor });
        const refuse = (message: string): never => {
          throw new ApiError(409, "delivery_state", message, { state: d.state, action: n.action });
        };

        let update: string;
        let args: unknown[];
        switch (n.action) {
          case "delivered":
            if (!isDeliverer) throw new ApiError(403, "not_a_party", "Only the giver marks it delivered", { actor: n.actor });
            if (d.state !== "awaiting") refuse(`delivered only from awaiting, current state ${d.state}`);
            update = "state = 'delivered', delivered_at = ?, confirm_by = ?, proof_hash = ?";
            args = [n.at, n.at + window, n.proof_hash];
            break;
          case "confirmed":
            if (!isReceiver) throw new ApiError(403, "not_a_party", "Only the receiver confirms", { actor: n.actor });
            if (d.state !== "delivered") refuse(`confirmed only from delivered, current state ${d.state}`);
            update = "state = 'confirmed', confirmed_at = ?";
            args = [n.at];
            break;
          case "disputed":
            if (!isReceiver) throw new ApiError(403, "not_a_party", "Only the receiver disputes", { actor: n.actor });
            if (d.state !== "delivered") refuse(`disputed only from delivered, current state ${d.state}`);
            if (n.at > Number(d.confirm_by)) refuse("the dispute window has passed");
            update = "state = 'disputed', disputed_at = ?, dispute_reason = ?";
            args = [n.at, n.reason];
            break;
          default:
            // the deliverer may withdraw until the receiver confirms; the receiver may cancel only when nothing came by `deliver_by`
            if (isDeliverer) {
              if (d.state !== "awaiting" && d.state !== "delivered") refuse(`cancelled by the giver only from awaiting or delivered, current state ${d.state}`);
            } else {
              if (d.state !== "awaiting") refuse(`cancelled by the receiver only from awaiting, current state ${d.state}`);
              if (nowS <= Number(d.deliver_by)) refuse("the receiver may cancel only after deliver_by");
            }
            update = "state = 'cancelled', cancelled_at = ?, cancelled_by = ?";
            args = [n.at, n.actor];
        }
        db.transaction(() => {
          const inserted = db
            .prepare(
              `INSERT OR IGNORE INTO delivery_notices (circle_id, listing_hash, side, notice_hash, actor, action, at_s, proof_hash, reason, signature, recorded_at_ms)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(circle.circle_id, d.listing_hash, d.side, deliveryNoticeHash(n), n.actor, n.action, n.at, n.proof_hash, n.reason, signature, now());
          if (inserted.changes === 0) throw new ApiError(409, "already_exists", "This notice is already recorded", {});
          db.prepare(`UPDATE deliveries SET ${update} WHERE id = ?`).run(...args, d.id);
          if (n.action === "confirmed") refreshProposalOfMatch(db, circle.circle_id, d.match_id);
        })();
        return { status: 201, body: matchView(db, circle.circle_id, listing.listing_hash, bondThreshold) };
      },
    },
  ];
}
