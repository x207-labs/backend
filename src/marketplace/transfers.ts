// The transfer ledger (BE-074, P4, ADR-49): a domain, a game item or a ticket changes hands through the OFFICIAL feature of its platform, and the voucher of the buyer is held here until the
// proof of the platform is met. Three proofs (`transfer-proofs.ts`): `dns_txt` for a domain (the seller shows control with the TXT `x207-sell=<listing_hash>` BEFORE the listing, the buyer
// with `x207-own=<purchase_id>` AFTER the transfer, and RDAP must show a settled domain), `trade_api` for a game item (the trade offer is `accepted` and its hold is over), `buyer_confirm`
// for a ticket. The window per platform: domain 7 days, ticket 1 day, game item 1 hour; when it passes without the proof the purchase is `cancelled` and the voucher never moves.
// A value at or above `bond_threshold` is a bundle of two legs with an arbiter (CT-094), not this ledger. A website or an online store (#67) is on the roadmap only.
import type Database from "better-sqlite3";
import {
  normalizeTransfer, TRANSFER_WINDOW_SECONDS, transferDocumentHash, TransferError, transferNeedsBond, transferResource, verifyVoucher,
  type Listing, type TransferDocument, type TransferPlatform, type UnsignedVoucher, type Voucher,
} from "@x207/core";
import { assertOpenRoom, DEFAULT_OPEN } from "../api/abuse.js";
import type { OpenLimits } from "../api/abuse.js";
import { ApiError, invalidRequest } from "../api/errors.js";
import { row, rows } from "../api/format.js";
import type { Route } from "../api/router.js";
import { activeMemberKey } from "./auth.js";
import { nowSeconds } from "./common.js";
import type { OpenEpochResolver } from "./epoch.js";
import { findListing, type ListingAsyncCheck, type ListingCheck } from "./listings.js";
import { NOTICE_SKEW_SECONDS, verifyNoticeJson } from "./notice.js";
import { DnsTxtProof, TradeApiProof, type ProofVerdict } from "./transfer-proofs.js";
import { ROADMAP_ONLY_ASSET_TYPES, TRANSFER_ASSET_TYPES, transferDetail } from "./transfer-types.js";

export interface TransferOptions {
  /** Value from which a transfer needs the bond of CT-094 and so a bundle of two legs; smallest unit, default 100 credit. */
  transferBondThreshold?: string;
  dnsTxt?: DnsTxtProof;
  tradeApi?: TradeApiProof;
  openLimits?: Partial<OpenLimits>;
  /** At least this many seconds between two checks of the proof of one transfer (they ask the outside); default 15. */
  proofMinSeconds?: number;
}

const refuse = (status: number, code: ApiError["code"], message: string, details: Record<string, unknown> = {}): never => {
  throw new ApiError(status, code, message, details);
};

// ---- the listing -----------------------------------------------------------------------------------------------------------------------------------------------------------

function documentOf(listing: Listing, d: Record<string, unknown>): TransferDocument {
  return {
    circle: listing.circle, seller: listing.account, platform: d.platform as TransferPlatform, transfer_ref: String(d.transfer_ref), proof_method: d.proof_method as TransferDocument["proof_method"],
    estimate_seconds: Number(d.estimate_seconds), value: listing.offer.value, nonce: String(d.nonce),
  };
}

/** The form of a transfer listing; `asset_roadmap_only` for a website or an online store. */
export const transferCheck = (options: TransferOptions = {}): ListingCheck => (listing) => {
  const assetType = (listing as { offer?: { asset_type?: unknown } }).offer?.asset_type;
  if (typeof assetType !== "string") return;
  if (ROADMAP_ONLY_ASSET_TYPES.has(assetType)) refuse(400, "asset_roadmap_only", `${assetType} (a website or an online store) is on the roadmap only; it is not sold through x207 yet`, { assetType });
  const platform = TRANSFER_ASSET_TYPES[assetType];
  if (platform === undefined) return;
  const d = transferDetail(String((listing as { detail?: unknown }).detail ?? ""));
  if (d === null) return refuse(400, "transfer_bad_platform", `a listing of ${assetType} needs detail {"kind":"transfer", ...}`, { assetType });
  if (d.platform !== platform) refuse(400, "transfer_bad_platform", `platform must be ${platform} for ${assetType}`, { platform: d.platform ?? null });
  if (listing.offer.quantity !== 1) refuse(400, "transfer_bad_value", "a transfer is one thing: offer.quantity must be 1", { quantity: listing.offer.quantity });
  // the format and its errors are the ones of the SDK (SD-077): the document of the listing is normalized there and a `TransferError` keeps its code
  try {
    const doc = normalizeTransfer(documentOf(listing, d));
    if (transferNeedsBond(doc, options.transferBondThreshold)) refuse(400, "transfer_arbiter_required", "a value at or above the bond threshold is a bundle of two legs with an arbiter, not a single transfer", { value: listing.offer.value });
  } catch (error) {
    if (error instanceof TransferError) refuse(400, error.code, error.message.replace(/^transfer_[a-z_]+: /, ""), {});
    throw error;
  }
  if (d.transfer_doc !== transferDocumentHash(documentOf(listing, d))) refuse(400, "transfer_bad_hash", "transfer_doc is not the hash of the transfer document of this listing", {});
};

