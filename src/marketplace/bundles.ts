// Penerimaan penawaran dan usulan bundle (BE-041, F9): terima -> `terms_hash` dihitung ulang dari listing + penawaran (SDK `planOffer`),
// ditandatangani tiap peserta dengan kunci voucher (NEP-413, nonce = terms_hash). Bundle `ready` bila semua peserta sudah menandatangani;
// pengiriman `commit_bundle` dilakukan solver/keeper, bukan backend. Dipisah dari `GET …/bundles` (BE-036) yang membaca bundle on-chain.
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

/** Listing dalam bentuk SDK dari baris D12, dipakai untuk menghitung ulang syarat. */
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
  if (!HASH.test(hash)) throw invalidRequest("terms_hash harus 64 karakter heksadesimal huruf kecil", { termsHash: hash });
  const found = row<ProposalRow>(db, "SELECT * FROM bundle_proposals WHERE circle_id = ? AND terms_hash = ?", circleId, hash);
  if (!found) throw new ApiError(404, "proposal_not_found", `Usulan bundle ${hash} tidak ada`, { termsHash: hash });
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
  const ready = bundleFullySigned(terms, sigs, keys);
  db.prepare("UPDATE bundle_proposals SET status = ? WHERE id = ?").run(ready ? "ready" : "proposed", p.id);
}

interface AcceptInput {
  epoch?: unknown;
  searcher?: unknown;
  searcherShareBps?: unknown;
}

