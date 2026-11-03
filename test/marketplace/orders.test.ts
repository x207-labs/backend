import { afterEach, describe, expect, it } from "vitest";
import { orderHash } from "@x207/core";
import { acct, openEpoch, startMarket, type Market } from "./helpers.js";
import { chainVoucher } from "./invoice-helpers.js";
import { H, mnotice, openOrder, orderDoc, sendMilestone, sendOutcome, signOrder } from "./order-helpers.js";
import type { Transport } from "../../src/marketplace/ssrf.js";

const DAY = 86_400;

describe("BE-054 service order book", () => {
  let market: Market | undefined;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });
  async function start(routeOptions: Parameters<typeof startMarket>[3] = {}) {
    market = await startMarket(["andi", "budi", "citra"], [], undefined, routeOptions);
    openEpoch(market, 42);
    return market;
  }
  const now = (m: Market) => Math.floor(m.clock.now / 1000);

  it("TC-BE-054-01 an order needs both signatures: one makes it proposed, the second opens it; errors of the SDK keep their code", async () => {
    const m = await start();
    const doc = orderDoc("andi", "budi");
    const hash = orderHash(doc);
    const first = await m.post("/orders", { order: doc, signatures: [signOrder(m, doc, "andi")] });
    expect(first.status).toBe(201);
    expect(first.json).toMatchObject({ order_hash: hash, status: "proposed", signedBy: [acct("andi")], needsBond: false, budget: "30000000", unit: "credit", decimals: 6 });
    expect(first.json.milestones.map((x: any) => [x.index, x.status])).toEqual([[1, "open"], [2, "open"]]);
    // a proposed order cannot move
    expect((await sendMilestone(m, hash, mnotice(hash, 1, "budi", "delivered", now(m)))).json.error.code).toBe("order_bad_state");
    expect((await m.post("/orders", { order: doc, signatures: [signOrder(m, doc, "andi")] })).json.error.code).toBe("order_duplicate");
    const second = await m.post("/orders", { order: doc, signatures: [signOrder(m, doc, "budi")] });
    expect(second.status).toBe(200);
    expect(second.json.status).toBe("open");
    expect((await m.get(`/orders/${hash}`)).json.status).toBe("open");
    // wrong key, a stranger, and an order of the SDK that is not valid
    const doc2 = orderDoc("andi", "budi", { nonce: "n2" });
    expect((await m.post("/orders", { order: doc2, signatures: [{ account: acct("andi"), signature: signOrder(m, doc2, "citra").signature }] })).status).toBe(401);
    expect((await m.post("/orders", { order: doc2, signatures: [signOrder(m, doc2, "citra")] })).json.error.code).toBe("order_not_party");
    expect((await m.post("/orders", { order: orderDoc("andi", "budi", { kind: "prompt" }), signatures: [signOrder(m, doc, "andi")] })).json.error.code).toBe("sample_required");
    expect((await m.post("/orders", { order: orderDoc("andi", "budi", { kind: "loadtest" }), signatures: [signOrder(m, doc, "andi")] })).json.error.code).toBe("target_required");
    expect((await m.post("/orders", { order: orderDoc("andi", "budi", { kind: "nope" as any }), signatures: [signOrder(m, doc, "andi")] })).json.error.code).toBe("order_bad_kind");
    const big = orderDoc("andi", "budi", { nonce: "n3", milestones: [{ amount: "100000000", due_at: now(m) + DAY }] });
    expect((await m.post("/orders", { order: big, signatures: [signOrder(m, big, "andi")] })).json.needsBond).toBe(true);
    expect((await m.get(`/orders?party=${acct("budi")}&status=open`)).json.items.map((o: any) => o.orderHash)).toEqual([hash]);
  });

  it("TC-BE-054-02 two milestones are confirmed and paid, a third is disputed and is not paid", async () => {
    const m = await start();
    const doc = orderDoc("andi", "budi", { nonce: "n9", milestones: [10, 20, 30].map((c, i) => ({ amount: `${c}000000`, due_at: now(m) + (i + 1) * DAY })) });
    const hash = await openOrder(m, doc);
    // milestone 1: delivered by the seller (budi), confirmed by the buyer (andi)
    expect((await sendMilestone(m, hash, mnotice(hash, 1, "andi", "delivered", now(m)))).json.error.code).toBe("order_not_party"); // the buyer cannot deliver
    expect((await sendMilestone(m, hash, mnotice(hash, 1, "budi", "delivered", now(m)))).status).toBe(201);
    expect((await sendMilestone(m, hash, mnotice(hash, 1, "budi", "confirmed", now(m)))).json.error.code).toBe("order_not_party"); // nor can the seller confirm
    expect((await sendMilestone(m, hash, mnotice(hash, 1, "andi", "confirmed", now(m)))).json.milestones[0].status).toBe("confirmed");
    // milestone 2 delivered, and the buyer says nothing: the window closes and time confirms it
    await sendMilestone(m, hash, mnotice(hash, 2, "budi", "delivered", now(m)));
    // milestone 3 delivered and disputed inside the window
    await sendMilestone(m, hash, mnotice(hash, 3, "budi", "delivered", now(m)));
    const disputed = await sendMilestone(m, hash, mnotice(hash, 3, "andi", "disputed", now(m)));
    expect(disputed.json.milestones[2]).toMatchObject({ status: "disputed", disputeReason: "not_as_described" });
    m.clock.now += 73 * 3600 * 1000;
    const after = (await m.get(`/orders/${hash}`)).json;
    expect(after.milestones.map((x: any) => x.status)).toEqual(["confirmed", "confirmed", "disputed"]);
    expect(after.milestones[1].autoConfirmed).toBe(true);
    expect(after.status).toBe("closed");
    // the buyer registers a voucher for the two confirmed milestones (10 + 20): they are paid, the disputed one never is
    chainVoucher(m, { payer: "andi", payee: "budi", epoch: 42, seq: 1, cumulative: "30000000" });
    const paid = (await m.get(`/orders/${hash}`)).json;
    expect(paid.milestones.map((x: any) => x.status)).toEqual(["paid", "paid", "disputed"]);
  });

  it("TC-BE-054-03 a dispute after the window is refused; the buyer cancels an open milestone only after its due date", async () => {
    const m = await start();
    const doc = orderDoc("andi", "budi", { nonce: "n8" });
    const hash = await openOrder(m, doc);
    await sendMilestone(m, hash, mnotice(hash, 1, "budi", "delivered", now(m)));
    expect((await sendMilestone(m, hash, mnotice(hash, 2, "andi", "cancelled", now(m)))).json.error.code).toBe("order_bad_state"); // due date not passed
    expect((await sendMilestone(m, hash, mnotice(hash, 9, "andi", "cancelled", now(m)))).json.error.code).toBe("milestone_not_found");
    m.clock.now += 80 * 3600 * 1000;
    // the window ended at +72h: the milestone is confirmed by time and a dispute comes too late
    const r = await sendMilestone(m, hash, mnotice(hash, 1, "andi", "disputed", now(m)));
    expect(r.json.error.code).toBe("order_bad_state");
    expect((await sendMilestone(m, hash, mnotice(hash, 2, "andi", "cancelled", now(m)))).json.milestones[1].status).toBe("cancelled");
  });

  it("TC-BE-054-04 pay per result: lead and bug are paid only for results the buyer accepted; silence never pays", async () => {
    const m = await start();
    const doc = orderDoc("andi", "budi", { kind: "lead", nonce: "L1", milestones: [{ amount: "5000000", due_at: now(m) + DAY }, { amount: "5000000", due_at: now(m) + 2 * DAY }, { amount: "5000000", due_at: now(m) + 3 * DAY }] });
    const hash = await openOrder(m, doc);
    expect((await sendMilestone(m, hash, mnotice(hash, 1, "budi", "delivered", now(m)))).json.error.code).toBe("order_bad_state"); // outcome orders use /outcomes
    expect((await sendOutcome(m, hash, mnotice(hash, 1, "budi", "proposed", now(m), { deliverable_hash: H("1") }))).status).toBe(201);
    expect((await sendOutcome(m, hash, mnotice(hash, 2, "budi", "proposed", now(m), { deliverable_hash: H("1") }))).json.error.code).toBe("order_bad_state"); // the same result twice
    await sendOutcome(m, hash, mnotice(hash, 2, "budi", "proposed", now(m), { deliverable_hash: H("2") }));
    await sendOutcome(m, hash, mnotice(hash, 3, "budi", "proposed", now(m), { deliverable_hash: H("3") }));
    expect((await sendOutcome(m, hash, mnotice(hash, 1, "budi", "accepted", now(m)))).json.error.code).toBe("order_not_party");
    const acc = await sendOutcome(m, hash, mnotice(hash, 1, "andi", "accepted", now(m)));
    expect(acc.json.milestones[0]).toMatchObject({ status: "confirmed", outcome: "accepted" });
    const rej = await sendOutcome(m, hash, mnotice(hash, 2, "andi", "rejected", now(m), { reason: "duplicate lead" }));
    expect(rej.json.milestones[1]).toMatchObject({ status: "disputed", outcome: "rejected", disputeReason: "duplicate lead" });
    m.clock.now += 400 * 3600 * 1000; // the third one is left alone for a long time
    expect((await m.get(`/orders/${hash}`)).json.milestones.map((x: any) => x.status)).toEqual(["confirmed", "disputed", "delivered"]);
    chainVoucher(m, { payer: "andi", payee: "budi", epoch: 42, seq: 1, cumulative: "5000000" });
    expect((await m.get(`/orders/${hash}`)).json.milestones.map((x: any) => x.status)).toEqual(["paid", "disputed", "delivered"]);
    // a milestone order does not take outcomes
    const plain = await openOrder(m, orderDoc("andi", "budi", { nonce: "P1" }));
    expect((await sendOutcome(m, plain, mnotice(plain, 1, "budi", "proposed", now(m)))).json.error.code).toBe("order_bad_state");
  });
});