/** A domain is listed only by the one who controls it: `x207-sell=<listing_hash>` must already be in the TXT of the name. */
export const transferSellerCheck = (options: TransferOptions = {}): ListingAsyncCheck => async (listing, hash) => {
  const d = transferDetail(String((listing as { detail?: unknown }).detail ?? ""));
  if (d === null || TRANSFER_ASSET_TYPES[(listing as { offer: { asset_type: string } }).offer.asset_type] !== "domain") return;
  if (options.dnsTxt === undefined) return refuse(501, "transfer_proof_not_configured", "this backend has no DNS proof for domains", {});
  const verdict = await options.dnsTxt.sellerControls(String(d.transfer_ref), hash);
  if (verdict.status === "unavailable") refuse(503, "transfer_platform_unavailable", "the DNS did not answer; try again", verdict.detail);
  if (verdict.status === "pending") refuse(409, "transfer_seller_unproven", `set the TXT record ${String(verdict.detail.want)} on ${String(d.transfer_ref)} before listing`, verdict.detail);
};

// ---- the purchase ----------------------------------------------------------------------------------------------------------------------------------------------------------

interface TransferRow {
  id: bigint; circle_id: string; listing_hash: string; buyer: string; seller: string; platform: TransferPlatform; proof_method: string; transfer_ref: string; buyer_ref: string | null;
  tradeoffer_id: string | null; voucher_json: string; voucher_signature: string; status: string; window_until: bigint; proof_json: string | null; cancel_reason: string | null;
  created_at_ms: bigint; closed_at_ms: bigint | null;
}

function findTransfer(db: Database.Database, circleId: string, id: string): TransferRow {
  const found = /^\d{1,15}$/.test(id) ? row<TransferRow>(db, "SELECT * FROM transfers WHERE circle_id = ? AND id = ?", circleId, Number(id)) : undefined;
  if (!found) throw new ApiError(404, "transfer_not_found", `Transfer ${id} not found`, { transferId: id });
  return found;
}

function view(t: TransferRow) {
  return {
    transferId: Number(t.id), listingHash: t.listing_hash, buyer: t.buyer, seller: t.seller, platform: t.platform, proofMethod: t.proof_method, transferRef: t.transfer_ref,
    status: t.status, windowUntil: Number(t.window_until), tradeOfferId: t.tradeoffer_id, proof: t.proof_json === null ? null : (JSON.parse(t.proof_json) as unknown), cancelReason: t.cancel_reason,
    // the voucher is shown to the seller side only when the proof is met; until then it is held, and if the window passes it never moves
    ...(t.status === "confirmed" ? { voucher: JSON.parse(t.voucher_json) as UnsignedVoucher, voucherSignature: t.voucher_signature } : {}),
  };
}

/** A purchase whose window passed without the proof is cancelled: the voucher never moves. Lazy, on every read. */
function settle(db: Database.Database, circleId: string, nowS: number, nowMs: number): void {
  db.prepare("UPDATE transfers SET status = 'cancelled', cancel_reason = 'transfer_window_passed', closed_at_ms = ? WHERE circle_id = ? AND status = 'paid_held' AND window_until < ?").run(nowMs, circleId, nowS);
}

