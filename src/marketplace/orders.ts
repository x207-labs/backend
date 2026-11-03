// Service order book (BE-054, pipeline P6, ADR-45, spec 5f). The document and its rules come from `@x207/core` (SD-069, sdk/docs/order.md). Three patterns of payment:
//   milestone  the seller signs `delivered`, the buyer `confirmed` or `disputed` inside the window; silence for the whole window confirms (ADR-42, same rule as BE-047);
//   outcome    (`lead`, `bug`) the seller proposes an outcome hash for a place, the buyer says `accepted` or `rejected`; silence never pays (ADR-45 point 4);
//   proof      (`keeper`, `solver`) no milestone action: the proofs are on the chain (BE-055, order-proofs.ts).
// The backend never pays. A confirmed milestone is `paid` once the obligations of the pair (buyer, seller) since the order was made cover everything confirmed so far.
// `loadtest`: the target must be proven (file or DNS TXT with the order hash) through `target-check`, behind the guard of ssrf.ts, before the seller can deliver.
import { resolveTxt } from "node:dns/promises";
import type { ViewFunction } from "../settlement/intents.js";
import type Database from "better-sqlite3";
import { OrderError, ORDER_PATTERN, mandateHash, normalizeMandate, normalizeOrder, orderBudget, orderHash, serializeMandate, serializeOrder, type DelegateMandate, type NormalizedOrder, type OrderDocument } from "@x207/core";
import { ApiError, invalidRequest, type ApiErrorCode } from "../api/errors.js";
import { row, rows } from "../api/format.js";
import { decodeCursor, encodeCursor, parseLimit } from "../api/pagination.js";
import type { Route } from "../api/router.js";
import { activeMemberKey } from "./auth.js";
import { nowSeconds } from "./common.js";
import { DEFAULT_DISPUTE_WINDOW_SECONDS, DISPUTE_REASONS } from "./delivery-core.js";
import { DEFAULT_BOND_THRESHOLD } from "./invoices.js";
import type { OpenEpochResolver } from "./epoch.js";
import { ACCOUNT, badNotice, HASH, NOTICE_SKEW_SECONDS, NoticeFormatError, sha256Hex, verifyNoticeJson } from "./notice.js";
import { guardedGet, type Resolver, type Transport } from "./ssrf.js";

export const MILESTONE_ACTIONS = ["delivered", "confirmed", "disputed", "cancelled"] as const;
export const OUTCOME_ACTIONS = ["proposed", "accepted", "rejected"] as const;
export type MilestoneAction = (typeof MILESTONE_ACTIONS)[number] | (typeof OUTCOME_ACTIONS)[number];
export const ORDER_STATUSES = ["proposed", "open", "closed"] as const;

// ---- the notice ---------------------------------------------------------------------------------------------------------------------------------------------
export interface MilestoneNotice {
  circle: string;
  order_hash: string;
  /** the milestone (or the place of the outcome), counted from 1 */
  milestone: number;
  actor: string;
  action: MilestoneAction;
  at: number;
  /** `delivered` and `proposed`: sha256 of what was delivered; null otherwise */
  deliverable_hash: string | null;
  /** `disputed`: one of the reasons of BE-047; `rejected`: optional text; null otherwise */
  reason: string | null;
}

