import { planInstallments, installmentVoucher, signVoucher, type InvoiceDocument, type UnsignedVoucher, invoiceHash } from "@x207/core";
import { serializeInvoiceNotice, type InvoiceNotice } from "../../src/marketplace/invoices.js";
import { signNoticeJson } from "../../src/marketplace/notice.js";
import { seedEpoch } from "../helpers/d9-fixtures.js";
import { acct, CIRCLE, CONTRACT, NOW_S, type Market } from "./helpers.js";

let receipt = 0;
/** What the indexer does for `voucher_registered`: the raw event and the obligation row (monotonic in `seq`). Creates the epoch row when missing. */
export function chainVoucher(m: Market, v: { payer: string; payee: string; epoch: number; seq: number; cumulative: string }): void {
  if (!m.db.prepare("SELECT 1 FROM epochs WHERE circle_id = ? AND epoch = ?").get(CIRCLE, v.epoch)) seedEpoch(m.db, { epoch: v.epoch, phase: "open" });
  m.db
    .prepare(
      `INSERT INTO events_raw (receipt_id, log_index, block_height, block_hash, block_timestamp_ns, tx_hash, contract_id, standard, version, event, data_json, handled)
       VALUES (?, 0, 1, 'h', 1, ?, ?, 'x207', '0.0.1', 'voucher_registered', ?, 1)`,
    )
    .run(`r${++receipt}`, `tx${receipt}`, CONTRACT, JSON.stringify([{ payer: acct(v.payer), payee: acct(v.payee), epoch: v.epoch, seq: v.seq, cumulative_amount: v.cumulative, delta: "0", obligation: v.cumulative, outstanding_debt: "0", mode: "cumulative" }]));
  const old = m.db.prepare("SELECT seq FROM obligations WHERE circle_id = ? AND epoch = ? AND debtor = ? AND creditor = ?").get(CIRCLE, v.epoch, acct(v.payer), acct(v.payee)) as { seq: number } | undefined;
  if (!old) m.db.prepare("INSERT INTO obligations (circle_id, epoch, debtor, creditor, seq, cumulative_amount, cleared, registration_mode, registered_block, receipt_id) VALUES (?, ?, ?, ?, ?, ?, NULL, 'cumulative', 1, 'r')").run(CIRCLE, v.epoch, acct(v.payer), acct(v.payee), v.seq, v.cumulative);
  else if (v.seq > old.seq) m.db.prepare("UPDATE obligations SET seq = ?, cumulative_amount = ? WHERE circle_id = ? AND epoch = ? AND debtor = ? AND creditor = ?").run(v.seq, v.cumulative, CIRCLE, v.epoch, acct(v.payer), acct(v.payee));
}

/** The epoch is over: its row is there and its phase left `open`. */
export function closeEpoch(m: Market, epoch: number): void {
  const row = m.db.prepare("SELECT 1 FROM epochs WHERE circle_id = ? AND epoch = ?").get(CIRCLE, epoch);
  if (row) m.db.prepare("UPDATE epochs SET phase = 'finalized' WHERE circle_id = ? AND epoch = ?").run(CIRCLE, epoch);
  else seedEpoch(m.db, { epoch, phase: "finalized" });
}

export const doc = (issuer: string, debtor: string, over: Partial<InvoiceDocument> = {}): InvoiceDocument => ({ id: "INV-1", issuer: acct(issuer), debtor: acct(debtor), amount: "60000000", memo: "web design", ...over });

/** The hash of the document, or zeros for a document the SDK refuses (the server must answer with the code of the SDK before it looks at the notice). */
const safeHash = (d: InvoiceDocument): string => {
  try {
    return invoiceHash(d);
  } catch {
    return "0".repeat(64);
  }
};

export const noticeFor = (d: InvoiceDocument, actor: string, action: "requested" | "rejected", reason: string | null = null, at = NOW_S): InvoiceNotice =>
  ({ circle: CONTRACT, invoice_hash: safeHash(d), actor: acct(actor), action, at, reason });

export const signedNotice = (m: Market, n: InvoiceNotice, signer: string) => ({ notice: n, signature: signNoticeJson(serializeInvoiceNotice(n), CONTRACT, m.keys[signer]!.secretKey) });

export const requestBody = (m: Market, issuer: string, debtor: string, installments: number, over: Partial<InvoiceDocument> = {}) => {
  const d = doc(issuer, debtor, over);
  return { document: d, installments, ...signedNotice(m, noticeFor(d, issuer, "requested"), issuer) };
};

/** The plan the backend computes; `firstEpoch` is the open epoch + 1. */
export const planOf = (d: InvoiceDocument, firstEpoch: number, count: number) => planInstallments({ circle: CONTRACT, doc: d, firstEpoch, count });

export const stripSig = (v: UnsignedVoucher): UnsignedVoucher => v;
export const approvalBody = (m: Market, d: InvoiceDocument, debtor: string, firstEpoch: number, count: number) => {
  const plan = planOf(d, firstEpoch, count);
  return { vouchers: plan.installments.map((i) => { const u = installmentVoucher(plan, i.index); return { voucher: u, signature: signVoucher(u, m.keys[debtor]!.secretKey).signature }; }) };
};
export const signedVoucher = (m: Market, u: UnsignedVoucher, signer: string) => ({ voucher: u, signature: signVoucher(u, m.keys[signer]!.secretKey).signature });