/** The vouchers of one pair that purchases and transfers still hold count as the state of the pair (B7-C3). */
function heldBaseline(db: Database.Database, circleId: string, payer: string, payee: string, epoch: number): { seq: bigint; cumulative: bigint } {
  let seq = 0n;
  let cumulative = 0n;
  const own = row<{ seq: bigint; cumulative_amount: bigint }>(db, "SELECT seq, cumulative_amount FROM obligations WHERE circle_id = ? AND epoch = ? AND debtor = ? AND creditor = ?", circleId, epoch, payer, payee);
  if (own) {
    seq = own.seq;
    cumulative = own.cumulative_amount;
  }
  const held = [
    ...rows<{ voucher_json: string }>(db, "SELECT voucher_json FROM purchases WHERE circle_id = ? AND buyer = ? AND seller = ? AND status <> 'cancelled'", circleId, payer, payee),
    ...rows<{ voucher_json: string }>(db, "SELECT voucher_json FROM transfers WHERE circle_id = ? AND buyer = ? AND seller = ? AND status <> 'cancelled'", circleId, payer, payee),
  ];
  for (const h of held) {
    const v = JSON.parse(h.voucher_json) as UnsignedVoucher;
    if (v.epoch !== epoch) continue;
    if (BigInt(v.seq) > seq) seq = BigInt(v.seq);
    if (BigInt(v.cumulativeAmount) > cumulative) cumulative = BigInt(v.cumulativeAmount);
  }
  return { seq, cumulative };
}

