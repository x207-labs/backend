import { afterEach, describe, expect, it } from "vitest";
import { catchUpVoucher, invoiceHash } from "@x207/core";
import { acct, openEpoch, startMarket, type Market } from "./helpers.js";
import { approvalBody, chainVoucher, closeEpoch, doc, noticeFor, planOf, requestBody, signedNotice, signedVoucher } from "./invoice-helpers.js";

describe("BE-051 invoice book and installments", () => {
  let market: Market | undefined;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });
  async function start() {
    market = await startMarket(["andi", "budi", "citra"]);
    openEpoch(market, 42); // the first installment falls in epoch 43
    return market;
  }
  const create = async (m: Market, issuer: string, debtor: string, n: number, over = {}) => (await m.post("/invoices", requestBody(m, issuer, debtor, n, over)));
  const hashOf = (issuer: string, debtor: string, over = {}) => invoiceHash(doc(issuer, debtor, over));

  it("TC-BE-051-01 a request is stored as requested with the schedule of the SDK; the hash is unique per circle; a large invoice needs the bond", async () => {
    const m = await start();
    const res = await create(m, "andi", "budi", 3);
    expect(res.status).toBe(201);
    expect(res.json.invoice_hash).toBe(hashOf("andi", "budi"));
    expect(res.json).toMatchObject({ status: "requested", needsBond: false, unit: "credit", decimals: 6 });
    expect(res.json.installments).toEqual([
      { index: 1, epoch: 43, amount: "20000000", status: "scheduled", reason: null, voucherEpoch: null, shifted: false },
      { index: 2, epoch: 44, amount: "20000000", status: "scheduled", reason: null, voucherEpoch: null, shifted: false },
      { index: 3, epoch: 45, amount: "20000000", status: "scheduled", reason: null, voucherEpoch: null, shifted: false },
    ]);
    const dup = await create(m, "andi", "budi", 2);
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe("invoice_duplicate");
    expect((await create(m, "andi", "budi", 1, { id: "INV-2" })).status).toBe(201); // another document, another hash
    const big = await create(m, "andi", "citra", 1, { amount: "100000000" });
    expect(big.json.needsBond).toBe(true);
    expect((await create(m, "andi", "citra", 1, { id: "INV-3", amount: "99999999" })).json.needsBond).toBe(false);
    expect((await m.get(`/invoices/${res.json.invoice_hash}`)).json.invoiceHash).toBe(res.json.invoice_hash);
  });

  it("TC-BE-051-02 errors of InvoiceError are passed on as they are; the notice must come from the issuer", async () => {
    const m = await start();
    const bad = await create(m, "andi", "budi", 1, { amount: "0" });
    expect(bad).toMatchObject({ status: 400 });
    expect(bad.json.error.code).toBe("invoice_bad_amount");
    expect((await create(m, "andi", "budi", 25)).json.error.code).toBe("installment_count");
    expect((await create(m, "andi", "budi", 3, { amount: "2" })).json.error.code).toBe("installment_amount_too_small");
    expect((await create(m, "andi", "budi", 1, { debtor: acct("andi") })).json.error.code).toBe("invoice_same_party");
    const d = doc("andi", "budi");
    const asBudi = { document: d, installments: 1, ...signedNotice(m, noticeFor(d, "budi", "requested"), "budi") };
    expect((await m.post("/invoices", asBudi)).json.error.code).toBe("invoice_not_party");
    const forged = { document: d, installments: 1, ...signedNotice(m, noticeFor(d, "andi", "requested"), "citra") };
    expect((await m.post("/invoices", forged)).status).toBe(401);
    expect((await m.get(`/invoices/${"0".repeat(64)}`)).json.error.code).toBe("invoice_not_found");
  });

  it("TC-BE-051-03 approve takes exactly the vouchers of the plan, signed by the debtor, seq 1 per epoch; reject is the debtor's", async () => {
    const m = await start();
    const d = doc("andi", "budi");
    await create(m, "andi", "budi", 2);
    const h = hashOf("andi", "budi");
    const good = approvalBody(m, d, "budi", 43, 2);
    // a voucher that is not the one of the plan (cumulative changed) is a mismatch, whoever signed it
    const tampered = { vouchers: [{ ...good.vouchers[0]!, voucher: { ...good.vouchers[0]!.voucher, cumulativeAmount: "29999999" } }, good.vouchers[1]!] };
    expect((await m.post(`/invoices/${h}/approve`, tampered)).json.error.code).toBe("installment_voucher_mismatch");
    expect((await m.post(`/invoices/${h}/approve`, { vouchers: [good.vouchers[0]] })).json.error.code).toBe("installment_voucher_mismatch");
    const wrongKey = approvalBody(m, d, "citra", 43, 2);
    expect((await m.post(`/invoices/${h}/approve`, wrongKey)).status).toBe(401);
    const ok = await m.post(`/invoices/${h}/approve`, good);
    expect(ok.status).toBe(200);
    expect(ok.json.status).toBe("approved");
    expect((await m.post(`/invoices/${h}/approve`, good)).json.error.code).toBe("invoice_bad_state");
    const rej = await m.post(`/invoices/${h}/reject`, signedNotice(m, noticeFor(d, "budi", "rejected", "not ours"), "budi"));
    expect(rej.json.error.code).toBe("invoice_bad_state"); // already approved
  });

  it("TC-BE-051-04 the debtor can reject a request, the issuer cannot; a rejected invoice cannot be approved", async () => {
    const m = await start();
    const d = doc("andi", "budi");
    await create(m, "andi", "budi", 1);
    const h = hashOf("andi", "budi");
    const byIssuer = await m.post(`/invoices/${h}/reject`, signedNotice(m, noticeFor(d, "andi", "rejected"), "andi"));
    expect(byIssuer.json.error.code).toBe("invoice_not_party");
    const rej = await m.post(`/invoices/${h}/reject`, signedNotice(m, noticeFor(d, "budi", "rejected", "wrong amount"), "budi"));
    expect(rej.status).toBe(200);
    expect(rej.json).toMatchObject({ status: "rejected", rejectReason: "wrong amount" });
    expect((await m.post(`/invoices/${h}/approve`, approvalBody(m, d, "budi", 43, 1))).json.error.code).toBe("invoice_bad_state");
  });

  it("TC-BE-051-05 an installment is registered when the event of the chain has its (payer, payee, epoch, seq) and cumulative amount; all registered make the invoice registered", async () => {
    const m = await start();
    const d = doc("andi", "budi");
    await create(m, "andi", "budi", 2);
    const h = hashOf("andi", "budi");
    await m.post(`/invoices/${h}/approve`, approvalBody(m, d, "budi", 43, 2));
    chainVoucher(m, { payer: "budi", payee: "andi", epoch: 43, seq: 1, cumulative: "30000000" });
    let view = (await m.get(`/invoices/${h}`)).json;
    expect(view.status).toBe("approved");
    expect(view.installments.map((i: any) => i.status)).toEqual(["registered", "scheduled"]);
    chainVoucher(m, { payer: "budi", payee: "andi", epoch: 44, seq: 1, cumulative: "30000000" });
    view = (await m.get(`/invoices/${h}`)).json;
    expect(view.status).toBe("registered");
    expect((await m.get(`/invoices?party=${acct("budi")}&status=registered`)).json.items.map((i: any) => i.invoiceHash)).toEqual([h]);
    expect((await m.get(`/invoices?party=${acct("citra")}`)).json.items).toEqual([]);
    expect((await m.get(`/invoices?status=nope`)).status).toBe(400);
  });

  it("TC-BE-051-06 a failed installment (headroom) is shifted once by a catch-up voucher the debtor signs after the failure; failing again is missed", async () => {
    const m = await start();
    const d = doc("andi", "budi");
    await create(m, "andi", "budi", 2);
    const h = hashOf("andi", "budi");
    await m.post(`/invoices/${h}/approve`, approvalBody(m, d, "budi", 43, 2));
    const plan = planOf(d, 43, 2);
    const early = signedVoucher(m, catchUpVoucher(plan, 1, { seq: 0, cumulativeAmount: "0" }, false), "budi");
    expect((await m.post(`/invoices/${h}/installments/1/catch-up`, early)).json.error.code).toBe("installment_bad_state"); // nothing failed yet
    closeEpoch(m, 43); // epoch 43 over, nothing registered, nobody blocked: no headroom
    const failed = (await m.get(`/invoices/${h}`)).json;
    expect(failed.installments[0]).toMatchObject({ status: "scheduled", reason: "headroom" });
    // the debtor spent 5 in epoch 44 meanwhile, so the catch-up goes on top of that state
    chainVoucher(m, { payer: "budi", payee: "andi", epoch: 44, seq: 1, cumulative: "5000000" });
    const wrongState = signedVoucher(m, catchUpVoucher(plan, 1, { seq: 0, cumulativeAmount: "0" }, false), "budi");
    expect((await m.post(`/invoices/${h}/installments/1/catch-up`, wrongState)).json.error.code).toBe("installment_voucher_mismatch");
    const state = { seq: 1, cumulativeAmount: "5000000" };
    const shiftBody = signedVoucher(m, catchUpVoucher(plan, 1, state, false), "budi");
    const shifted = await m.post(`/invoices/${h}/installments/1/catch-up`, shiftBody);
    expect(shifted.status).toBe(200);
    expect(shifted.json.installments[0]).toMatchObject({ status: "shifted", reason: null, voucherEpoch: 44, shifted: true, epoch: 43 });
    // only once
    expect((await m.post(`/invoices/${h}/installments/1/catch-up`, shiftBody)).json.error.code).toBe("installment_already_shifted");
    // the issuer registers it in epoch 44 (seq 2, cumulative 5 + 30)
    chainVoucher(m, { payer: "budi", payee: "andi", epoch: 44, seq: 2, cumulative: "35000000" });
    expect((await m.get(`/invoices/${h}`)).json.installments[0].status).toBe("registered");
  });

  it("TC-BE-051-07 an installment that fails again after the shift is missed and the invoice with it", async () => {
    const m = await start();
    const d = doc("andi", "budi");
    await create(m, "andi", "budi", 1);
    const h = hashOf("andi", "budi");
    await m.post(`/invoices/${h}/approve`, approvalBody(m, d, "budi", 43, 1));
    closeEpoch(m, 43);
    const plan = planOf(d, 43, 1);
    await m.post(`/invoices/${h}/installments/1/catch-up`, signedVoucher(m, catchUpVoucher(plan, 1, { seq: 0, cumulativeAmount: "0" }, false), "budi"));
    closeEpoch(m, 44); // epoch 44 over and the catch-up voucher never got in
    const view = (await m.get(`/invoices/${h}`)).json;
    expect(view.installments[0]).toMatchObject({ status: "missed", reason: "headroom" });
    expect(view.status).toBe("missed");
  });

  it("TC-BE-051-08 a voucher of the debtor with a higher seq blocks the installment: missed with blocked_by_debtor, and the reputation of the debtor falls", async () => {
    const m = await start();
    const d = doc("andi", "budi");
    const d2 = doc("citra", "budi", { id: "INV-9" });
    await create(m, "andi", "budi", 1);
    await create(m, "citra", "budi", 1, { id: "INV-9" });
    const h = hashOf("andi", "budi");
    const h2 = hashOf("citra", "budi", { id: "INV-9" });
    await m.post(`/invoices/${h}/approve`, approvalBody(m, d, "budi", 43, 1));
    await m.post(`/invoices/${h2}/approve`, approvalBody(m, d2, "budi", 43, 1));
    chainVoucher(m, { payer: "budi", payee: "citra", epoch: 43, seq: 1, cumulative: "60000000" }); // paid in time
    chainVoucher(m, { payer: "budi", payee: "andi", epoch: 43, seq: 3, cumulative: "1000000" }); // the debtor got in first with seq 3
    closeEpoch(m, 43);
    const view = (await m.get(`/invoices/${h}`)).json;
    expect(view.installments[0]).toMatchObject({ status: "missed", reason: "blocked_by_debtor" });
    expect(view.status).toBe("missed");
    expect((await m.get(`/invoices/${h2}`)).json.status).toBe("registered");
    // no catch-up for a block: the same debtor could block again
    const plan = planOf(d, 43, 1);
    expect((await m.post(`/invoices/${h}/installments/1/catch-up`, signedVoucher(m, catchUpVoucher(plan, 1, { seq: 0, cumulativeAmount: "0" }, false), "budi"))).status).toBe(409);
    const rep = (await m.get(`/reputation/${acct("budi")}`)).json;
    expect(rep.invoices).toEqual({ registered: 1, missed: 1, blockedByDebtor: 1, missedIssuers: 1 });
    expect(rep.completionRate).toBe(0.5);
    expect(rep.score).toBe(Math.round((1000 * 1) / 2 / 6));
  });

  it("TC-BE-051-09 a request that nobody approved before the first epoch closed is expired", async () => {
    const m = await start();
    await create(m, "andi", "budi", 1);
    const h = hashOf("andi", "budi");
    closeEpoch(m, 43);
    expect((await m.get(`/invoices/${h}`)).json.status).toBe("expired");
    const d = doc("andi", "budi");
    expect((await m.post(`/invoices/${h}/approve`, approvalBody(m, d, "budi", 43, 1))).json.error.code).toBe("invoice_bad_state");
  });
});
