import { afterEach, describe, expect, it } from "vitest";
import { orderHash, payForProofs, type OnchainProof } from "@x207/core";
import { acct, CONTRACT, NOW, openEpoch, startMarket, type Market } from "./helpers.js";
import { openOrder, orderDoc } from "./order-helpers.js";

describe("BE-055 on-chain proofs of keeper and solver orders", () => {
  let market: Market | undefined;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });
  async function start() {
    market = await startMarket(["andi", "budi", "citra"]);
    openEpoch(market, 42);
    return market;
  }
  let n = 0;
  /** What the indexer stores for an event with the caller of its transaction: the `data` of the NEP-297 log, an array with one object (`array: false` is the bare object of older code). */
  function call(m: Market, o: { event: string; data: Record<string, unknown>; signer: string | null; method?: string | null; ms?: number; tx?: string; array?: boolean }) {
    const id = ++n;
    m.db
      .prepare(
        `INSERT INTO events_raw (receipt_id, log_index, block_height, block_hash, block_timestamp_ns, tx_hash, signer_id, method_name, contract_id, standard, version, event, data_json, handled)
         VALUES (?, 0, ?, 'h', ?, ?, ?, ?, ?, 'x207', '0.0.1', ?, ?, 1)`,
      )
      .run(`rc${id}`, 1000 + id, BigInt(o.ms ?? m.clock.now + id * 1000) * 1_000_000n, o.tx ?? `tx${id}`, o.signer, o.method ?? null, CONTRACT, o.event, JSON.stringify(o.array === false ? o.data : [o.data]));
  }
  const keeperOrder = { kind: "keeper" as const, proof: { method: "close_epoch", amount_per_tx: "1000000" }, milestones: [{ amount: "5000000", due_at: Math.floor(NOW / 1000) + 86_400 }] };

  it("TC-BE-055-01 the calls of the provider that match the method show as proofs; calls of other accounts, other methods and earlier times do not", async () => {
    const m = await start();
    const hash = await openOrder(m, orderDoc("andi", "budi", keeperOrder));
    call(m, { event: "epoch_cutoff", data: { epoch: 42 }, signer: acct("budi"), tx: "keeper-1" });
    call(m, { event: "epoch_cutoff", data: { epoch: 43 }, signer: acct("citra"), tx: "other-keeper" }); // another account
    call(m, { event: "epoch_finalized", data: { epoch: 41 }, signer: acct("budi"), tx: "finalize" }); // another method
    call(m, { event: "epoch_cutoff", data: { epoch: 40 }, signer: acct("budi"), tx: "old", ms: NOW - 3_600_000 }); // before the order
    call(m, { event: "epoch_cutoff", data: { epoch: 44 }, signer: null, tx: "unknown-signer" }); // the source did not know who signed
    call(m, { event: "epoch_cutoff", data: { epoch: 45 }, signer: acct("budi"), tx: "keeper-2" });
    call(m, { event: "epoch_cutoff", data: { epoch: 45 }, signer: acct("budi"), tx: "keeper-2" }); // the same transaction again
    const res = await m.get(`/orders/${hash}/onchain-proofs`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ orderHash: hash, method: "close_epoch", seller: acct("budi"), amountPerTx: "1000000", maxProofs: 5 });
    expect(res.json.items.map((i: any) => [i.txHash, i.method, i.signer, i.epoch])).toEqual([
      ["keeper-1", "close_epoch", acct("budi"), 42],
      ["keeper-2", "close_epoch", acct("budi"), 45],
    ]);
  });

  it("TC-BE-055-02 solver proofs: the caller is the solver named by the event; the method of the transaction wins over the event when the source knew it", async () => {
    const m = await start();
    const hash = await openOrder(m, orderDoc("andi", "budi", { kind: "solver", proof: { method: "submit_clearing", amount_per_tx: "2000000" }, milestones: [{ amount: "6000000", due_at: Math.floor(NOW / 1000) + 86_400 }] }));
    call(m, { event: "clearing_submitted", data: { epoch: 42, solver: acct("budi") }, signer: null, tx: "sol-1" });
    call(m, { event: "clearing_submitted", data: { epoch: 42, solver: acct("citra") }, signer: null, tx: "sol-other" });
    call(m, { event: "clearing_submitted", data: { epoch: 43, solver: acct("budi") }, signer: acct("budi"), method: "some_wrapper", tx: "sol-wrapped" });
    expect((await m.get(`/orders/${hash}/onchain-proofs`)).json.items.map((i: any) => i.txHash)).toEqual(["sol-1"]);
  });

  it("TC-BE-055-03 the list feeds payForProofs of the SDK: one voucher per proof, a proof from another account is refused, none passes the budget", async () => {
    const m = await start();
    const doc = orderDoc("andi", "budi", keeperOrder);
    const hash = await openOrder(m, doc);
    for (let i = 1; i <= 6; i++) call(m, { event: "epoch_cutoff", data: { epoch: 50 + i }, signer: acct("budi"), tx: `k${i}` });
    const proofs: OnchainProof[] = (await m.get(`/orders/${hash}/onchain-proofs`)).json.items.map((i: any) => ({ txHash: i.txHash, method: i.method, signer: i.signer }));
    expect(proofs).toHaveLength(6);
    const out = payForProofs({ order: doc, epoch: 42, state: { seq: 0, cumulativeAmount: "0" }, proofs: [...proofs, { txHash: "stranger", method: "close_epoch", signer: acct("citra") }], alreadyPaid: [], alreadySpent: "0", secretKey: m.keys.andi!.secretKey });
    expect(out.paid).toEqual(["k1", "k2", "k3", "k4", "k5"]); // the budget of 5 is spent
    expect(out.refused).toEqual([{ txHash: "k6", reason: "over_budget" }, { txHash: "stranger", reason: "wrong_signer" }]);
    expect(out.vouchers.at(-1)).toMatchObject({ seq: 5, cumulativeAmount: "5000000" });
    expect(orderHash(doc)).toBe(hash);
  });

  it("TC-BE-055-04 an order that is not paid per proof has no proofs", async () => {
    const m = await start();
    const hash = await openOrder(m, orderDoc("andi", "budi"));
    const res = await m.get(`/orders/${hash}/onchain-proofs`);
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("order_not_proof_kind");
    expect((await m.get(`/orders/${"0".repeat(64)}/onchain-proofs`)).json.error.code).toBe("order_not_found");
  });

  it("TC-BE-055-05 the data of an event is an array on a real chain (found by the near-sandbox run): epoch and solver are read from both shapes", async () => {
    const m = await start();
    const hash = await openOrder(m, orderDoc("andi", "budi", { kind: "solver", proof: { method: "submit_clearing", amount_per_tx: "2000000" }, milestones: [{ amount: "6000000", due_at: Math.floor(NOW / 1000) + 86_400 }] }));
    call(m, { event: "clearing_submitted", data: { epoch: 7, solver: acct("budi") }, signer: null, tx: "array-shape" });
    call(m, { event: "clearing_submitted", data: { epoch: 8, solver: acct("budi") }, signer: null, tx: "bare-shape", array: false });
    expect((await m.get(`/orders/${hash}/onchain-proofs`)).json.items.map((i: any) => [i.txHash, i.signer, i.epoch])).toEqual([["array-shape", acct("budi"), 7], ["bare-shape", acct("budi"), 8]]);
  });
});
