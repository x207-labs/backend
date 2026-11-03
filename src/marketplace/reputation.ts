// Minimal reputation in the read API (BE-053, UM-071 options 2 and 3): what a provider did in deals that were PAID, counted once per counterparty, so that two accounts
// that trade with each other again and again do not raise anything. No subjective rating enters: only money, deliveries and the random checks of a verifier.
//
// A performance is one handover of a match: the seller delivers the offered asset to the counterparty; in a barter match the counterparty also delivers the wanted asset.
//   completed  = the handover is confirmed (or needs no confirmation: class A, class D) AND the receiver registered the payment for it (see `paidAmount`);
//   dispute    = the receiver disputed it (BE-047), counted only from a receiver that has itself paid somebody for something (a fresh account cannot damage anyone);
//   abandoned  = the deliverer withdrew, or the receiver cancelled because nothing came by `deliver_by`.
// Each of the three counts distinct counterparties. `score` (0 to 1000) = rate of completed among the three, times a confidence that grows with the number of
// counterparties, times a factor for the random checks. The formula is in the answer, so that nobody has to guess.
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { nep413SigningHash, signHash, verifyHash, type VoucherSecretKey } from "@x207/core";
import { ApiError, invalidRequest } from "../api/errors.js";
import { row, rows } from "../api/format.js";
import { parseLimit } from "../api/pagination.js";
import type { Route } from "../api/router.js";
import { activeMemberKey } from "./auth.js";
import { nowSeconds } from "./common.js";
import { invoiceRecordOf } from "./invoices.js";

