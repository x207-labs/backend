// Invoice book and installments (BE-051, pipeline P8, ADR-44, spec 5e). The document and the vouchers follow `@x207/core` (SD-065, docs/invoice.md of the SDK) and the errors of
// `InvoiceError` are passed on as they are. The backend does not register vouchers: the issuer does. What the backend does is keep the evidence (vouchers signed by the debtor in advance),
// and tell, from the events of the contract that the indexer stored, what happened to each installment:
//   registered         the cumulative amount registered for the pair (payer, payee, epoch) is at least that of the voucher we wait for, from a voucher of any `seq` (an ordinary
//                      voucher of the debtor starts at seq 2 and already carries the installment), or the event `voucher_registered` of exactly our voucher;
//   blocked_by_debtor  the epoch is closed and the pair holds a voucher, but with less than the installment (the debtor got in first, ERR_SEQ_NOT_INCREASING for the issuer): `missed` at once;
//   headroom           the epoch is closed and the pair holds no voucher at all: the installment stays `scheduled` (with `reason`) so that the debtor can shift it once (`catch-up`);
//                      a second failure of the shifted installment, or the close of the epoch it would have to move to, makes it `missed`.
import type Database from "better-sqlite3";
import {
  InvoiceError, catchUpVoucher, installmentVoucher, invoiceHash, planInstallments, serializeInvoice, verifyVoucher, MAX_INSTALLMENTS,
  type InstallmentPlan, type InvoiceDocument, type InvoicePairState, type UnsignedVoucher, type Voucher,
} from "@x207/core";
import { ApiError, invalidRequest, type ApiErrorCode } from "../api/errors.js";
import { row, rows } from "../api/format.js";
import { decodeCursor, encodeCursor, parseLimit } from "../api/pagination.js";
import type { Route } from "../api/router.js";
import { activeMemberKey } from "./auth.js";
import { nowSeconds } from "./common.js";
import type { OpenEpochResolver } from "./epoch.js";
import { eventData, eventField } from "./event-data.js";
import { ACCOUNT, badNotice, HASH, NOTICE_SKEW_SECONDS, NoticeFormatError, verifyNoticeJson } from "./notice.js";

/** Default of the contract (`DEFAULT_BOND_THRESHOLD`): an invoice at or above this amount needs the bond of CT-094. */
export const DEFAULT_BOND_THRESHOLD = 100_000_000n;
export const INVOICE_STATUSES = ["requested", "approved", "registered", "rejected", "expired", "missed"] as const;
export const INVOICE_ACTIONS = ["requested", "rejected"] as const;
export type InvoiceAction = (typeof INVOICE_ACTIONS)[number];

// ---- the notice ---------------------------------------------------------------------------------------------------------------------------------------------
export interface InvoiceNotice {
  circle: string;
  invoice_hash: string;
  actor: string;
  action: InvoiceAction;
  at: number;
  /** only with `rejected`, optional */
  reason: string | null;
}

export function validateInvoiceNotice(n: InvoiceNotice): void {
  if (typeof n.circle !== "string" || !ACCOUNT.test(n.circle) || typeof n.actor !== "string" || !ACCOUNT.test(n.actor)) badNotice("circle dan actor harus account id");
  if (!HASH.test(String(n.invoice_hash))) badNotice("invoice_hash harus 64 heksadesimal huruf kecil");
  if (!(INVOICE_ACTIONS as readonly string[]).includes(n.action)) badNotice("action harus requested atau rejected");
  if (!Number.isSafeInteger(n.at) || n.at < 1) badNotice("at harus detik unix bulat");
  if (n.action === "requested" ? n.reason !== null : n.reason !== null && (typeof n.reason !== "string" || n.reason.length === 0 || n.reason.length > 256)) {
    badNotice("reason hanya untuk rejected, paling banyak 256 karakter");
  }
}

/** Canonical JSON: keys `circle, invoice_hash, actor, action, at, reason`. */
export function serializeInvoiceNotice(n: InvoiceNotice): string {
  validateInvoiceNotice(n);
  return JSON.stringify({ circle: n.circle, invoice_hash: n.invoice_hash, actor: n.actor, action: n.action, at: n.at, reason: n.reason });
}