export function validateMilestoneNotice(n: MilestoneNotice): void {
  if (typeof n.circle !== "string" || !ACCOUNT.test(n.circle) || typeof n.actor !== "string" || !ACCOUNT.test(n.actor)) badNotice("circle dan actor harus account id");
  if (!HASH.test(String(n.order_hash))) badNotice("order_hash harus 64 heksadesimal huruf kecil");
  if (!Number.isSafeInteger(n.milestone) || n.milestone < 1) badNotice("milestone harus bilangan bulat >= 1");
  if (![...MILESTONE_ACTIONS, ...OUTCOME_ACTIONS].includes(n.action)) badNotice("action tidak dikenal");
  if (!Number.isSafeInteger(n.at) || n.at < 1) badNotice("at harus detik unix bulat");
  const needsHash = n.action === "delivered" || n.action === "proposed";
  if (needsHash ? !HASH.test(String(n.deliverable_hash)) : n.deliverable_hash !== null) badNotice("deliverable_hash wajib (64 heksadesimal) untuk delivered dan proposed, dan tidak untuk yang lain");
  if (n.action === "disputed" ? !(DISPUTE_REASONS as readonly string[]).includes(String(n.reason)) : n.action === "rejected" ? n.reason !== null && (typeof n.reason !== "string" || n.reason.length > 256) : n.reason !== null) {
    badNotice("reason wajib untuk disputed (not_received, not_as_described, other), opsional untuk rejected, dan tidak untuk yang lain");
  }
}

/** Canonical JSON: keys `circle, order_hash, milestone, actor, action, at, deliverable_hash, reason`. */
export function serializeMilestoneNotice(n: MilestoneNotice): string {
  validateMilestoneNotice(n);
  return JSON.stringify({ circle: n.circle, order_hash: n.order_hash, milestone: n.milestone, actor: n.actor, action: n.action, at: n.at, deliverable_hash: n.deliverable_hash, reason: n.reason });
}
export const milestoneNoticeHash = (n: MilestoneNotice): string => sha256Hex(serializeMilestoneNotice(n));

// ---- errors -------------------------------------------------------------------------------------------------------------------------------------------------
/** `OrderError` of the SDK as an `ApiError`; the spec names two of them without the `order_` prefix. */
export function asApiError(error: unknown): never {
  if (error instanceof OrderError) {
    const code = error.code === "order_sample_required" ? "sample_required" : error.code === "order_target_required" ? "target_required" : error.code;
    throw new ApiError(400, code as ApiErrorCode, error.message, {});
  }
  if (error instanceof NoticeFormatError) throw invalidRequest(error.message);
  throw error;
}

// ---- rows ---------------------------------------------------------------------------------------------------------------------------------------------------
export interface OrderRow {
  id: bigint;
  order_hash: string;
  kind: string;
  pattern: string;
  buyer: string;
  seller: string;
  order_json: string;
  budget: string;
  needs_bond: bigint;
  target: string | null;
  target_verified: bigint | null;
  target_checked_via: string | null;
  epoch0: bigint;
  status: string;
  mandate_json: string | null;
}
interface MilestoneRow {
  idx: bigint;
  amount: string;
  due_at: bigint;
  status: string;
  outcome: string | null;
  deliverable_hash: string | null;
  delivered_at: bigint | null;
  confirm_by: bigint | null;
  confirmed_at: bigint | null;
  auto_confirmed: bigint;
  dispute_reason: string | null;
  at_s: bigint | null;
}

const milestonesOf = (db: Database.Database, circleId: string, hash: string): MilestoneRow[] =>
  rows<MilestoneRow>(db, "SELECT * FROM order_milestones WHERE circle_id = ? AND order_hash = ? ORDER BY idx", circleId, hash);

export function findOrder(db: Database.Database, circleId: string, hash: string): OrderRow {
  if (!HASH.test(hash)) throw invalidRequest("hash pesanan harus 64 heksadesimal huruf kecil", { hash });
  const found = row<OrderRow>(db, "SELECT * FROM orders WHERE circle_id = ? AND order_hash = ?", circleId, hash);
  if (!found) throw new ApiError(404, "order_not_found", `Pesanan ${hash} tidak ada`, { orderHash: hash });
  return found;
}

/**
 * Time and the chain move orders: a delivery that the buyer left alone for the whole window is confirmed (milestone pattern only), a confirmed milestone becomes `paid`
 * when the obligations of the pair since the order was made cover it, and an order with nothing left to decide is `closed`. No clock or scheduler: every route calls this first.
 */