/** Rencana penerimaan: epoch `open` saat ini, pencari tervalidasi, dan hasil `planOffer` (leg, `terms_hash`, diskon, jatah pencari). */
async function planAccept(
  db: Database.Database, circle: { circle_id: string; contract_id: string }, listingRow: ListingRow, offerRow: OfferRow, input: AcceptInput,
  openEpoch: OpenEpochResolver,
) {
  const open = await openEpoch(db, circle);
  if (open === null) throw new ApiError(409, "epoch_not_open", "Tidak ada epoch open");
  if (input.epoch !== undefined && input.epoch !== open) throw new ApiError(409, "epoch_not_open", "Bundle harus untuk epoch open saat ini", { expected: open, got: input.epoch as number });
  if (input.searcher !== undefined && typeof input.searcher !== "string") throw invalidRequest("searcher harus string");
  if (input.searcherShareBps !== undefined && !Number.isSafeInteger(input.searcherShareBps)) throw invalidRequest("searcherShareBps harus integer");
  // Tanpa pencari di body, ajakan yang melekat pada utas (BE-044) menentukan pencari dan jatahnya
  const referral = input.searcher === undefined ? threadReferral(db, circle.circle_id, offerRow) : undefined;
  const searcher = (input.searcher as string | undefined) ?? referral?.seeker;
  const shareBps = referral ? (input.searcherShareBps as number | undefined) ?? Number(referral.searcher_share_bps) : (input.searcherShareBps as number | undefined);
  if (searcher !== undefined) {
    activeMemberKey(db, circle.circle_id, searcher);
    if (searcher === listingRow.account_id || searcher === offerRow.counterparty) throw invalidRequest("pencari harus akun di luar kedua pihak");
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
  return { open, searcher, shareBps, plan };
}

export function bundleRoutes(openEpoch: OpenEpochResolver = openEpochResolver()): Route[] {
  return [
  {
    method: "POST",
    pattern: "/x207/circles/{circle}/listings/{hash}/offers/{offerHash}/accept",
    circleScoped: true,
    handler: async ({ db, circle, params, body, now }) => {
      const listingRow = findListing(db, circle.circle_id, params.hash as string);
      const offerRow = findOffer(db, circle.circle_id, listingRow.listing_hash, params.offerHash as string);
      if (body === null || typeof body !== "object") throw invalidRequest("body harus objek");
      const input = body as { account?: unknown; signature?: unknown; epoch?: unknown; searcher?: unknown; searcherShareBps?: unknown };
      if (typeof input.account !== "string") throw invalidRequest("account wajib string");
      if (input.account !== offerRow.awaiting) throw invalidRequest("hanya pihak yang ditunggu jawabannya boleh menerima", { expected: offerRow.awaiting });
      const nowS = nowSeconds(now());
      const listingStatus = effectiveStatus(listingRow, nowS);
      if (listingStatus !== "open") throw new ApiError(409, "listing_not_open", `Listing berstatus ${listingStatus}`, { listingHash: listingRow.listing_hash, status: listingStatus });
      if (offerRow.status !== "pending") throw new ApiError(409, "offer_not_open", `Penawaran berstatus ${offerRow.status}`, { offerHash: offerRow.offer_hash, status: offerRow.status });

      const { open, searcher, plan } = await planAccept(db, circle, listingRow, offerRow, input, openEpoch);

      let signature: string | null = null;
      if (plan.kind === "bundle") {
        if (typeof input.signature !== "string") throw invalidRequest("signature (tanda tangan terms_hash) wajib untuk bundle");
        const pubkey = activeMemberKey(db, circle.circle_id, input.account);
        if (!verifyBundleSignature(plan.terms, input.signature, pubkey)) {
          throw new ApiError(401, "invalid_signature", "Tanda tangan bundle tidak cocok dengan terms_hash hasil hitung", { account: input.account, termsHash: plan.terms_hash });
        }
        if (!bundleParticipants(plan.terms).includes(input.account)) throw invalidRequest("akun penerima bukan peserta bundle");
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
        db.prepare("UPDATE offers SET status = 'accepted' WHERE id = ?").run(offerRow.id);
        db.prepare("UPDATE offers SET status = 'closed' WHERE circle_id = ? AND listing_hash = ? AND id <> ? AND status IN ('pending')").run(circle.circle_id, listingRow.listing_hash, offerRow.id);
        db.prepare("UPDATE listings SET status = 'matched', closed_at_ms = ? WHERE id = ?").run(now(), listingRow.id);
        if (plan.kind === "bundle" && signature !== null) {
          const inserted = db
            .prepare("INSERT OR IGNORE INTO bundle_proposals (circle_id, terms_hash, match_id, epoch, terms_json, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)")
            .run(circle.circle_id, plan.terms_hash, matchId, open, JSON.stringify(plan.terms), now());
          if (inserted.changes === 0) throw new ApiError(409, "already_exists", "Bundle dengan terms_hash ini sudah diusulkan", { termsHash: plan.terms_hash });
          db.prepare("INSERT INTO bundle_signatures (circle_id, terms_hash, account_id, signature, signed_at_ms) VALUES (?, ?, ?, ?, ?)")
            .run(circle.circle_id, plan.terms_hash, input.account as string, signature, now());
          refreshStatus(db, circle.circle_id, findProposal(db, circle.circle_id, plan.terms_hash));
        }
        return Number(matchId);
      });
      const matchId = commit();
      const match = row<MatchRow>(db, "SELECT * FROM matches WHERE id = ?", matchId) as MatchRow;
      const result =
        plan.kind === "payment"
          ? { kind: "payment", payer: plan.payer, payee: plan.payee, amount: plan.amount }
          : { kind: "bundle", proposal: proposalView(db, circle.circle_id, findProposal(db, circle.circle_id, plan.terms_hash)) };
      return { status: 201, body: { match: matchView(match), offer: offerView(findOffer(db, circle.circle_id, listingRow.listing_hash, offerRow.offer_hash)), result } };
    },
  },
  {
    // Pratinjau penerimaan tanpa menyimpan apa pun: angka akhir dan pesan yang akan ditandatangani (FE-020).
    method: "POST",
    pattern: "/x207/circles/{circle}/listings/{hash}/offers/{offerHash}/preview",
    circleScoped: true,
    handler: async ({ db, circle, params, body, now }) => {
      const listingRow = findListing(db, circle.circle_id, params.hash as string);
      const offerRow = findOffer(db, circle.circle_id, listingRow.listing_hash, params.offerHash as string);
      if (body === null || typeof body !== "object") throw invalidRequest("body harus objek");
      const input = body as AcceptInput & { account?: unknown };
      if (typeof input.account !== "string") throw invalidRequest("account wajib string");
      if (input.account !== offerRow.awaiting) throw invalidRequest("hanya pihak yang ditunggu jawabannya boleh menerima", { expected: offerRow.awaiting });
      const listingStatus = effectiveStatus(listingRow, nowSeconds(now()));
      if (listingStatus !== "open") throw new ApiError(409, "listing_not_open", `Listing berstatus ${listingStatus}`, { listingHash: listingRow.listing_hash, status: listingStatus });
      if (offerRow.status !== "pending") throw new ApiError(409, "offer_not_open", `Penawaran berstatus ${offerRow.status}`, { offerHash: offerRow.offer_hash, status: offerRow.status });
      const { open, searcher, shareBps: effectiveShare, plan } = await planAccept(db, circle, listingRow, offerRow, input, openEpoch);
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
        body: { kind: plan.kind, epoch: open, mode: offerRow.mode, discountValue: plan.discount, searcherValue: plan.searcher, searcher: searcher ?? null, breakdown, bundle, payment },
      };
    },
  },
  {
    // Usulan dari solver (SV-011): syarat cincin atau pasangan listing tanpa kecocokan di buku. Server menghitung ulang `terms_hash`,
    // memeriksa epoch open dan bahwa semua peserta anggota aktif; peserta lalu menandatangani lewat `…/signatures` seperti biasa.
    method: "POST",
    pattern: "/x207/circles/{circle}/bundle-proposals",
    circleScoped: true,
    handler: async ({ db, circle, body, now }) => {
      if (body === null || typeof body !== "object") throw invalidRequest("body harus objek");
      const { terms, termsHash: claimed, searcher } = body as { terms?: unknown; termsHash?: unknown; searcher?: unknown };
      if (terms === null || typeof terms !== "object") throw invalidRequest("terms wajib objek");
      const candidate = terms as BundleTerms;
      try {
        validateBundleTerms(candidate);
      } catch (error) {
        if (error instanceof BarterFormatError) throw invalidRequest(error.message);
        throw error;
      }
      // A bundle that pays a seeker must name that leg, or max_search_share_bps would not apply to it (CT-082)
      if (searcher !== undefined) {
        if (typeof searcher !== "string") throw invalidRequest("searcher harus string");
        if (!candidate.legs.some((l) => l.payee === searcher)) throw invalidRequest("searcher bukan penerima leg mana pun di terms", { searcher });
        if (candidate.search_leg?.payee !== searcher) throw invalidRequest("search_leg wajib ada dan menunjuk leg pencari", { searcher });
      }
      if (candidate.circle !== circle.contract_id) throw invalidRequest("terms.circle harus akun kontrak lingkaran", { expected: circle.contract_id, got: candidate.circle });
      const hash = termsHash(candidate);
      if (claimed !== undefined && claimed !== hash) throw invalidRequest("termsHash tidak sama dengan hasil hitung syarat", { computed: hash });
      const open = await openEpoch(db, circle);
      if (open === null || candidate.epoch !== open) throw new ApiError(409, "epoch_not_open", "Bundle harus untuk epoch open saat ini", { expected: open, got: candidate.epoch });
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
    handler: ({ db, circle, query }) => {
      const status = query.get("status") ?? "all";
      if (!(PROPOSAL_STATUSES as readonly string[]).includes(status)) throw invalidRequest("status tidak dikenal", { status, allowed: PROPOSAL_STATUSES });
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
    handler: ({ db, circle, params }) => ({
      status: 200,
      body: proposalView(db, circle.circle_id, findProposal(db, circle.circle_id, params.termsHash as string)),
    }),
  },
  {
    method: "POST",
    pattern: "/x207/circles/{circle}/bundle-proposals/{termsHash}/signatures",
    circleScoped: true,
    handler: async ({ db, circle, params, body, now }) => {
      const proposal = findProposal(db, circle.circle_id, params.termsHash as string);
      if (body === null || typeof body !== "object") throw invalidRequest("body harus objek");
      const { account, signature } = body as { account?: unknown; signature?: unknown };
      if (typeof account !== "string") throw invalidRequest("account wajib string");
      if (typeof signature !== "string") throw invalidRequest("signature wajib string");
      const terms = JSON.parse(proposal.terms_json) as BundleTerms;
      if (!bundleParticipants(terms).includes(account)) throw invalidRequest("akun bukan peserta bundle", { account });
      const open = await openEpoch(db, circle);
      if (open !== Number(proposal.epoch)) throw new ApiError(409, "epoch_not_open", "Epoch bundle ini bukan epoch open lagi", { bundleEpoch: Number(proposal.epoch), open });
      const pubkey = activeMemberKey(db, circle.circle_id, account);
      if (!verifyBundleSignature(terms, signature, pubkey)) {
        throw new ApiError(401, "invalid_signature", "Tanda tangan tidak cocok dengan terms_hash", { account, termsHash: proposal.terms_hash });
      }
      const inserted = db
        .prepare("INSERT OR IGNORE INTO bundle_signatures (circle_id, terms_hash, account_id, signature, signed_at_ms) VALUES (?, ?, ?, ?, ?)")
        .run(circle.circle_id, proposal.terms_hash, account, signature, now());
      if (inserted.changes === 0) throw new ApiError(409, "already_exists", "Akun ini sudah menandatangani bundle", { account });
      refreshStatus(db, circle.circle_id, proposal);
      return { status: 201, body: proposalView(db, circle.circle_id, findProposal(db, circle.circle_id, proposal.terms_hash)) };
    },
  },
];
}