/** Counterparties needed before the confidence is one half. */
export const CONFIDENCE_HALF = 5;
export const MAX_NOTICE_SKEW_SECONDS = 600;
const HASH = /^[0-9a-f]{64}$/;
const ACCOUNT = /^(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/;

// ---- the signed result of a random check -------------------------------------------------------------------------------------------------------------------
export interface SpotCheckNotice {
  circle: string;
  subject: string;
  verifier: string;
  /** sha256 (hex) of the job that was run again */
  job_hash: string;
  passed: boolean;
  /** hash of the result that the provider gave, and of the one that the verifier got; both or none */
  expected_hash: string | null;
  got_hash: string | null;
  at: number;
}

export class SpotCheckFormatError extends Error {}

export function validateSpotCheck(n: SpotCheckNotice): void {
  const bad = (m: string): never => {
    throw new SpotCheckFormatError(m);
  };
  for (const key of ["circle", "subject", "verifier"] as const) if (typeof n[key] !== "string" || !ACCOUNT.test(n[key])) bad(`${key} must be an account id`);
  if (!HASH.test(String(n.job_hash))) bad("job_hash must be 64 lowercase hex characters");
  if (typeof n.passed !== "boolean") bad("passed must be a boolean");
  if ((n.expected_hash === null) !== (n.got_hash === null)) bad("expected_hash and got_hash must both be present or both be absent");
  for (const h of [n.expected_hash, n.got_hash]) if (h !== null && !HASH.test(String(h))) bad("expected_hash and got_hash must be 64 lowercase hex characters");
  if (n.passed && n.expected_hash !== null && n.expected_hash !== n.got_hash) bad("passed true means expected_hash equals got_hash");
  if (!n.passed && n.expected_hash !== null && n.expected_hash === n.got_hash) bad("passed false means expected_hash differs from got_hash");
  if (!Number.isSafeInteger(n.at) || n.at < 1) bad("at must be integer unix seconds");
}

const sha = (text: string): Uint8Array => createHash("sha256").update(text, "utf8").digest();
/** Canonical JSON: keys `circle, subject, verifier, job_hash, passed, expected_hash, got_hash, at`. */
export function serializeSpotCheck(n: SpotCheckNotice): string {
  validateSpotCheck(n);
  return JSON.stringify({ circle: n.circle, subject: n.subject, verifier: n.verifier, job_hash: n.job_hash, passed: n.passed, expected_hash: n.expected_hash, got_hash: n.got_hash, at: n.at });
}
export const spotCheckHash = (n: SpotCheckNotice): string => Buffer.from(sha(serializeSpotCheck(n))).toString("hex");
const signingHash = (n: SpotCheckNotice): Uint8Array => nep413SigningHash(serializeSpotCheck(n), sha(serializeSpotCheck(n)), n.circle);
export const signSpotCheck = (n: SpotCheckNotice, secretKey: VoucherSecretKey): string => signHash(signingHash(n), secretKey);
export function verifySpotCheckSignature(n: SpotCheckNotice, signature: string, publicKey: string): boolean {
  try {
    return verifyHash(signingHash(n), signature, publicKey);
  } catch {
    return false;
  }
}

// ---- the performances ---------------------------------------------------------------------------------------------------------------------------------------
interface MatchRow {
  id: bigint;
  listing_hash: string;
  seller: string;
  counterparty: string;
  mode: string;
  kind: string;
  epoch: bigint;
  terms_hash: string | null;
  listing_value: string;
  discount_value: string;
  matched_at_ms: bigint;
}
interface DeliveryRowLite {
  side: string;
  state: string;
  delivered_at: bigint | null;
  cancelled_by: string | null;
  deliver_by: bigint;
  created_at_ms: bigint;
}

type Outcome = "completed" | "dispute" | "abandoned" | "pending";
interface Performance {
  deliverer: string;
  receiver: string;
  outcome: Outcome;
  paid: boolean;
  responseSeconds: number | null;
}

/** What the receiver must have registered for this handover: `listing_value - discount_value` for a payment; the leg `receiver -> deliverer` of the bundle otherwise. */
function expectedAmount(db: Database.Database, circleId: string, m: MatchRow, deliverer: string, receiver: string): bigint | null {
  if (m.kind === "payment") return deliverer === m.seller ? BigInt(m.listing_value) - BigInt(m.discount_value) : null;
  if (m.terms_hash === null) return null;
  const p = row<{ terms_json: string }>(db, "SELECT terms_json FROM bundle_proposals WHERE circle_id = ? AND terms_hash = ?", circleId, m.terms_hash);
  if (!p) return null;
  const legs = (JSON.parse(p.terms_json) as { legs: Array<{ payer: string; payee: string; max_amount: string }> }).legs;
  const leg = legs.find((l) => l.payer === receiver && l.payee === deliverer);
  return leg ? BigInt(leg.max_amount) : null;
}

function paidAmount(db: Database.Database, circleId: string, m: MatchRow, deliverer: string, receiver: string): boolean {
  const expected = expectedAmount(db, circleId, m, deliverer, receiver);
  if (expected === null || expected <= 0n) return false;
  const o = row<{ best: bigint | null }>(
    db,
    "SELECT MAX(cumulative_amount) AS best FROM obligations WHERE circle_id = ? AND epoch >= ? AND debtor = ? AND creditor = ?",
    circleId, m.epoch, receiver, deliverer,
  );
  return o?.best !== null && o?.best !== undefined && BigInt(o.best) >= expected;
}

function performancesOf(db: Database.Database, circleId: string, account: string): Performance[] {
  const matches = rows<MatchRow>(
    db,
    "SELECT * FROM matches WHERE circle_id = ? AND (seller = ? OR (counterparty = ? AND mode = 'barter')) ORDER BY id",
    circleId, account, account,
  );
  const out: Performance[] = [];
  for (const m of matches) {
    const side = m.seller === account ? "offer" : "want";
    const deliverer = account;
    const receiver = side === "offer" ? m.counterparty : m.seller;
    const d = row<DeliveryRowLite>(db, "SELECT side, state, delivered_at, cancelled_by, deliver_by, created_at_ms FROM deliveries WHERE circle_id = ? AND listing_hash = ? AND side = ?", circleId, m.listing_hash, side);
    const paid = paidAmount(db, circleId, m, deliverer, receiver);
    let outcome: Outcome;
    let responseSeconds: number | null = null;
    if (!d) {
      outcome = paid ? "completed" : "pending";
    } else if (d.state === "confirmed") {
      outcome = paid ? "completed" : "pending";
      if (d.delivered_at !== null) responseSeconds = Math.max(0, Number(d.delivered_at) - Math.floor(Number(d.created_at_ms) / 1000));
    } else if (d.state === "disputed") {
      outcome = "dispute";
    } else if (d.state === "cancelled") {
      outcome = "abandoned";
    } else {
      outcome = "pending";
    }
    out.push({ deliverer, receiver, outcome, paid, responseSeconds });
  }
  return out;
}

/** A receiver counts as a source of disputes only if it has paid for something itself: a fresh account has nothing to lose by complaining. */
function hasPaidSomebody(db: Database.Database, circleId: string, account: string): boolean {
  const o = row<{ n: bigint }>(db, "SELECT COUNT(*) AS n FROM obligations WHERE circle_id = ? AND debtor = ? AND cumulative_amount > 0", circleId, account);
  return (o?.n ?? 0n) > 0n;
}

const distinct = (list: readonly string[]): number => new Set(list).size;
const median = (v: readonly number[]): number | null => {
  if (v.length === 0) return null;
  const s = [...v].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : Math.round(((s[mid - 1] as number) + (s[mid] as number)) / 2);
};

export function reputationOf(db: Database.Database, circleId: string, account: string) {
  const perf = performancesOf(db, circleId, account);
  const completed = perf.filter((p) => p.outcome === "completed");
  const disputes = perf.filter((p) => p.outcome === "dispute" && hasPaidSomebody(db, circleId, p.receiver));
  const abandoned = perf.filter((p) => p.outcome === "abandoned");
  // BE-051: an invoice that the debtor accepted counts for it once per issuer: all installments registered is a completed deal, a missed one (also `blocked_by_debtor`) is a failure
  const inv = invoiceRecordOf(db, circleId, account);
  // BE-069: a one-time code that the buyer confirmed (or that was confirmed by silence) is a completed sale; a complaint of a buyer about a code (`other`, `contains_pii`, "used" without a proof of cheating)
  // is counted against the seller, one per purchase and once per buyer, and only from a buyer that has paid somebody itself
  const codeSales = rows<{ buyer: string }>(db, "SELECT buyer FROM purchases WHERE circle_id = ? AND seller = ? AND kind = 'code' AND status = 'confirmed'", circleId, account).map((r) => r.buyer);
  const complaints = rows<{ buyer: string }>(db, "SELECT buyer FROM purchase_complaints WHERE circle_id = ? AND seller = ?", circleId, account).filter((r) => hasPaidSomebody(db, circleId, r.buyer));
  const cw = distinct([...completed.map((p) => p.receiver), ...inv.registered, ...codeSales]);
  const kw = distinct(complaints.map((r) => r.buyer));
  const mw = distinct(inv.missed);
  const dw = distinct(disputes.map((p) => p.receiver));
  const aw = distinct(abandoned.map((p) => p.receiver));
  const checks = rows<{ passed: bigint; verifier: string }>(db, "SELECT passed, verifier FROM spot_checks WHERE circle_id = ? AND subject = ?", circleId, account);
  const passedChecks = checks.filter((c) => c.passed === 1n).length;
  const failedChecks = checks.length - passedChecks;
  const rate = cw + dw + aw + mw + kw > 0 ? cw / (cw + dw + aw + mw + kw) : null;
  const confidence = cw / (cw + CONFIDENCE_HALF);
  const checkFactor = (passedChecks + 1) / (passedChecks + 3 * failedChecks + 1);
  const score = cw === 0 || rate === null ? 0 : Math.round(1000 * rate * confidence * checkFactor);
  const response = median(completed.map((p) => p.responseSeconds).filter((v): v is number => v !== null));
  return {
    account,
    score,
    completed: { transactions: completed.length + codeSales.length, counterparties: cw },
    complaints: { transactions: complaints.length, counterparties: kw },
    disputes: { transactions: disputes.length, counterparties: dw },
    abandoned: { transactions: abandoned.length, counterparties: aw },
    invoices: { registered: inv.registered.length, missed: inv.missed.length, blockedByDebtor: inv.blockedByDebtor, missedIssuers: mw },
    completionRate: rate === null ? null : Math.round(rate * 1000) / 1000,
    responseSeconds: { median: response, samples: completed.filter((p) => p.responseSeconds !== null).length },
    spotChecks: { passed: passedChecks, failed: failedChecks, verifiers: distinct(checks.map((c) => c.verifier)) },
    basis: "paid deals only; one count per counterparty",
    formula: `score = round(1000 * completed/(completed+disputes+abandoned+missedInvoices+codeComplaints) * completed/(completed+${CONFIDENCE_HALF}) * (checksPassed+1)/(checksPassed+3*checksFailed+1)), counts are distinct counterparties`,
  };
}

export const reputationRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/x207/circles/{circle}/reputation/{account}",
    circleScoped: true,
    handler: ({ db, circle, params }) => {
      const account = params.account as string;
      if (!ACCOUNT.test(account)) throw invalidRequest("account is not an account id", { account });
      const member = row<{ status: string }>(db, "SELECT status FROM members WHERE circle_id = ? AND account_id = ?", circle.circle_id, account);
      if (!member) throw new ApiError(404, "member_not_found", `Account ${account} is not a member`, { account });
      return { status: 200, body: { circle: circle.circle_id, memberStatus: member.status, ...reputationOf(db, circle.circle_id, account) } };
    },
  },
  {
    method: "GET",
    pattern: "/x207/circles/{circle}/reputation",
    circleScoped: true,
    handler: ({ db, circle, query }) => {
      const limit = parseLimit(query);
      const sellers = rows<{ a: string }>(
        db,
        "SELECT DISTINCT seller AS a FROM matches WHERE circle_id = ? UNION SELECT DISTINCT counterparty FROM matches WHERE circle_id = ? AND mode = 'barter'",
        circle.circle_id, circle.circle_id,
      ).map((r) => r.a);
      const items = sellers.map((a) => reputationOf(db, circle.circle_id, a)).sort((x, y) => y.score - x.score || x.account.localeCompare(y.account)).slice(0, limit);
      return { status: 200, body: { circle: circle.circle_id, items } };
    },
  },
  {
    // SV-018: a verifier that is an active member reports the result of a random check of a job. One result per (provider, job); the notice is signed with the voucher key.
    method: "POST",
    pattern: "/x207/circles/{circle}/reputation/spot-checks",
    circleScoped: true,
    handler: ({ db, circle, body, now }) => {
      if (body === null || typeof body !== "object") throw invalidRequest("body must be an object");
      const { notice, signature } = body as { notice?: unknown; signature?: unknown };
      if (typeof signature !== "string") throw invalidRequest("signature must be a string");
      if (notice === null || typeof notice !== "object") throw invalidRequest("notice must be an object");
      const n = notice as SpotCheckNotice;
      try {
        validateSpotCheck(n);
      } catch (error) {
        if (error instanceof SpotCheckFormatError) throw invalidRequest(error.message);
        throw error;
      }
      if (n.circle !== circle.contract_id) throw invalidRequest("notice.circle must be the circle contract account", { expected: circle.contract_id, got: n.circle });
      if (n.verifier === n.subject) throw invalidRequest("verifier must not check themselves");
      const nowS = nowSeconds(now());
      if (Math.abs(n.at - nowS) > MAX_NOTICE_SKEW_SECONDS) throw invalidRequest(`notice.at deviates more than ${MAX_NOTICE_SKEW_SECONDS} seconds from the server clock`, { at: n.at, now: nowS });
      const pubkey = activeMemberKey(db, circle.circle_id, n.verifier);
      if (!verifySpotCheckSignature(n, signature, pubkey)) throw new ApiError(401, "invalid_signature", "Notice signature does not match the verifier's voucher key", { account: n.verifier });
      if (!row(db, "SELECT 1 AS x FROM members WHERE circle_id = ? AND account_id = ?", circle.circle_id, n.subject)) throw new ApiError(404, "member_not_found", `Account ${n.subject} is not a member`, { account: n.subject });
      const inserted = db
        .prepare(
          `INSERT OR IGNORE INTO spot_checks (circle_id, subject, verifier, job_hash, passed, expected_hash, got_hash, at_s, notice_hash, signature, recorded_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(circle.circle_id, n.subject, n.verifier, n.job_hash, n.passed ? 1 : 0, n.expected_hash, n.got_hash, n.at, spotCheckHash(n), signature, now());
      if (inserted.changes === 0) throw new ApiError(409, "already_exists", "The spot-check result for this job is already recorded", { subject: n.subject, jobHash: n.job_hash });
      return { status: 201, body: { recorded: true, subject: n.subject, jobHash: n.job_hash, passed: n.passed, reputation: reputationOf(db, circle.circle_id, n.subject) } };
    },
  },
];
