// Acceptance of offers and bundle proposals (BE-041, F9): accept -> `terms_hash` is recomputed from listing + offer (SDK `planOffer`),
// signed by each participant with the voucher key (NEP-413, nonce = terms_hash). The bundle is `ready` once all participants have signed;
// the `commit_bundle` submission is done by the solver/keeper, not the backend. Separate from `GET …/bundles` (BE-036), which reads on-chain bundles.
import type Database from "better-sqlite3";
import {
  BarterFormatError, bundleFullySigned, bundleParticipants, planOffer, termsHash, validateBundleTerms, quickBarter, quickPay, serializeBundleTerms, verifyBundleSignature, type BundleSignature, type BundleTerms, type Listing,
} from "@x207/core";
import { ApiError, invalidRequest } from "../api/errors.js";
import { row, rows } from "../api/format.js";
import type { Route } from "../api/router.js";
import { activeMemberKey, memberKeys } from "./auth.js";
import { isoSeconds, nowSeconds } from "./common.js";
import { effectiveStatus, findListing, type ListingRow } from "./listings.js";
import { openEpochResolver, type OpenEpochResolver } from "./epoch.js";
import { findOffer, offerView, type OfferRow } from "./offers.js";
import { threadReferral } from "./referrals.js";
import { DEFAULT_BOND_THRESHOLD } from "./invoices.js";
import { autoConfirmDue, DEFAULT_CONFIRM_CLASSES, findDeliveries, paymentReleased, startDeliveriesIfNeeded } from "./delivery-core.js";

const HASH = /^[0-9a-f]{64}$/;
const PROPOSAL_STATUSES = ["proposed", "ready", "all"] as const;

interface ProposalRow {
  id: bigint;
  terms_hash: string;
  match_id: bigint;
  epoch: bigint;
  terms_json: string;
  status: string;
  created_at_ms: bigint;
}

interface MatchRow {
  id: bigint;
  listing_hash: string;
  offer_hash: string;
  seller: string;
  counterparty: string;
  mode: string;
  kind: string;
  epoch: bigint;
  terms_hash: string | null;
  listing_value: string;
  discount_value: string;
  searcher_account: string | null;
  searcher_value: string;
  matched_at_ms: bigint;
}

/** Listing in SDK shape from the D12 row, used to recompute the terms. */
export function listingFromRow(contractId: string, r: ListingRow): Listing {
  return {
    circle: contractId,
    account: r.account_id,
    offer: { asset_type: r.offer_asset_type, asset_class: r.offer_class as "A", quantity: Number(r.offer_quantity), value: r.offer_value },
    want: { asset_type: r.want_asset_type, asset_class: r.want_class as "A", quantity: Number(r.want_quantity), value: r.want_value },
    terms: r.terms,
    detail: r.detail,
    expires_at: Number(r.expires_at),
    discount_bps: Number(r.discount_bps),
    accept_payment: r.accept_payment === 1n,
    discoverable: r.discoverable === 1n,
    nonce: r.nonce,
  };
}

function signaturesOf(db: Database.Database, circleId: string, termsHash: string): BundleSignature[] {
  return rows<{ account_id: string; signature: string }>(
    db, "SELECT account_id, signature FROM bundle_signatures WHERE circle_id = ? AND terms_hash = ? ORDER BY signed_at_ms, account_id", circleId, termsHash,
  ).map((s) => ({ account: s.account_id, signature: s.signature as BundleSignature["signature"] }));
}

function proposalView(db: Database.Database, circleId: string, p: ProposalRow) {
  const terms = JSON.parse(p.terms_json) as BundleTerms;
  const signatures = signaturesOf(db, circleId, p.terms_hash);
  const signed = new Set(signatures.map((s) => s.account));
  const participants = bundleParticipants(terms);
  const match = row<MatchRow>(db, "SELECT * FROM matches WHERE id = ?", p.match_id);
  return {
    termsHash: p.terms_hash,
    status: p.status,
    epoch: Number(p.epoch),
    terms,
    participants,
    signatures,
    missing: participants.filter((a) => !signed.has(a)),
    listingHash: match?.listing_hash ?? null,
    offerHash: match?.offer_hash ?? null,
    searcher: match?.searcher_account ?? null,
    createdAt: isoSeconds(Math.floor(Number(p.created_at_ms) / 1000)),
  };
}