// ---- errors -------------------------------------------------------------------------------------------------------------------------------------------------
const CONFLICT_CODES = new Set(["installment_already_shifted", "installment_bad_state"]);

/** `InvoiceError` of the SDK as an `ApiError` with the same code. */
function asApiError(error: unknown): never {
  if (error instanceof InvoiceError) {
    const status = error.code === "installment_not_found" ? 404 : CONFLICT_CODES.has(error.code) ? 409 : 400;
    throw new ApiError(status, error.code as ApiErrorCode, error.message, {});
  }
  if (error instanceof NoticeFormatError) throw invalidRequest(error.message);
  throw error;
}

// ---- rows ---------------------------------------------------------------------------------------------------------------------------------------------------
interface InvoiceRow {
  id: bigint;
  invoice_hash: string;
  issuer: string;
  debtor: string;
  document_json: string;
  amount: string;
  installment_count: bigint;
  first_epoch: bigint;
  needs_bond: bigint;
  status: string;
  reject_reason: string | null;
  created_at_ms: bigint;
  decided_at_ms: bigint | null;
}
interface InstallmentRow {
  idx: bigint;
  epoch: bigint;
  amount: string;
  status: string;
  reason: string | null;
  shifted: bigint;
  v_epoch: bigint | null;
  v_seq: bigint | null;
  v_cumulative: string | null;
  voucher_json: string | null;
  signature: string | null;
  catch_up_json: string | null;
  catch_up_signature: string | null;
}

const installmentsOf = (db: Database.Database, circleId: string, hash: string): InstallmentRow[] =>
  rows<InstallmentRow>(db, "SELECT * FROM invoice_installments WHERE circle_id = ? AND invoice_hash = ? ORDER BY idx", circleId, hash);

function findInvoice(db: Database.Database, circleId: string, hash: string): InvoiceRow {
  if (!HASH.test(hash)) throw invalidRequest("hash invoice harus 64 heksadesimal huruf kecil", { hash });
  const found = row<InvoiceRow>(db, "SELECT * FROM invoices WHERE circle_id = ? AND invoice_hash = ?", circleId, hash);
  if (!found) throw new ApiError(404, "invoice_not_found", `Invoice ${hash} tidak ada`, { invoiceHash: hash });
  return found;
}

// ---- reading the chain --------------------------------------------------------------------------------------------------------------------------------------
/** An epoch is over once its phase left `open`, or a later epoch exists in D9. */
export function epochClosed(db: Database.Database, circleId: string, epoch: number): boolean {
  const e = row<{ phase: string }>(db, "SELECT phase FROM epochs WHERE circle_id = ? AND epoch = ?", circleId, epoch);
  if (e && e.phase !== "open") return true;
  return row(db, "SELECT 1 AS x FROM epochs WHERE circle_id = ? AND epoch > ?", circleId, epoch) !== undefined;
}

function pairState(db: Database.Database, circleId: string, epoch: number, debtor: string, issuer: string): InvoicePairState {
  const o = row<{ seq: bigint; cumulative_amount: bigint }>(db, "SELECT seq, cumulative_amount FROM obligations WHERE circle_id = ? AND epoch = ? AND debtor = ? AND creditor = ?", circleId, epoch, debtor, issuer);
  return o ? { seq: Number(o.seq), cumulativeAmount: o.cumulative_amount.toString() } : { seq: 0, cumulativeAmount: "0" };
}

/** `true` when the contract registered exactly this voucher: the event carries (payer, payee, epoch, seq) and the cumulative amount. */
function registeredOnChain(db: Database.Database, contractId: string, debtor: string, issuer: string, epoch: number, seq: number, cumulative: string): boolean {
  const events = rows<{ data_json: string }>(
    db,
    `SELECT data_json FROM events_raw WHERE contract_id = ? AND event = 'voucher_registered'
       AND ${eventField('payer')} = ? AND ${eventField('payee')} = ? AND ${eventField('epoch')} = ? AND ${eventField('seq')} = ?`,
    contractId, debtor, issuer, epoch, seq,
  );
  return events.some((e) => String(eventData<{ cumulative_amount?: unknown }>(e.data_json).cumulative_amount) === cumulative);
}