export function transferRoutes(resolveOpen: OpenEpochResolver, options: TransferOptions = {}): Route[] {
  const minGap = (options.proofMinSeconds ?? 30) * 1000;
  const adapterFor = (t: TransferRow): void => {
    if (t.proof_method === "dns_txt" && options.dnsTxt === undefined) refuse(501, "transfer_proof_not_configured", "this backend has no DNS proof for domains", {});
    if (t.proof_method === "trade_api" && options.tradeApi === undefined) refuse(501, "transfer_proof_not_configured", "this backend has no trade API key (X207_STEAM_API_KEY)", {});
  };
  const confirm = (db: Database.Database, t: TransferRow, nowMs: number, proof: Record<string, unknown>): void => {
    db.transaction(() => {
      db.prepare("UPDATE transfers SET status = 'confirmed', proof_json = ?, closed_at_ms = ? WHERE id = ? AND status = 'paid_held'").run(JSON.stringify(proof), nowMs, t.id);
      // the thing is sold: nobody else buys it
      db.prepare("UPDATE listings SET status = 'matched', closed_at_ms = ? WHERE circle_id = ? AND listing_hash = ? AND status = 'open'").run(nowMs, t.circle_id, t.listing_hash);
    })();
  };

  return [
    {
      method: "POST",
      pattern: "/x207/circles/{circle}/listings/{hash}/transfers",
      circleScoped: true,
      handler: async ({ db, circle, params, body, now }) => {
        settle(db, circle.circle_id, nowSeconds(now()), now());
        const listing = findListing(db, circle.circle_id, params.hash as string);
        if (listing.status !== "open" || Number(listing.expires_at) <= nowSeconds(now())) refuse(409, "listing_not_open", "Listing is not open", { listingHash: listing.listing_hash, status: listing.status });
        const d = transferDetail(listing.detail);
        if (d === null) return refuse(400, "transfer_bad_platform", "this listing is not a transfer listing", {});
        const platform = d.platform as TransferPlatform;
        const { voucher, signature, buyer_ref: buyerRef } = (body ?? {}) as { voucher?: Record<string, unknown>; signature?: unknown; buyer_ref?: unknown };
        if (voucher === null || typeof voucher !== "object" || typeof signature !== "string") throw invalidRequest("voucher and signature are required");
        const v = voucher as unknown as UnsignedVoucher;
        if (v.circle !== circle.contract_id) throw invalidRequest("voucher.circle must be the circle contract account", { expected: circle.contract_id, got: v.circle });
        if (v.payee !== listing.account_id) throw invalidRequest("voucher.payee must be the listing seller", { expected: listing.account_id });
        if (v.payer === v.payee) throw invalidRequest("buyer must not be the seller");
        const expected = transferResource(String(d.transfer_doc));
        if (v.resource !== expected) refuse(400, "transfer_bad_resource", "voucher.resource must be x207:transfer:<transfer_doc>", { expected });
        if (platform === "game_item" && !(typeof buyerRef === "string" && /^\d{1,20}$/.test(buyerRef))) throw invalidRequest("buyer_ref is the Steam account id of the buyer (digits) for a game item");
        const key = activeMemberKey(db, circle.circle_id, v.payer);
        if (!verifyVoucher({ ...v, signature } as Voucher, key)) throw new ApiError(401, "invalid_signature", "Voucher signature does not match the buyer's voucher key", { account: v.payer });
        const open = await resolveOpen(db, circle);
        if (open === null || v.epoch !== open) throw new ApiError(409, "epoch_not_open", "Voucher must be for the current open epoch", { expected: open, got: v.epoch });
        const price = BigInt(listing.offer_value);
        const base = heldBaseline(db, circle.circle_id, v.payer, v.payee, v.epoch);
        if (BigInt(v.seq) <= base.seq || BigInt(v.cumulativeAmount) - base.cumulative < price) {
          throw invalidRequest("voucher must continue the pair state (seq increases, counting the vouchers that purchases and transfers still hold) and add at least the listing price", { price: price.toString() });
        }
        if (row(db, "SELECT 1 AS x FROM transfers WHERE circle_id = ? AND listing_hash = ? AND status IN ('paid_held','confirmed')", circle.circle_id, listing.listing_hash)) {
          refuse(409, "exclusive_taken", "This thing already has a buyer whose transfer is open or done", { listingHash: listing.listing_hash });
        }
        assertOpenRoom(db, "SELECT COUNT(*) AS n FROM transfers WHERE circle_id = ? AND buyer = ? AND status = 'paid_held'", [circle.circle_id, v.payer], options.openLimits?.purchases ?? DEFAULT_OPEN.purchases, "transfers", v.payer);
        const id = db
          .prepare(
            `INSERT INTO transfers (circle_id, listing_hash, buyer, seller, platform, proof_method, transfer_ref, buyer_ref, voucher_json, voucher_signature, window_until, created_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(circle.circle_id, listing.listing_hash, v.payer, listing.account_id, platform, d.proof_method, d.transfer_ref, typeof buyerRef === "string" ? buyerRef : null, JSON.stringify(v), signature,
            nowSeconds(now()) + TRANSFER_WINDOW_SECONDS[platform], now()).lastInsertRowid;
        const created = findTransfer(db, circle.circle_id, String(id));
        const instructions = platform === "domain" ? { setTxtAfterTransfer: `x207-own=${created.id}`, on: created.transfer_ref } : null;
        return { status: 201, body: { ...view(created), ...(instructions ? { instructions } : {}) } };
      },
    },
    {
      method: "GET",
      pattern: "/x207/circles/{circle}/transfers/{id}",
      circleScoped: true,
      handler: ({ db, circle, params, now }) => {
        settle(db, circle.circle_id, nowSeconds(now()), now());
        return { status: 200, body: view(findTransfer(db, circle.circle_id, params.id as string)) };
      },
    },
    {
      // the proof of `dns_txt` and `trade_api`: objective, so it needs no signature, but it asks the outside and is limited to one check each `proofMinSeconds`
      method: "POST",
      pattern: "/x207/circles/{circle}/transfers/{id}/proof",
      circleScoped: true,
      handler: async ({ db, circle, params, body, now }) => {
        const nowS = nowSeconds(now());
        settle(db, circle.circle_id, nowS, now());
        let t = findTransfer(db, circle.circle_id, params.id as string);
        if (t.status === "confirmed") return { status: 200, body: view(t) };
        if (t.status === "cancelled") return refuse(409, "transfer_window_passed", "The window of this transfer passed without the proof; the purchase is cancelled and the voucher did not move", { windowUntil: Number(t.window_until) });
        if (t.proof_method === "buyer_confirm") return refuse(400, "transfer_bad_method", "a ticket is proved by the buyer: post the signed notice to /transfers/{id}", {});
        adapterFor(t);
        const asked = (body ?? {}) as { tradeoffer_id?: unknown };
        if (t.proof_method === "trade_api") {
          if (asked.tradeoffer_id !== undefined) {
            if (typeof asked.tradeoffer_id !== "string" || !/^\d{1,20}$/.test(asked.tradeoffer_id)) throw invalidRequest("tradeoffer_id is digits");
            if (t.tradeoffer_id !== null && t.tradeoffer_id !== asked.tradeoffer_id) refuse(409, "transfer_bad_state", "the trade offer of this transfer is already set", {});
            if (t.tradeoffer_id === null) db.prepare("UPDATE transfers SET tradeoffer_id = ? WHERE id = ?").run(asked.tradeoffer_id, t.id);
          }
          t = findTransfer(db, circle.circle_id, params.id as string);
          if (t.tradeoffer_id === null) throw invalidRequest("tradeoffer_id is required for the first check of a game item");
        }
        const last = t.proof_json === null ? null : (JSON.parse(t.proof_json) as { checkedAtMs?: number });
        if (last?.checkedAtMs !== undefined && now() - last.checkedAtMs < minGap) {
          throw new ApiError(429, "rate_limited", `the proof of a transfer is checked once each ${options.proofMinSeconds ?? 30} seconds`, { retryAfterSeconds: Math.ceil((minGap - (now() - last.checkedAtMs)) / 1000) });
        }
        let verdict: ProofVerdict;
        if (t.proof_method === "dns_txt") verdict = await (options.dnsTxt as DnsTxtProof).buyerControls(t.transfer_ref, Number(t.id));
        else verdict = await (options.tradeApi as TradeApiProof).check({ tradeOfferId: t.tradeoffer_id as string, itemRef: t.transfer_ref, buyerAccount: t.buyer_ref as string, nowS });
        const record = { ...verdict.detail, verdict: verdict.status, checkedAtMs: now() };
        if (verdict.status === "unavailable") {
          db.prepare("UPDATE transfers SET proof_json = ? WHERE id = ?").run(JSON.stringify(record), t.id);
          return refuse(503, "transfer_platform_unavailable", "The platform did not answer; nothing was decided and the voucher is still held", verdict.detail);
        }
        if (verdict.status === "pending") {
          db.prepare("UPDATE transfers SET proof_json = ? WHERE id = ?").run(JSON.stringify(record), t.id);
          return refuse(409, "transfer_proof_pending", "The proof is not met yet; the voucher is still held", { retryAfterSeconds: Math.ceil(minGap / 1000), ...verdict.detail, windowUntil: Number(t.window_until) });
        }
        confirm(db, t, now(), record);
        return { status: 200, body: view(findTransfer(db, circle.circle_id, params.id as string)) };
      },
    },
    {
      // the signed notices: the buyer confirms a ticket (`buyer_confirm`), the seller or the buyer can cancel while the voucher is held
      method: "POST",
      pattern: "/x207/circles/{circle}/transfers/{id}",
      circleScoped: true,
      handler: ({ db, circle, params, body, now }) => {
        const nowS = nowSeconds(now());
        settle(db, circle.circle_id, nowS, now());
        const t = findTransfer(db, circle.circle_id, params.id as string);
        const { notice, signature } = (body ?? {}) as { notice?: Record<string, unknown>; signature?: unknown };
        if (notice === null || typeof notice !== "object" || typeof signature !== "string") throw invalidRequest("notice and signature are required");
        if (notice.circle !== circle.contract_id || notice.transfer_id !== Number(t.id)) throw invalidRequest("notice must be for this circle and this transfer", { transferId: Number(t.id) });
        const actor = notice.actor;
        if (actor !== t.buyer && actor !== t.seller) refuse(403, "transfer_not_party", "Only the buyer or the seller of this transfer may sign a notice", { actor: String(actor) });
        if (!Number.isSafeInteger(notice.at) || Math.abs((notice.at as number) - nowS) > NOTICE_SKEW_SECONDS) throw invalidRequest(`notice.at must be within ${NOTICE_SKEW_SECONDS} seconds of now`);
        if (!verifyNoticeJson(JSON.stringify(notice), circle.contract_id, signature, activeMemberKey(db, circle.circle_id, String(actor)))) throw new ApiError(401, "invalid_signature", "Notice signature does not match the voucher key of the actor", { account: String(actor) });
        if (t.status !== "paid_held") {
          return t.status === "cancelled" ? refuse(409, "transfer_window_passed", "This transfer is cancelled", { windowUntil: Number(t.window_until) }) : refuse(409, "transfer_bad_state", `the transfer is ${t.status}`, { status: t.status });
        }
        if (notice.action === "confirmed") {
          if (actor !== t.buyer) refuse(403, "transfer_not_party", "Only the buyer confirms", {});
          if (t.proof_method !== "buyer_confirm") refuse(400, "transfer_bad_method", `a ${t.platform} is proved by ${t.proof_method}, not by the buyer`, {});
          db.prepare("UPDATE transfers SET confirm_notice = ?, confirm_signature = ? WHERE id = ?").run(JSON.stringify(notice), signature, t.id);
          confirm(db, t, now(), { verdict: "met", by: "buyer_confirm", checkedAtMs: now() });
        } else if (notice.action === "cancelled") {
          db.prepare("UPDATE transfers SET status = 'cancelled', cancel_reason = ?, closed_at_ms = ? WHERE id = ?").run(`cancelled_by_${actor === t.buyer ? "buyer" : "seller"}`, now(), t.id);
        } else throw invalidRequest("notice.action is confirmed or cancelled", { allowed: ["confirmed", "cancelled"] });
        return { status: 201, body: view(findTransfer(db, circle.circle_id, params.id as string)) };
      },
    },
  ];
}