function findProposal(db: Database.Database, circleId: string, hash: string): ProposalRow {
  if (!HASH.test(hash)) throw invalidRequest("terms_hash must be 64 lowercase hex characters", { termsHash: hash });
  const found = row<ProposalRow>(db, "SELECT * FROM bundle_proposals WHERE circle_id = ? AND terms_hash = ?", circleId, hash);
  if (!found) throw new ApiError(404, "proposal_not_found", `Bundle proposal ${hash} not found`, { termsHash: hash });
  return found;
}

function matchView(m: MatchRow) {
  return {
    listingHash: m.listing_hash,
    offerHash: m.offer_hash,
    seller: m.seller,
    counterparty: m.counterparty,
    mode: m.mode,
    kind: m.kind,
    epoch: Number(m.epoch),
    termsHash: m.terms_hash,
    listingValue: m.listing_value,
    discountValue: m.discount_value,
    searcher: m.searcher_account,
    searcherValue: m.searcher_value,
  };
}

function refreshStatus(db: Database.Database, circleId: string, p: ProposalRow): void {
  const terms = JSON.parse(p.terms_json) as BundleTerms;
  const sigs = signaturesOf(db, circleId, p.terms_hash);
  const keys = memberKeys(db, circleId, bundleParticipants(terms));
  // BE-047: a bundle on an off-chain asset is not ready to commit until the receiver confirmed the delivery
  const matchRow = p.match_id === null ? undefined : row<{ listing_hash: string }>(db, "SELECT listing_hash FROM matches WHERE id = ?", p.match_id);
  // a deal with a bond (CT-094) is committed BEFORE the handover: the bond locked at the commit is what protects the receiver, and the payment (the voucher in the bundle) waits for `confirm_deal` instead
  const released = matchRow === undefined || terms.arbiter != null || paymentReleased(db, circleId, matchRow.listing_hash);
  const ready = released && bundleFullySigned(terms, sigs, keys);
  db.prepare("UPDATE bundle_proposals SET status = ? WHERE id = ?").run(ready ? "ready" : "proposed", p.id);
}

/** Deliveries that the receiver left alone past the window are confirmed now; their bundles are looked at again. */
export function settleDeliveries(db: Database.Database, circleId: string, nowMs: number): void {
  for (const matchId of autoConfirmDue(db, circleId, Math.floor(nowMs / 1000))) refreshProposalOfMatch(db, circleId, matchId);
}

/** After the receiver confirmed a delivery: the bundle of that match may become `ready` now. */
export function refreshProposalOfMatch(db: Database.Database, circleId: string, matchId: bigint | number): void {
  const p = row<ProposalRow>(db, "SELECT * FROM bundle_proposals WHERE circle_id = ? AND match_id = ?", circleId, matchId);
  if (p) refreshStatus(db, circleId, p);
}

interface AcceptInput {
  epoch?: unknown;
  searcher?: unknown;
  searcherShareBps?: unknown;
  /** CT-094 (UM-097): the arbiter, the end of the window to confirm or dispute (ns, decimal string) and the optional hash of the agreement of a deal with a bond. */
  arbiter?: unknown;
  confirmBy?: unknown;
  agreementHash?: unknown;
}

/**
 * CT-094 is a swap of two: the contract takes a bundle of at least two legs, one in each direction. A sale (one payment) becomes a deal with a bond by adding the smallest return leg from the seller
 * to the buyer (one unit, 0.000001 credit); the bond is worked out from the largest amount owed, so it follows the price.
 */
const NOMINAL_RETURN_LEG = "1";