/**
 * Bring the installments of the invoices of a circle up to date with what the indexer saw (see the head of this file), and the status of each invoice with them.
 * Called by every route of this book and by the reputation (BE-053), so no clock or scheduler is needed.
 */
export function syncInvoices(db: Database.Database, circleId: string): void {
  const circle = row<{ contract_id: string }>(db, "SELECT contract_id FROM circles WHERE circle_id = ?", circleId);
  if (!circle) return;
  const open = rows<InvoiceRow>(db, "SELECT * FROM invoices WHERE circle_id = ? AND status IN ('requested','approved','missed')", circleId);
  for (const inv of open) {
    if (inv.status === "requested") {
      // nobody approved before the first epoch closed: the voucher of the first installment could not be registered any more
      if (epochClosed(db, circleId, Number(inv.first_epoch))) db.prepare("UPDATE invoices SET status = 'expired', decided_at_ms = ? WHERE id = ?").run(Date.now(), inv.id);
      continue;
    }
    for (const it of installmentsOf(db, circleId, inv.invoice_hash)) {
      if ((it.status !== "scheduled" && it.status !== "shifted") || it.v_epoch === null || it.v_seq === null || it.v_cumulative === null) continue;
      const vEpoch = Number(it.v_epoch);
      const vSeq = Number(it.v_seq);
      const set = (status: string, reason: string | null): void => {
        db.prepare("UPDATE invoice_installments SET status = ?, reason = ? WHERE circle_id = ? AND invoice_hash = ? AND idx = ?").run(status, reason, circleId, inv.invoice_hash, it.idx);
      };
      // paid when the pair holds at least the cumulative amount of our voucher, under any seq: an ordinary voucher of the debtor starts at seq 2 and already carries the installment
      const pair = pairState(db, circleId, vEpoch, inv.debtor, inv.issuer);
      if (registeredOnChain(db, circle.contract_id, inv.debtor, inv.issuer, vEpoch, vSeq, it.v_cumulative) || BigInt(pair.cumulativeAmount) >= BigInt(it.v_cumulative)) {
        set("registered", null);
        continue;
      }
      if (!epochClosed(db, circleId, vEpoch)) continue;
      // the epoch is over: a voucher of the pair is registered but holds less than the installment -> the debtor got in first; none at all -> no headroom
      if (pair.seq > 0) {
        set("missed", "blocked_by_debtor");
      } else if (it.shifted === 1n) {
        set("missed", "headroom");
      } else if (epochClosed(db, circleId, vEpoch + 1)) {
        // no room to shift to any more
        set("missed", "headroom");
      } else {
        set("scheduled", "headroom");
      }
    }
    const all = installmentsOf(db, circleId, inv.invoice_hash);
    const status = all.some((i) => i.status === "missed") ? "missed" : all.every((i) => i.status === "registered") ? "registered" : "approved";
    if (status !== inv.status) db.prepare("UPDATE invoices SET status = ? WHERE id = ?").run(status, inv.id);
  }
}

/** For the reputation (BE-053): what a debtor did with the invoices it accepted, per issuer. */
export function invoiceRecordOf(db: Database.Database, circleId: string, debtor: string): { registered: string[]; missed: string[]; blockedByDebtor: number } {
  syncInvoices(db, circleId);
  const all = rows<InvoiceRow>(db, "SELECT * FROM invoices WHERE circle_id = ? AND debtor = ? AND status IN ('registered','missed')", circleId, debtor);
  const missed = all.filter((i) => i.status === "missed");
  const blocked = missed.filter((i) => installmentsOf(db, circleId, i.invoice_hash).some((it) => it.reason === "blocked_by_debtor" && it.status === "missed"));
  return { registered: all.filter((i) => i.status === "registered").map((i) => i.issuer), missed: missed.map((i) => i.issuer), blockedByDebtor: blocked.length };
}