export function syncOrders(db: Database.Database, circleId: string, nowS: number): void {
  db.prepare(
    `UPDATE order_milestones SET status = 'confirmed', confirmed_at = confirm_by, auto_confirmed = 1
     WHERE circle_id = ? AND status = 'delivered' AND confirm_by IS NOT NULL AND confirm_by < ?`,
  ).run(circleId, nowS);
  for (const o of rows<OrderRow>(db, "SELECT * FROM orders WHERE circle_id = ? AND status IN ('open','closed')", circleId)) {
    const ms = milestonesOf(db, circleId, o.order_hash);
    if (o.pattern !== "proof") {
      const paid = row<{ total: bigint | null }>(db, "SELECT SUM(cumulative_amount) AS total FROM obligations WHERE circle_id = ? AND epoch >= ? AND debtor = ? AND creditor = ?", circleId, o.epoch0, o.buyer, o.seller)?.total ?? 0n;
      let running = 0n;
      for (const m of ms) {
        if (m.status !== "confirmed" && m.status !== "paid") continue;
        running += BigInt(m.amount);
        if (m.status === "confirmed" && paid >= running) db.prepare("UPDATE order_milestones SET status = 'paid' WHERE circle_id = ? AND order_hash = ? AND idx = ?").run(circleId, o.order_hash, m.idx);
      }
      if (ms.length > 0 && milestonesOf(db, circleId, o.order_hash).every((m) => ["confirmed", "paid", "disputed", "cancelled"].includes(m.status))) {
        db.prepare("UPDATE orders SET status = 'closed' WHERE id = ?").run(o.id);
      }
    }
  }
}

// ---- views --------------------------------------------------------------------------------------------------------------------------------------------------
export function orderView(db: Database.Database, circleId: string, o: OrderRow) {
  return {
    orderHash: o.order_hash,
    order: JSON.parse(o.order_json) as OrderDocument,
    buyer: o.buyer,
    seller: o.seller,
    status: o.status,
    needsBond: o.needs_bond === 1n,
    targetVerified: o.kind === "loadtest" ? o.target_verified === 1n : null,
    targetCheckedVia: o.target_checked_via,
    signedBy: rows<{ account: string }>(db, "SELECT account FROM order_signatures WHERE circle_id = ? AND order_hash = ? ORDER BY account", circleId, o.order_hash).map((r) => r.account),
    ...(o.mandate_json === null ? {} : { mandate: JSON.parse(o.mandate_json) as DelegateMandate }),
    budget: o.budget,
    unit: "credit",
    decimals: 6,
    milestones: milestonesOf(db, circleId, o.order_hash).map((m) => ({
      index: Number(m.idx), amount: m.amount, dueAt: Number(m.due_at), status: m.status, outcome: m.outcome, deliverableHash: m.deliverable_hash,
      at: m.at_s === null ? null : Number(m.at_s), confirmBy: m.confirm_by === null ? null : Number(m.confirm_by), autoConfirmed: m.auto_confirmed === 1n, disputeReason: m.dispute_reason,
    })),
  };
}

// ---- routes -------------------------------------------------------------------------------------------------------------------------------------------------
export interface OrderOptions {
  /** View of the chain: with it, `mandate.dao` of a delegate order must answer the Sputnik view `get_policy` (BE-055 fix, `order_bad_mandate` / `not_a_dao`). */
  chainView?: ViewFunction;
  /** Amount (smallest unit) at or above which an order needs the bond of CT-094 (ADR-45 point 2). */
  bondThreshold?: bigint;
  disputeWindowSeconds?: number;
  /** For `target-check`: replace the DNS resolver, the HTTPS transport, or the lookup of TXT records (tests). */
  targetCheck?: { resolver?: Resolver; transport?: Transport; txt?: (host: string) => Promise<string[][]> };
}