/** The deal with a bond (CT-094) that a handover of this value needs. */
interface BondGate {
  /** The match starts a handover that waits for the receiver (BE-047). */
  handover: boolean;
  threshold: bigint;
  /** `accept` refuses a deal at or above the threshold that carries no arbiter; the preview only reports. */
  enforce: boolean;
}

/** Acceptance plan: current `open` epoch, validated searcher, and the `planOffer` result (legs, `terms_hash`, discount, searcher share). */
async function planAccept(
  db: Database.Database, circle: { circle_id: string; contract_id: string }, listingRow: ListingRow, offerRow: OfferRow, input: AcceptInput,
  openEpoch: OpenEpochResolver, gate: BondGate,
) {
  const open = await openEpoch(db, circle);
  if (open === null) throw new ApiError(409, "epoch_not_open", "No epoch is open");
  if (input.epoch !== undefined && input.epoch !== open) throw new ApiError(409, "epoch_not_open", "Bundle must be for the current open epoch", { expected: open, got: input.epoch as number });
  if (input.searcher !== undefined && typeof input.searcher !== "string") throw invalidRequest("searcher must be a string");
  if (input.searcherShareBps !== undefined && !Number.isSafeInteger(input.searcherShareBps)) throw invalidRequest("searcherShareBps must be an integer");
  // Without a searcher in the body, the referral attached to the thread (BE-044) determines the searcher and its share
  const referral = input.searcher === undefined ? threadReferral(db, circle.circle_id, offerRow) : undefined;
  const searcher = (input.searcher as string | undefined) ?? referral?.seeker;
  const shareBps = referral ? (input.searcherShareBps as number | undefined) ?? Number(referral.searcher_share_bps) : (input.searcherShareBps as number | undefined);
  if (searcher !== undefined) {
    activeMemberKey(db, circle.circle_id, searcher);
    if (searcher === listingRow.account_id || searcher === offerRow.counterparty) throw invalidRequest("the searcher must be an account outside the two parties");
  }

  const listing = listingFromRow(circle.contract_id, listingRow);
  const offer = {
    circle: circle.contract_id, listing_hash: listingRow.listing_hash, proposer: offerRow.proposer, round: Number(offerRow.round),
    mode: offerRow.mode as "pay" | "barter", value: offerRow.value, quantity: Number(offerRow.quantity), deliver_by: Number(offerRow.deliver_by),
  };
  let plan;
  try {
    plan = planOffer({ listing, offer, epoch: open, counterparty: offerRow.counterparty, ...(searcher === undefined ? {} : { searcher }), ...(shareBps === undefined ? {} : { searcherShareBps: shareBps }) });
  } catch (error) {
    if (error instanceof BarterFormatError) throw invalidRequest(error.message);
    throw error;
  }
  const needsBond = gate.handover && BigInt(offerRow.value) >= gate.threshold;
  if (needsBond && input.arbiter === undefined) {
    if (gate.enforce) {
      throw new ApiError(409, "bond_required", "A handover worth this much needs a deal with a bond (CT-094): accept with arbiter, confirmBy (ns, decimal string) and optionally agreementHash, and sign the terms that carry them", {
        value: offerRow.value, threshold: gate.threshold.toString(),
      });
    }
    return { open, searcher, shareBps, plan, needsBond };
  }
  if (!needsBond && input.arbiter !== undefined) throw invalidRequest("arbiter is only for a handover at or above the bond threshold", { threshold: gate.threshold.toString() });
  if (needsBond) {
    if (typeof input.arbiter !== "string" || typeof input.confirmBy !== "string") throw invalidRequest("arbiter and confirmBy (a decimal string of nanoseconds) come together");
    if (input.agreementHash !== undefined && typeof input.agreementHash !== "string") throw invalidRequest("agreementHash must be 64 lowercase hex characters");
    const base: BundleTerms = plan.kind === "bundle" ? plan.terms : { circle: circle.contract_id, epoch: open, legs: [{ payer: plan.payer, payee: plan.payee, max_amount: plan.amount }, { payer: plan.payee, payee: plan.payer, max_amount: NOMINAL_RETURN_LEG }] };
    const terms: BundleTerms = { ...base, arbiter: input.arbiter, ...(input.agreementHash === undefined ? {} : { agreement_hash: input.agreementHash }), confirm_by: input.confirmBy };
    try {
      validateBundleTerms(terms);
    } catch (error) {
      if (error instanceof BarterFormatError) throw invalidRequest(error.message);
      throw error;
    }
    return { open, searcher, shareBps, plan: { kind: "bundle" as const, terms, terms_hash: termsHash(terms), discount: plan.discount, searcher: plan.searcher }, needsBond };
  }
  return { open, searcher, shareBps, plan, needsBond };
}