// ---- views --------------------------------------------------------------------------------------------------------------------------------------------------
function invoiceView(db: Database.Database, circleId: string, inv: InvoiceRow) {
  return {
    invoiceHash: inv.invoice_hash,
    document: JSON.parse(inv.document_json) as InvoiceDocument,
    issuer: inv.issuer,
    debtor: inv.debtor,
    status: inv.status,
    needsBond: inv.needs_bond === 1n,
    rejectReason: inv.reject_reason,
    createdAt: new Date(Number(inv.created_at_ms)).toISOString().replace(/\.\d{3}Z$/, "Z"),
    unit: "credit",
    decimals: 6,
    // `epoch` is the scheduled epoch (it never changes: the plan of the SDK is computed from it); `voucherEpoch` is where the voucher we wait for lives (one later after a shift)
    installments: installmentsOf(db, circleId, inv.invoice_hash).map((it) => ({
      index: Number(it.idx), epoch: Number(it.epoch), amount: it.amount, status: it.status, reason: it.reason,
      voucherEpoch: it.v_epoch === null ? null : Number(it.v_epoch), shifted: it.shifted === 1n,
      // the voucher that the issuer registers, signed by the debtor: the one of the plan, or the catch-up voucher after a shift. Anybody may register it, and it pays the issuer only what the debtor approved
      voucher: JSON.parse((it.shifted === 1n ? it.catch_up_json : it.voucher_json) ?? "null") as UnsignedVoucher | null,
      signature: it.shifted === 1n ? it.catch_up_signature : it.signature,
    })),
  };
}

const planOf = (contractId: string, inv: InvoiceRow): InstallmentPlan =>
  planInstallments({ circle: contractId, doc: JSON.parse(inv.document_json) as InvoiceDocument, firstEpoch: Number(inv.first_epoch), count: Number(inv.installment_count) });

// ---- checks on what the debtor signs --------------------------------------------------------------------------------------------------------------------------
type VoucherInput = { voucher?: unknown; signature?: unknown };

/** The voucher of the body, with its signature, when it is exactly `expected`; `installment_voucher_mismatch` when not. */
function exactVoucher(input: VoucherInput, expected: UnsignedVoucher, debtorKey: string, where: string): Voucher {
  if (input === null || typeof input !== "object" || input.voucher === null || typeof input.voucher !== "object" || typeof input.signature !== "string") {
    throw invalidRequest(`${where}: voucher dan signature wajib`);
  }
  const v = input.voucher as Record<string, unknown>;
  const keys: Array<keyof UnsignedVoucher> = ["circle", "payer", "payee", "epoch", "seq", "cumulativeAmount", "unit", "resource"];
  const diff = keys.filter((k) => v[k] !== expected[k]);
  if (diff.length > 0) throw new ApiError(409, "installment_voucher_mismatch", `${where}: voucher tidak sama dengan yang dihitung dari dokumen dan jadwal`, { fields: diff });
  const signed = { ...expected, signature: input.signature } as Voucher;
  if (!verifyVoucher(signed, debtorKey)) throw new ApiError(401, "invalid_signature", `${where}: tanda tangan voucher tidak cocok dengan kunci voucher debtor`, { account: expected.payer });
  return signed;
}

function readNotice(body: unknown, now: () => number): { notice: InvoiceNotice; signature: string; raw: Record<string, unknown> } {
  if (body === null || typeof body !== "object") throw invalidRequest("body harus objek");
  const raw = body as Record<string, unknown>;
  if (typeof raw.signature !== "string") throw invalidRequest("signature wajib string");
  if (raw.notice === null || typeof raw.notice !== "object") throw invalidRequest("notice wajib objek");
  const notice = raw.notice as InvoiceNotice;
  try {
    validateInvoiceNotice(notice);
  } catch (error) {
    asApiError(error);
  }
  const nowS = nowSeconds(now());
  if (Math.abs(notice.at - nowS) > NOTICE_SKEW_SECONDS) throw invalidRequest(`notice.at menyimpang lebih dari ${NOTICE_SKEW_SECONDS} detik dari jam server`, { at: notice.at, now: nowS });
  return { notice, signature: raw.signature, raw };
}