const NO_SUCH_VIEW = /MethodNotFound|CodeDoesNotExist|AccountDoesNotExist|does not exist|doesn't exist|not found/i;
/** A Sputnik DAO answers `get_policy`; an account that does not, or that is not a contract, is refused. A failure of the RPC itself is not a verdict on the account (503). */
async function assertDao(view: ViewFunction, dao: string): Promise<void> {
  let policy: unknown;
  try {
    policy = await view(dao, "get_policy", {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (NO_SUCH_VIEW.test(message)) throw new ApiError(400, "order_bad_mandate", `mandate.dao ${dao} tidak punya view get_policy`, { reason: "not_a_dao", dao });
    throw new ApiError(503, "claim_rpc_unavailable", "RPC tidak menjawab saat memeriksa mandate.dao", { dao });
  }
  if (policy === null || typeof policy !== "object") throw new ApiError(400, "order_bad_mandate", `mandate.dao ${dao} tidak menjawab get_policy dengan objek`, { reason: "not_a_dao", dao });
}

export function orderRoutes(resolveOpenEpoch: OpenEpochResolver, options: OrderOptions = {}): Route[] {
  const threshold = options.bondThreshold ?? DEFAULT_BOND_THRESHOLD;
  const window = options.disputeWindowSeconds ?? DEFAULT_DISPUTE_WINDOW_SECONDS;
  const txt = options.targetCheck?.txt ?? ((host: string) => resolveTxt(host));

  /** Verify the notice of a body for an order: format, circle, clock, signature of an active member. */
  function readNotice(db: Database.Database, circle: { circle_id: string; contract_id: string }, o: OrderRow, body: unknown, now: () => number, index?: number) {
    if (body === null || typeof body !== "object") throw invalidRequest("body harus objek");
    const { notice, signature } = body as { notice?: unknown; signature?: unknown };
    if (typeof signature !== "string") throw invalidRequest("signature wajib string");
    if (notice === null || typeof notice !== "object") throw invalidRequest("notice wajib objek");
    const n = notice as MilestoneNotice;
    try {
      validateMilestoneNotice(n);
    } catch (error) {
      asApiError(error);
    }
    if (n.circle !== circle.contract_id) throw invalidRequest("notice.circle harus akun kontrak lingkaran", { expected: circle.contract_id, got: n.circle });
    if (n.order_hash !== o.order_hash) throw invalidRequest("notice.order_hash harus hash pesanan ini");
    if (index !== undefined && n.milestone !== index) throw invalidRequest("notice.milestone harus sama dengan index di path", { index, got: n.milestone });
    const nowS = nowSeconds(now());
    if (Math.abs(n.at - nowS) > NOTICE_SKEW_SECONDS) throw invalidRequest(`notice.at menyimpang lebih dari ${NOTICE_SKEW_SECONDS} detik dari jam server`, { at: n.at, now: nowS });
    if (n.actor !== o.buyer && n.actor !== o.seller) throw new ApiError(403, "order_not_party", "Hanya pembeli atau penjual pesanan ini yang boleh mengirim notice", { actor: n.actor });
    if (!verifyNoticeJson(serializeMilestoneNotice(n), circle.contract_id, signature, activeMemberKey(db, circle.circle_id, n.actor))) {
      throw new ApiError(401, "invalid_signature", "Tanda tangan notice tidak cocok dengan kunci voucher anggota", { account: n.actor });
    }
    return { n, signature, nowS };
  }

  function record(db: Database.Database, circleId: string, n: MilestoneNotice, signature: string, nowMs: number): void {
    const inserted = db
      .prepare(
        `INSERT OR IGNORE INTO order_notices (circle_id, order_hash, milestone, notice_hash, actor, action, at_s, deliverable_hash, reason, signature, recorded_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(circleId, n.order_hash, n.milestone, milestoneNoticeHash(n), n.actor, n.action, n.at, n.deliverable_hash, n.reason, signature, nowMs);
    if (inserted.changes === 0) throw new ApiError(409, "already_exists", "Notice ini sudah tercatat", {});
  }

  function milestoneOf(db: Database.Database, circleId: string, hash: string, index: number): MilestoneRow {
    const m = row<MilestoneRow>(db, "SELECT * FROM order_milestones WHERE circle_id = ? AND order_hash = ? AND idx = ?", circleId, hash, index);
    if (!m) throw new ApiError(404, "milestone_not_found", `Tonggak ${index} tidak ada`, { index });
    return m;
  }

  const refuse = (message: string, details: Record<string, unknown> = {}): never => {
    throw new ApiError(409, "order_bad_state", message, details);
  };

  return [
    {
      method: "POST",
      pattern: "/x207/circles/{circle}/orders",
      circleScoped: true,
      handler: async ({ db, circle, body, now }) => {
        syncOrders(db, circle.circle_id, nowSeconds(now()));
        if (body === null || typeof body !== "object") throw invalidRequest("body harus objek");
        const { order, signatures, mandate } = body as { order?: unknown; signatures?: unknown; mandate?: unknown };
        if (order === null || typeof order !== "object") throw invalidRequest("order wajib objek");
        if (!Array.isArray(signatures) || signatures.length === 0) throw invalidRequest("signatures wajib array berisi {account, signature}");
        let doc: NormalizedOrder;
        let mandateJson: string | null = null;
        let daoToCheck: string | null = null;
        let hash: string;
        let json: string;
        try {
          doc = normalizeOrder(order as OrderDocument);
          json = serializeOrder(doc);
          hash = orderHash(doc);
          if (doc.kind === "delegate") {
            if (mandate === null || typeof mandate !== "object") throw new OrderError("order_mandate_required", "pesanan delegate wajib membawa dokumen mandate {circle, dao, kinds, rules_hash}");
            const m = normalizeMandate(mandate as DelegateMandate);
            if (mandateHash(m) !== doc.mandate_hash) throw new OrderError("order_bad_mandate", "sha256 dari mandate tidak sama dengan order.mandate_hash");
            if (m.circle !== circle.contract_id) throw new OrderError("order_bad_mandate", "mandate.circle harus akun kontrak lingkaran");
            mandateJson = serializeMandate(m);
            daoToCheck = m.dao;
          } else if (mandate !== undefined && mandate !== null) {
            throw new OrderError("order_mandate_forbidden", "mandate hanya untuk pesanan delegate");
          }
        } catch (error) {
          return asApiError(error);
        }
        if (doc.circle !== circle.contract_id) throw invalidRequest("order.circle harus akun kontrak lingkaran", { expected: circle.contract_id, got: doc.circle });
        if (daoToCheck !== null && options.chainView !== undefined) await assertDao(options.chainView, daoToCheck);
        const keys = { [doc.buyer]: activeMemberKey(db, circle.circle_id, doc.buyer), [doc.seller]: activeMemberKey(db, circle.circle_id, doc.seller) };
        const given = new Map<string, string>();
        for (const s of signatures as Array<{ account?: unknown; signature?: unknown }>) {
          if (typeof s?.account !== "string" || typeof s.signature !== "string") throw invalidRequest("tiap signature wajib {account, signature}");
          const key = keys[s.account];
          if (key === undefined) throw new ApiError(403, "order_not_party", "Hanya pembeli dan penjual yang menandatangani pesanan", { account: s.account });
          if (!verifyNoticeJson(json, circle.contract_id, s.signature, key)) throw new ApiError(401, "invalid_signature", "Tanda tangan tidak cocok dengan kunci voucher anggota", { account: s.account });
          given.set(s.account, s.signature);
        }
        const existing = row<OrderRow>(db, "SELECT * FROM orders WHERE circle_id = ? AND order_hash = ?", circle.circle_id, hash);
        const have = new Set(rows<{ account: string }>(db, "SELECT account FROM order_signatures WHERE circle_id = ? AND order_hash = ?", circle.circle_id, hash).map((r) => r.account));
        const fresh = [...given.keys()].filter((a) => !have.has(a));
        if (existing && fresh.length === 0) throw new ApiError(409, "order_duplicate", "Pesanan dengan hash ini sudah ada dan tanda tangan ini sudah tercatat", { orderHash: hash });
        const open = await resolveOpenEpoch(db, circle);
        db.transaction(() => {
          if (!existing) {
            const pattern = ORDER_PATTERN[doc.kind];
            db.prepare(
              `INSERT INTO orders (circle_id, order_hash, kind, pattern, buyer, seller, order_json, budget, needs_bond, target, epoch0, status, created_at_ms, mandate_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`,
            ).run(circle.circle_id, hash, doc.kind, pattern, doc.buyer, doc.seller, json, orderBudget(doc), BigInt(orderBudget(doc)) >= threshold ? 1 : 0, doc.target, open ?? 0, now(), mandateJson);
            doc.milestones.forEach((m, i) => {
              db.prepare("INSERT INTO order_milestones (circle_id, order_hash, idx, amount, due_at) VALUES (?, ?, ?, ?, ?)").run(circle.circle_id, hash, i + 1, m.amount, m.due_at);
            });
          }
          for (const a of fresh) db.prepare("INSERT INTO order_signatures (circle_id, order_hash, account, signature) VALUES (?, ?, ?, ?)").run(circle.circle_id, hash, a, given.get(a));
          if (have.size + fresh.length >= 2) db.prepare("UPDATE orders SET status = 'open' WHERE circle_id = ? AND order_hash = ? AND status = 'proposed'").run(circle.circle_id, hash);
        })();
        return { status: existing ? 200 : 201, body: { order_hash: hash, ...orderView(db, circle.circle_id, findOrder(db, circle.circle_id, hash)) } };
      },
    },
    {
      method: "GET",
      pattern: "/x207/circles/{circle}/orders",
      circleScoped: true,
      handler: ({ db, circle, query, now }) => {
        syncOrders(db, circle.circle_id, nowSeconds(now()));
        const limit = parseLimit(query);
        const cursor = decodeCursor(query);
        const party = query.get("party");
        const status = query.get("status");
        if (party !== null && !ACCOUNT.test(party)) throw invalidRequest("party bukan account id", { party });
        if (status !== null && !(ORDER_STATUSES as readonly string[]).includes(status)) throw invalidRequest("status tidak dikenal", { status });
        let after = Number.MAX_SAFE_INTEGER;
        if (cursor) {
          if (typeof cursor.a !== "number" || !Number.isSafeInteger(cursor.a)) throw invalidRequest("cursor tidak valid");
          after = cursor.a;
        }
        const list = rows<OrderRow>(
          db,
          `SELECT * FROM orders WHERE circle_id = ? AND id < ? AND (? IS NULL OR buyer = ? OR seller = ?) AND (? IS NULL OR status = ?) ORDER BY id DESC LIMIT ?`,
          circle.circle_id, after, party, party, party, status, status, limit + 1,
        );
        const page = list.slice(0, limit);
        const last = page[page.length - 1];
        return {
          status: 200,
          body: { unit: "credit", decimals: 6, items: page.map((o) => orderView(db, circle.circle_id, o)), nextCursor: list.length > limit && last ? encodeCursor({ a: Number(last.id) }) : null },
        };
      },
    },
    {
      method: "GET",
      pattern: "/x207/circles/{circle}/orders/{hash}",
      circleScoped: true,
      handler: ({ db, circle, params, now }) => {
        syncOrders(db, circle.circle_id, nowSeconds(now()));
        return { status: 200, body: orderView(db, circle.circle_id, findOrder(db, circle.circle_id, params.hash as string)) };
      },
    },
    {
      method: "POST",
      pattern: "/x207/circles/{circle}/orders/{hash}/milestones/{index}",
      circleScoped: true,
      handler: ({ db, circle, params, body, now }) => {
        syncOrders(db, circle.circle_id, nowSeconds(now()));
        const o = findOrder(db, circle.circle_id, params.hash as string);
        if (!/^[1-9]\d*$/.test(params.index as string)) throw invalidRequest("index tonggak harus bilangan bulat >= 1", { index: params.index });
        const index = Number(params.index);
        const m = milestoneOf(db, circle.circle_id, o.order_hash, index);
        const { n, signature, nowS } = readNotice(db, circle, o, body, now, index);
        if (!(MILESTONE_ACTIONS as readonly string[]).includes(n.action)) throw invalidRequest("action untuk tonggak: delivered, confirmed, disputed, atau cancelled; hasil dikirim ke outcomes");
        if (o.pattern !== "milestone") refuse(`pesanan ${o.kind} tidak dibayar per tonggak`, { kind: o.kind });
        if (o.status !== "open") refuse(`pesanan belum terbuka (keadaan ${o.status}): kedua pihak harus menandatangani`, { status: o.status });
        const isSeller = n.actor === o.seller;
        const bad = (message: string): never => refuse(message, { state: m.status, action: n.action });
        const notParty = (message: string): never => {
          throw new ApiError(403, "order_not_party", message, { actor: n.actor });
        };
        let update: string;
        let args: unknown[];
        switch (n.action) {
          case "delivered":
            if (!isSeller) notParty("Hanya penjual yang menandai terkirim");
            if (m.status !== "open") bad(`delivered hanya dari open, keadaan sekarang ${m.status}`);
            if (o.kind === "loadtest" && o.target_verified !== 1n) throw new ApiError(409, "target_unverified", "Kepemilikan target belum terbukti: jalankan target-check dulu", { target: o.target });
            update = "status = 'delivered', deliverable_hash = ?, delivered_at = ?, confirm_by = ?, at_s = ?";
            args = [n.deliverable_hash, n.at, n.at + window, n.at];
            break;
          case "confirmed":
            if (isSeller) notParty("Hanya pembeli yang mengonfirmasi");
            if (m.status !== "delivered") bad(`confirmed hanya dari delivered, keadaan sekarang ${m.status}`);
            update = "status = 'confirmed', confirmed_at = ?, at_s = ?";
            args = [n.at, n.at];
            break;
          case "disputed":
            if (isSeller) notParty("Hanya pembeli yang menyengketakan");
            if (m.status !== "delivered") bad(`disputed hanya dari delivered, keadaan sekarang ${m.status}`);
            if (n.at > Number(m.confirm_by)) bad("jendela sengketa sudah lewat");
            update = "status = 'disputed', dispute_reason = ?, at_s = ?";
            args = [n.reason, n.at];
            break;
          default:
            // the seller may withdraw until the buyer confirms; the buyer may cancel only a milestone that is still open after its due date
            if (isSeller) {
              if (m.status !== "open" && m.status !== "delivered") bad(`cancelled dari penjual hanya dari open atau delivered, keadaan sekarang ${m.status}`);
            } else {
              if (m.status !== "open") bad(`cancelled dari pembeli hanya dari open, keadaan sekarang ${m.status}`);
              if (nowS <= Number(m.due_at)) bad("pembeli baru boleh membatalkan setelah due_at");
            }
            update = "status = 'cancelled', at_s = ?";
            args = [n.at];
        }
        db.transaction(() => {
          record(db, circle.circle_id, n, signature, now());
          db.prepare(`UPDATE order_milestones SET ${update} WHERE circle_id = ? AND order_hash = ? AND idx = ?`).run(...args, circle.circle_id, o.order_hash, index);
        })();
        syncOrders(db, circle.circle_id, nowS);
        return { status: 201, body: orderView(db, circle.circle_id, findOrder(db, circle.circle_id, o.order_hash)) };
      },
    },
    {
      method: "POST",
      pattern: "/x207/circles/{circle}/orders/{hash}/outcomes",
      circleScoped: true,
      handler: ({ db, circle, params, body, now }) => {
        syncOrders(db, circle.circle_id, nowSeconds(now()));
        const o = findOrder(db, circle.circle_id, params.hash as string);
        const { n, signature, nowS } = readNotice(db, circle, o, body, now);
        if (!(OUTCOME_ACTIONS as readonly string[]).includes(n.action)) throw invalidRequest("action untuk hasil: proposed, accepted, atau rejected");
        if (o.pattern !== "outcome") refuse(`pesanan ${o.kind} tidak dibayar per hasil`, { kind: o.kind });
        if (o.status !== "open") refuse(`pesanan belum terbuka (keadaan ${o.status}): kedua pihak harus menandatangani`, { status: o.status });
        const m = milestoneOf(db, circle.circle_id, o.order_hash, n.milestone);
        const isSeller = n.actor === o.seller;
        const bad = (message: string): never => refuse(message, { state: m.status, action: n.action });
        const notParty = (message: string): never => {
          throw new ApiError(403, "order_not_party", message, { actor: n.actor });
        };
        let update: string;
        let args: unknown[];
        if (n.action === "proposed") {
          if (!isSeller) notParty("Hanya penjual yang mengajukan hasil");
          if (m.status !== "open") bad(`proposed hanya dari open, keadaan sekarang ${m.status}`);
          // the same result cannot fill two places: one conversion or one bug is paid once
          if (row(db, "SELECT 1 AS x FROM order_milestones WHERE circle_id = ? AND order_hash = ? AND deliverable_hash = ?", circle.circle_id, o.order_hash, n.deliverable_hash)) bad("outcome_hash ini sudah diajukan untuk tempat lain");
          update = "status = 'delivered', deliverable_hash = ?, delivered_at = ?, at_s = ?";
          args = [n.deliverable_hash, n.at, n.at];
        } else {
          if (isSeller) notParty("Hanya pembeli yang menerima atau menolak hasil");
          if (m.status !== "delivered") bad(`${n.action} hanya dari delivered, keadaan sekarang ${m.status}`);
          // no automatic confirmation here: silence never pays a result (ADR-45 point 4)
          update = n.action === "accepted" ? "status = 'confirmed', outcome = 'accepted', confirmed_at = ?, at_s = ?" : "status = 'disputed', outcome = 'rejected', dispute_reason = ?, at_s = ?";
          args = n.action === "accepted" ? [n.at, n.at] : [n.reason, n.at];
        }
        db.transaction(() => {
          record(db, circle.circle_id, n, signature, now());
          db.prepare(`UPDATE order_milestones SET ${update} WHERE circle_id = ? AND order_hash = ? AND idx = ?`).run(...args, circle.circle_id, o.order_hash, n.milestone);
        })();
        syncOrders(db, circle.circle_id, nowS);
        return { status: 201, body: orderView(db, circle.circle_id, findOrder(db, circle.circle_id, o.order_hash)) };
      },
    },
    {
      method: "POST",
      pattern: "/x207/circles/{circle}/orders/{hash}/target-check",
      circleScoped: true,
      handler: async ({ db, circle, params }) => {
        const o = findOrder(db, circle.circle_id, params.hash as string);
        if (o.kind !== "loadtest" || o.target === null) refuse("target-check hanya untuk pesanan uji beban", { kind: o.kind });
        const target = o.target as string;
        // the file first: it passes through the guard, so a target that resolves to the network of the server is refused even if its TXT record would verify
        const guard = { ...(options.targetCheck?.resolver ? { resolver: options.targetCheck.resolver } : {}), ...(options.targetCheck?.transport ? { transport: options.targetCheck.transport } : {}), code: "target_forbidden" as const };
        let via: string | null = null;
        const file = await guardedGet(`https://${target}/.well-known/x207-loadtest`, guard);
        if (file.reachable && file.status === 200 && file.body.trim() === o.order_hash) via = "well-known";
        if (via === null) {
          try {
            const records = await txt(target);
            if (records.some((r) => r.join("") === `x207-loadtest=${o.order_hash}`)) via = "dns";
          } catch {
            // no TXT record: not verified
          }
        }
        db.prepare("UPDATE orders SET target_verified = ?, target_checked_via = ? WHERE id = ?").run(via === null ? 0 : 1, via, o.id);
        return { status: 200, body: { order_hash: o.order_hash, target, target_verified: via !== null, checked_via: via } };
      },
    },
  ];
}