export function bundleRoutes(openEpoch: OpenEpochResolver = openEpochResolver(), options: { confirmClasses?: readonly string[]; bondThreshold?: bigint } = {}): Route[] {
  const confirmClasses = options.confirmClasses ?? DEFAULT_CONFIRM_CLASSES;
  const bondThreshold = options.bondThreshold ?? DEFAULT_BOND_THRESHOLD;
  const bondGate = (l: ListingRow, o: OfferRow, enforce: boolean): BondGate => ({
    handover: confirmClasses.includes(l.offer_class) || (o.mode === "barter" && confirmClasses.includes(l.want_class)), threshold: bondThreshold, enforce,
  });
  return [
  {
    method: "POST",
    pattern: "/x207/circles/{circle}/listings/{hash}/offers/{offerHash}/accept",
    circleScoped: true,
    handler: async ({ db, circle, params, body, now }) => {
      const listingRow = findListing(db, circle.circle_id, params.hash as string);
      const offerRow = findOffer(db, circle.circle_id, listingRow.listing_hash, params.offerHash as string);
      if (body === null || typeof body !== "object") throw invalidRequest("body must be an object");
      const input = body as { account?: unknown; signature?: unknown; epoch?: unknown; searcher?: unknown; searcherShareBps?: unknown };
      if (typeof input.account !== "string") throw invalidRequest("account must be a string");
      if (input.account !== offerRow.awaiting) throw invalidRequest("only the party whose answer is awaited may accept", { expected: offerRow.awaiting });
      const nowS = nowSeconds(now());
      const listingStatus = effectiveStatus(listingRow, nowS);
      if (listingStatus !== "open") throw new ApiError(409, "listing_not_open", `Listing is ${listingStatus}`, { listingHash: listingRow.listing_hash, status: listingStatus });
      if (offerRow.status !== "pending") throw new ApiError(409, "offer_not_open", `Offer is ${offerRow.status}`, { offerHash: offerRow.offer_hash, status: offerRow.status });

      const { open, searcher, plan } = await planAccept(db, circle, listingRow, offerRow, input, openEpoch, bondGate(listingRow, offerRow, true));

      let signature: string | null = null;
      if (plan.kind === "bundle") {
        if (typeof input.signature !== "string") throw invalidRequest("signature (signature over terms_hash) is required for a bundle");
        const pubkey = activeMemberKey(db, circle.circle_id, input.account);
        if (!verifyBundleSignature(plan.terms, input.signature, pubkey)) {
          throw new ApiError(401, "invalid_signature", "Bundle signature does not match the computed terms_hash", { account: input.account, termsHash: plan.terms_hash });
        }
        if (!bundleParticipants(plan.terms).includes(input.account)) throw invalidRequest("the accepting account is not a bundle participant");
        signature = input.signature;
      } else {
        activeMemberKey(db, circle.circle_id, input.account);
      }

      const commit = db.transaction(() => {
        const match = db
          .prepare(
            `INSERT INTO matches (circle_id, listing_hash, offer_hash, seller, counterparty, mode, kind, epoch, terms_hash, listing_value,
               discount_value, searcher_account, searcher_value, matched_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(circle.circle_id, listingRow.listing_hash, offerRow.offer_hash, listingRow.account_id, offerRow.counterparty, offerRow.mode, plan.kind, open,
            plan.kind === "bundle" ? plan.terms_hash : null, offerRow.value, plan.discount, searcher ?? null, plan.searcher, now());
        const matchId = match.lastInsertRowid;
        startDeliveriesIfNeeded(
          db, circle.circle_id,
          {
            id: matchId, listing_hash: listingRow.listing_hash, offer_hash: offerRow.offer_hash, seller: listingRow.account_id, counterparty: offerRow.counterparty,
            mode: offerRow.mode, offerClass: listingRow.offer_class, wantClass: listingRow.want_class, deliverBy: Number(offerRow.deliver_by),
          },
          confirmClasses, now(),
        );
        db.prepare("UPDATE offers SET status = 'accepted' WHERE id = ?").run(offerRow.id);
        db.prepare("UPDATE offers SET status = 'closed' WHERE circle_id = ? AND listing_hash = ? AND id <> ? AND status IN ('pending')").run(circle.circle_id, listingRow.listing_hash, offerRow.id);
        db.prepare("UPDATE listings SET status = 'matched', closed_at_ms = ? WHERE id = ?").run(now(), listingRow.id);
        if (plan.kind === "bundle" && signature !== null) {
          const inserted = db
            .prepare("INSERT OR IGNORE INTO bundle_proposals (circle_id, terms_hash, match_id, epoch, terms_json, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)")
            .run(circle.circle_id, plan.terms_hash, matchId, open, JSON.stringify(plan.terms), now());
          if (inserted.changes === 0) throw new ApiError(409, "already_exists", "A bundle with this terms_hash is already proposed", { termsHash: plan.terms_hash });
          db.prepare("INSERT INTO bundle_signatures (circle_id, terms_hash, account_id, signature, signed_at_ms) VALUES (?, ?, ?, ?, ?)")
            .run(circle.circle_id, plan.terms_hash, input.account as string, signature, now());
          refreshStatus(db, circle.circle_id, findProposal(db, circle.circle_id, plan.terms_hash));
        }
        return Number(matchId);
      });
      const matchId = commit();
      const match = row<MatchRow>(db, "SELECT * FROM matches WHERE id = ?", matchId) as MatchRow;
      const handovers = findDeliveries(db, circle.circle_id, listingRow.listing_hash);
      // only a match that needs a confirmation carries `delivery`; the others keep the shape they always had
      const gate = handovers.length === 0 ? {} : { delivery: { required: true, payable: handovers.every((d) => d.state === "confirmed"), needsBond: BigInt(offerRow.value) >= bondThreshold, sides: Object.fromEntries(handovers.map((d) => [d.side, d.state])) } };
      const result =
        plan.kind === "payment"
          ? { kind: "payment", payer: plan.payer, payee: plan.payee, amount: plan.amount, ...gate }
          : { kind: "bundle", proposal: proposalView(db, circle.circle_id, findProposal(db, circle.circle_id, plan.terms_hash)), ...gate };
      return { status: 201, body: { match: matchView(match), offer: offerView(findOffer(db, circle.circle_id, listingRow.listing_hash, offerRow.offer_hash)), result } };
    },
  },
  {
    // Acceptance preview without storing anything: the final numbers and the message to be signed (FE-020).
    method: "POST",
    pattern: "/x207/circles/{circle}/listings/{hash}/offers/{offerHash}/preview",
    circleScoped: true,
    handler: async ({ db, circle, params, body, now }) => {
      const listingRow = findListing(db, circle.circle_id, params.hash as string);
      const offerRow = findOffer(db, circle.circle_id, listingRow.listing_hash, params.offerHash as string);
      if (body === null || typeof body !== "object") throw invalidRequest("body must be an object");
      const input = body as AcceptInput & { account?: unknown };
      if (typeof input.account !== "string") throw invalidRequest("account must be a string");
      if (input.account !== offerRow.awaiting) throw invalidRequest("only the party whose answer is awaited may accept", { expected: offerRow.awaiting });
      const listingStatus = effectiveStatus(listingRow, nowSeconds(now()));
      if (listingStatus !== "open") throw new ApiError(409, "listing_not_open", `Listing is ${listingStatus}`, { listingHash: listingRow.listing_hash, status: listingStatus });
      if (offerRow.status !== "pending") throw new ApiError(409, "offer_not_open", `Offer is ${offerRow.status}`, { offerHash: offerRow.offer_hash, status: offerRow.status });
      const { open, searcher, shareBps: effectiveShare, plan, needsBond } = await planAccept(db, circle, listingRow, offerRow, input, openEpoch, bondGate(listingRow, offerRow, false));
      const shareBps = searcher === undefined ? 0 : (effectiveShare ?? 0);
      const quick = { value: offerRow.value, discountBps: Number(listingRow.discount_bps), searcherShareBps: shareBps };
      const breakdown = offerRow.mode === "pay" ? { mode: "pay", ...quickPay(quick) } : { mode: "barter", ...quickBarter(quick) };
      const bundle =
        plan.kind === "bundle"
          ? {
              termsHash: plan.terms_hash,
              message: serializeBundleTerms(plan.terms),
              nonce: Buffer.from(plan.terms_hash, "hex").toString("base64"),
              recipient: circle.contract_id,
              terms: plan.terms,
              participants: bundleParticipants(plan.terms),
            }
          : null;
      const payment = plan.kind === "payment" ? { payer: plan.payer, payee: plan.payee, amount: plan.amount } : null;
      return {
        status: 200,
        body: { kind: plan.kind, epoch: open, mode: offerRow.mode, needsBond, discountValue: plan.discount, searcherValue: plan.searcher, searcher: searcher ?? null, breakdown, bundle, payment },
      };
    },
  },
  {
    // Proposal from a solver (SV-011): ring terms or a listing pair with no match in the book. The server recomputes `terms_hash`,
    // checks the epoch is open and that all participants are active members; participants then sign through `…/signatures` as usual.
    method: "POST",
    pattern: "/x207/circles/{circle}/bundle-proposals",
    circleScoped: true,
    handler: async ({ db, circle, body, now }) => {
      if (body === null || typeof body !== "object") throw invalidRequest("body must be an object");
      const { terms, termsHash: claimed, searcher } = body as { terms?: unknown; termsHash?: unknown; searcher?: unknown };
      if (terms === null || typeof terms !== "object") throw invalidRequest("terms must be an object");
      const candidate = terms as BundleTerms;
      try {
        validateBundleTerms(candidate);
      } catch (error) {
        if (error instanceof BarterFormatError) throw invalidRequest(error.message);
        throw error;
      }
      // A bundle that pays a seeker must name that leg, or max_search_share_bps would not apply to it (CT-082)
      if (searcher !== undefined) {
        if (typeof searcher !== "string") throw invalidRequest("searcher must be a string");
        if (!candidate.legs.some((l) => l.payee === searcher)) throw invalidRequest("searcher is not the payee of any leg in terms", { searcher });
        if (candidate.search_leg?.payee !== searcher) throw invalidRequest("search_leg is required and must point to the searcher's leg", { searcher });
      }
      if (candidate.circle !== circle.contract_id) throw invalidRequest("terms.circle must be the circle contract account", { expected: circle.contract_id, got: candidate.circle });
      const hash = termsHash(candidate);
      if (claimed !== undefined && claimed !== hash) throw invalidRequest("termsHash does not match the computed hash of the terms", { computed: hash });
      const open = await openEpoch(db, circle);
      if (open === null || candidate.epoch !== open) throw new ApiError(409, "epoch_not_open", "Bundle must be for the current open epoch", { expected: open, got: candidate.epoch });
      for (const account of bundleParticipants(candidate)) activeMemberKey(db, circle.circle_id, account);

      const existing = row<ProposalRow>(db, "SELECT * FROM bundle_proposals WHERE circle_id = ? AND terms_hash = ?", circle.circle_id, hash);
      if (existing) return { status: 200, body: proposalView(db, circle.circle_id, existing) };
      db.prepare("INSERT INTO bundle_proposals (circle_id, terms_hash, match_id, epoch, terms_json, source, created_at_ms) VALUES (?, ?, NULL, ?, ?, 'solver', ?)")
        .run(circle.circle_id, hash, candidate.epoch, JSON.stringify(candidate), now());
      return { status: 201, body: proposalView(db, circle.circle_id, findProposal(db, circle.circle_id, hash)) };
    },
  },
  {
    method: "GET",
    pattern: "/x207/circles/{circle}/bundle-proposals",
    circleScoped: true,
    handler: ({ db, circle, query, now }) => {
      settleDeliveries(db, circle.circle_id, now());
      const status = query.get("status") ?? "all";
      if (!(PROPOSAL_STATUSES as readonly string[]).includes(status)) throw invalidRequest("status is not recognized", { status, allowed: PROPOSAL_STATUSES });
      const found = rows<ProposalRow>(
        db,
        `SELECT * FROM bundle_proposals WHERE circle_id = ? ${status === "all" ? "" : "AND status = ?"} ORDER BY id`,
        circle.circle_id,
        ...(status === "all" ? [] : [status]),
      );
      const account = query.get("account");
      const items = found.map((p) => proposalView(db, circle.circle_id, p)).filter((p) => account === null || p.participants.includes(account));
      return { status: 200, body: { items } };
    },
  },
  {
    method: "GET",
    pattern: "/x207/circles/{circle}/bundle-proposals/{termsHash}",
    circleScoped: true,
    handler: ({ db, circle, params, now }) => {
      settleDeliveries(db, circle.circle_id, now());
      return {
      status: 200,
      body: proposalView(db, circle.circle_id, findProposal(db, circle.circle_id, params.termsHash as string)),
      };
    },
  },
  {
    method: "POST",
    pattern: "/x207/circles/{circle}/bundle-proposals/{termsHash}/signatures",
    circleScoped: true,
    handler: async ({ db, circle, params, body, now }) => {
      settleDeliveries(db, circle.circle_id, now());
      const proposal = findProposal(db, circle.circle_id, params.termsHash as string);
      if (body === null || typeof body !== "object") throw invalidRequest("body must be an object");
      const { account, signature } = body as { account?: unknown; signature?: unknown };
      if (typeof account !== "string") throw invalidRequest("account must be a string");
      if (typeof signature !== "string") throw invalidRequest("signature must be a string");
      const terms = JSON.parse(proposal.terms_json) as BundleTerms;
      if (!bundleParticipants(terms).includes(account)) throw invalidRequest("account is not a bundle participant", { account });
      const open = await openEpoch(db, circle);
      if (open !== Number(proposal.epoch)) throw new ApiError(409, "epoch_not_open", "This bundle's epoch is no longer the open epoch", { bundleEpoch: Number(proposal.epoch), open });
      const pubkey = activeMemberKey(db, circle.circle_id, account);
      if (!verifyBundleSignature(terms, signature, pubkey)) {
        throw new ApiError(401, "invalid_signature", "Signature does not match terms_hash", { account, termsHash: proposal.terms_hash });
      }
      const inserted = db
        .prepare("INSERT OR IGNORE INTO bundle_signatures (circle_id, terms_hash, account_id, signature, signed_at_ms) VALUES (?, ?, ?, ?, ?)")
        .run(circle.circle_id, proposal.terms_hash, account, signature, now());
      if (inserted.changes === 0) throw new ApiError(409, "already_exists", "This account has already signed the bundle", { account });
      refreshStatus(db, circle.circle_id, proposal);
      return { status: 201, body: proposalView(db, circle.circle_id, findProposal(db, circle.circle_id, proposal.terms_hash)) };
    },
  },
];
}