export interface InvoiceOptions {
  /** Amount (smallest unit) at or above which an invoice needs the bond of CT-094. */
  bondThreshold?: bigint;
}

export function invoiceRoutes(resolveOpenEpoch: OpenEpochResolver, options: InvoiceOptions = {}): Route[] {
  const threshold = options.bondThreshold ?? DEFAULT_BOND_THRESHOLD;
  return [
    {
      method: "POST",
      pattern: "/x207/circles/{circle}/invoices",
      circleScoped: true,
      handler: async ({ db, circle, body, now }) => {
        const { notice, signature, raw } = readNotice(body, now);
        if (raw.document === null || typeof raw.document !== "object") throw invalidRequest("document wajib objek");
        const count = raw.installments;
        if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 || count > MAX_INSTALLMENTS) {
          throw new ApiError(400, "installment_count", `installments harus bilangan bulat 1 sampai ${MAX_INSTALLMENTS}`, {});
        }
        const doc = raw.document as InvoiceDocument;
        let hash: string;
        try {
          hash = invoiceHash(doc);
        } catch (error) {
          return asApiError(error);
        }
        if (notice.action !== "requested") throw invalidRequest("notice.action harus requested");
        if (notice.circle !== circle.contract_id) throw invalidRequest("notice.circle harus akun kontrak lingkaran", { expected: circle.contract_id, got: notice.circle });
        if (notice.invoice_hash !== hash) throw invalidRequest("notice.invoice_hash harus hash dokumen", { expected: hash });
        if (notice.actor !== doc.issuer) throw new ApiError(403, "invoice_not_party", "Hanya issuer yang mengajukan invoice", { actor: notice.actor });
        const issuerKey = activeMemberKey(db, circle.circle_id, doc.issuer);
        if (!verifyNoticeJson(serializeInvoiceNotice(notice), circle.contract_id, signature, issuerKey)) {
          throw new ApiError(401, "invalid_signature", "Tanda tangan notice tidak cocok dengan kunci voucher issuer", { account: doc.issuer });
        }
        activeMemberKey(db, circle.circle_id, doc.debtor);
        const open = await resolveOpenEpoch(db, circle);
        if (open === null) throw new ApiError(409, "epoch_not_open", "Tidak ada epoch open untuk menjadwalkan cicilan", {});
        let plan: InstallmentPlan;
        try {
          plan = planInstallments({ circle: circle.contract_id, doc, firstEpoch: open + 1, count });
        } catch (error) {
          return asApiError(error);
        }
        if (row(db, "SELECT 1 AS x FROM invoices WHERE circle_id = ? AND invoice_hash = ?", circle.circle_id, hash)) {
          throw new ApiError(409, "invoice_duplicate", "Invoice dengan hash ini sudah ada di lingkaran", { invoiceHash: hash });
        }
        db.transaction(() => {
          db.prepare(
            `INSERT INTO invoices (circle_id, invoice_hash, issuer, debtor, document_json, amount, installment_count, first_epoch, needs_bond, status, request_signature, created_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?)`,
          ).run(circle.circle_id, hash, doc.issuer, doc.debtor, serializeInvoice(doc), doc.amount, count, open + 1, BigInt(doc.amount) >= threshold ? 1 : 0, signature, now());
          for (const it of plan.installments) {
            db.prepare("INSERT INTO invoice_installments (circle_id, invoice_hash, idx, epoch, amount) VALUES (?, ?, ?, ?, ?)").run(circle.circle_id, hash, it.index, it.epoch, it.amount);
          }
        })();
        return { status: 201, body: { invoice_hash: hash, ...invoiceView(db, circle.circle_id, findInvoice(db, circle.circle_id, hash)) } };
      },
    },
    {
      method: "GET",
      pattern: "/x207/circles/{circle}/invoices",
      circleScoped: true,
      handler: ({ db, circle, query }) => {
        syncInvoices(db, circle.circle_id);
        const limit = parseLimit(query);
        const cursor = decodeCursor(query);
        const party = query.get("party");
        const status = query.get("status");
        if (party !== null && !ACCOUNT.test(party)) throw invalidRequest("party bukan account id", { party });
        if (status !== null && !(INVOICE_STATUSES as readonly string[]).includes(status)) throw invalidRequest("status tidak dikenal", { status });
        let after = Number.MAX_SAFE_INTEGER;
        if (cursor) {
          if (typeof cursor.a !== "number" || !Number.isSafeInteger(cursor.a)) throw invalidRequest("cursor tidak valid");
          after = cursor.a;
        }
        const list = rows<InvoiceRow>(
          db,
          `SELECT * FROM invoices WHERE circle_id = ? AND id < ? AND (? IS NULL OR issuer = ? OR debtor = ?) AND (? IS NULL OR status = ?) ORDER BY id DESC LIMIT ?`,
          circle.circle_id, after, party, party, party, status, status, limit + 1,
        );
        const page = list.slice(0, limit);
        const last = page[page.length - 1];
        return {
          status: 200,
          body: {
            unit: "credit", decimals: 6,
            items: page.map((i) => invoiceView(db, circle.circle_id, i)),
            nextCursor: list.length > limit && last ? encodeCursor({ a: Number(last.id) }) : null,
          },
        };
      },
    },
    {
      method: "GET",
      pattern: "/x207/circles/{circle}/invoices/{hash}",
      circleScoped: true,
      handler: ({ db, circle, params }) => {
        syncInvoices(db, circle.circle_id);
        return { status: 200, body: invoiceView(db, circle.circle_id, findInvoice(db, circle.circle_id, params.hash as string)) };
      },
    },
    {
      method: "POST",
      pattern: "/x207/circles/{circle}/invoices/{hash}/approve",
      circleScoped: true,
      handler: ({ db, circle, params, body }) => {
        syncInvoices(db, circle.circle_id);
        const inv = findInvoice(db, circle.circle_id, params.hash as string);
        if (inv.status !== "requested") throw new ApiError(409, "invoice_bad_state", `approve hanya dari requested, keadaan sekarang ${inv.status}`, { status: inv.status });
        const vouchers = (body as { vouchers?: unknown } | null)?.vouchers;
        if (!Array.isArray(vouchers)) throw invalidRequest("vouchers wajib array");
        if (vouchers.length !== Number(inv.installment_count)) {
          throw new ApiError(409, "installment_voucher_mismatch", `perlu tepat satu voucher per cicilan (${inv.installment_count}), dapat ${vouchers.length}`, {});
        }
        const plan = planOf(circle.contract_id, inv);
        const debtorKey = activeMemberKey(db, circle.circle_id, inv.debtor);
        const signed = plan.installments.map((it, i) => exactVoucher(vouchers[i] as VoucherInput, installmentVoucher(plan, it.index), debtorKey, `cicilan ${it.index}`));
        db.transaction(() => {
          plan.installments.forEach((it, i) => {
            const v = signed[i] as Voucher;
            db.prepare(
              `UPDATE invoice_installments SET v_epoch = ?, v_seq = ?, v_cumulative = ?, voucher_json = ?, signature = ?
               WHERE circle_id = ? AND invoice_hash = ? AND idx = ?`,
            ).run(v.epoch, v.seq, v.cumulativeAmount, JSON.stringify(installmentVoucher(plan, it.index)), v.signature, circle.circle_id, inv.invoice_hash, it.index);
          });
          db.prepare("UPDATE invoices SET status = 'approved', decided_at_ms = ? WHERE id = ?").run(Date.now(), inv.id);
        })();
        return { status: 200, body: invoiceView(db, circle.circle_id, findInvoice(db, circle.circle_id, inv.invoice_hash)) };
      },
    },
    {
      method: "POST",
      pattern: "/x207/circles/{circle}/invoices/{hash}/reject",
      circleScoped: true,
      handler: ({ db, circle, params, body, now }) => {
        syncInvoices(db, circle.circle_id);
        const inv = findInvoice(db, circle.circle_id, params.hash as string);
        const { notice, signature } = readNotice(body, now);
        if (notice.action !== "rejected") throw invalidRequest("notice.action harus rejected");
        if (notice.circle !== circle.contract_id) throw invalidRequest("notice.circle harus akun kontrak lingkaran", { expected: circle.contract_id, got: notice.circle });
        if (notice.invoice_hash !== inv.invoice_hash) throw invalidRequest("notice.invoice_hash harus hash invoice ini");
        if (notice.actor !== inv.debtor) throw new ApiError(403, "invoice_not_party", "Hanya debtor yang menolak invoice", { actor: notice.actor });
        if (!verifyNoticeJson(serializeInvoiceNotice(notice), circle.contract_id, signature, activeMemberKey(db, circle.circle_id, inv.debtor))) {
          throw new ApiError(401, "invalid_signature", "Tanda tangan notice tidak cocok dengan kunci voucher debtor", { account: inv.debtor });
        }
        if (inv.status !== "requested") throw new ApiError(409, "invoice_bad_state", `reject hanya dari requested, keadaan sekarang ${inv.status}`, { status: inv.status });
        db.prepare("UPDATE invoices SET status = 'rejected', reject_reason = ?, decided_at_ms = ? WHERE id = ?").run(notice.reason, now(), inv.id);
        return { status: 200, body: invoiceView(db, circle.circle_id, findInvoice(db, circle.circle_id, inv.invoice_hash)) };
      },
    },
    {
      method: "POST",
      pattern: "/x207/circles/{circle}/invoices/{hash}/installments/{index}/catch-up",
      circleScoped: true,
      handler: ({ db, circle, params, body }) => {
        syncInvoices(db, circle.circle_id);
        const inv = findInvoice(db, circle.circle_id, params.hash as string);
        if (!/^[1-9]\d*$/.test(params.index as string)) throw invalidRequest("index cicilan harus bilangan bulat >= 1", { index: params.index });
        const index = Number(params.index);
        if (inv.status !== "approved" && inv.status !== "missed") throw new ApiError(409, "invoice_bad_state", `catch-up hanya untuk invoice yang disetujui, keadaan sekarang ${inv.status}`, { status: inv.status });
        const it = installmentsOf(db, circle.circle_id, inv.invoice_hash).find((i) => Number(i.idx) === index);
        const plan = planOf(circle.contract_id, inv);
        let expected: UnsignedVoucher;
        try {
          if (!it) installmentVoucher(plan, index); // throws installment_not_found
          const failed = it !== undefined && it.status === "scheduled" && it.reason === "headroom";
          if (!failed && it !== undefined && it.shifted === 0n) {
            throw new InvoiceError("installment_bad_state", `cicilan ${index} belum gagal (status ${it.status}${it.reason ? `, ${it.reason}` : ""}): voucher susulan hanya sesudah gagal karena headroom`);
          }
          expected = catchUpVoucher(plan, index, pairState(db, circle.circle_id, Number(it?.epoch ?? 0) + 1, inv.debtor, inv.issuer), it?.shifted === 1n);
        } catch (error) {
          return asApiError(error);
        }
        const debtorKey = activeMemberKey(db, circle.circle_id, inv.debtor);
        const signed = exactVoucher(body as VoucherInput, expected, debtorKey, `cicilan ${index}`);
        if (epochClosed(db, circle.circle_id, expected.epoch)) throw new ApiError(409, "epoch_not_open", `Epoch ${expected.epoch} sudah ditutup: cicilan tidak bisa digeser`, { epoch: expected.epoch });
        db.prepare(
          `UPDATE invoice_installments SET status = 'shifted', reason = NULL, shifted = 1, v_epoch = ?, v_seq = ?, v_cumulative = ?, catch_up_json = ?, catch_up_signature = ?
           WHERE circle_id = ? AND invoice_hash = ? AND idx = ?`,
        ).run(expected.epoch, expected.seq, expected.cumulativeAmount, JSON.stringify(expected), signed.signature, circle.circle_id, inv.invoice_hash, index);
        return { status: 200, body: invoiceView(db, circle.circle_id, inv) };
      },
    },
  ];
}