describe("BE-054 load test target: proof of ownership behind the SSRF guard", () => {
  let market: Market | undefined;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });
  const now = (m: Market) => Math.floor(m.clock.now / 1000);

  async function start(targetCheck: NonNullable<Parameters<typeof startMarket>[3]>["targetCheck"]) {
    market = await startMarket(["andi", "budi"], [], undefined, { targetCheck });
    openEpoch(market, 42);
    const doc = orderDoc("andi", "budi", { kind: "loadtest", target: "shop.example.com", nonce: "T1" });
    return { m: market, hash: await openOrder(market, doc) };
  }
  const serves = (body: string, status = 200): Transport => async () => ({ status, body: Buffer.from(body), truncated: false });
  const pub = async () => ["93.184.216.34"];
  const noTxt = async (): Promise<string[][]> => {
    throw new Error("ENODATA");
  };

  it("TC-BE-054-05 a load test order without proof of the target cannot be delivered; the file with the order hash proves it", async () => {
    const { m, hash } = await start({ resolver: pub, transport: serves("wrong"), txt: noTxt });
    expect((await m.get(`/orders/${hash}`)).json.targetVerified).toBe(false);
    const blocked = await sendMilestone(m, hash, mnotice(hash, 1, "budi", "delivered", now(m)));
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.code).toBe("target_unverified");
    const miss = await m.post(`/orders/${hash}/target-check`, {});
    expect(miss.json).toMatchObject({ target_verified: false, checked_via: null });
  });

  it("TC-BE-054-06 the file proves ownership; so does a DNS TXT record; then the seller can deliver", async () => {
    const seen: string[] = [];
    // the order hash is the same for every test (fixed document), so the file can be prepared before the server starts
    const expected = orderHash(orderDoc("andi", "budi", { kind: "loadtest", target: "shop.example.com", nonce: "T1" }));
    const { m, hash } = await start({ resolver: pub, transport: async (a) => { seen.push(`${a.host}${a.path}`); return { status: 200, body: Buffer.from(`${expected}\n`), truncated: false }; }, txt: noTxt });
    expect(hash).toBe(expected);
    const ok = await m.post(`/orders/${hash}/target-check`, {});
    expect(ok.json).toMatchObject({ target_verified: true, checked_via: "well-known" });
    expect(seen).toEqual(["shop.example.com/.well-known/x207-loadtest"]);
    expect((await sendMilestone(m, hash, mnotice(hash, 1, "budi", "delivered", now(m)))).status).toBe(201);
    await market?.srv.close();
    // the TXT record carries the hash of the order, split in two strings as DNS may do
    const viaDns = await start({ resolver: pub, transport: serves("nope", 404), txt: async () => [[`x207-loadtest=${expected.slice(0, 20)}`, expected.slice(20)]] });
    expect((await viaDns.m.post(`/orders/${expected}/target-check`, {})).json).toMatchObject({ target_verified: true, checked_via: "dns" });
  });

  it("TC-BE-054-07 a target that resolves to a private address is refused with target_forbidden, even if its TXT record would verify", async () => {
    for (const bad of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "192.168.1.9", "::1", "fd00::1"]) {
      const { m, hash } = await start({ resolver: async () => [bad], transport: serves("never reached"), txt: async () => { throw new Error("must not be asked"); } });
      const res = await m.post(`/orders/${hash}/target-check`, {});
      expect(res.status, bad).toBe(403);
      expect(res.json.error.code, bad).toBe("target_forbidden");
      expect((await m.get(`/orders/${hash}`)).json.targetVerified).toBe(false);
      await market?.srv.close();
    }
  });

  it("TC-BE-054-08 a redirect or an oversize answer is target_forbidden, a closed host is just not verified, and only loadtest orders have a check", async () => {
    const redirect = await start({ resolver: pub, transport: serves("", 301), txt: noTxt });
    expect((await redirect.m.post(`/orders/${redirect.hash}/target-check`, {})).json.error.code).toBe("target_forbidden");
    await market?.srv.close();
    const big = await start({ resolver: pub, transport: async () => ({ status: 200, body: Buffer.alloc(10), truncated: true }), txt: noTxt });
    expect((await big.m.post(`/orders/${big.hash}/target-check`, {})).json.error.code).toBe("target_forbidden");
    await market?.srv.close();
    const down = await start({ resolver: pub, transport: async () => { throw new Error("ECONNREFUSED"); }, txt: noTxt });
    expect((await down.m.post(`/orders/${down.hash}/target-check`, {})).json).toMatchObject({ target_verified: false });
    const research = await openOrder(down.m, orderDoc("andi", "budi", { nonce: "R2" }));
    expect((await down.m.post(`/orders/${research}/target-check`, {})).json.error.code).toBe("order_bad_state");
  });
});
