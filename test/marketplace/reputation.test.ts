import { afterEach, describe, expect, it } from "vitest";
import { acct, CIRCLE, CONTRACT, NOW_S, openEpoch, startMarket, type Market } from "./helpers.js";
import { signSpotCheck, type SpotCheckNotice } from "../../src/marketplace/reputation.js";

const PAID = 90_000_000; // listing 100 credit, discount 10: what the seller must have registered

describe("BE-053 minimal reputation: paid deals only, one count per counterparty", () => {
  let market: Market | undefined;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });

  let n = 0;
  async function start(names = ["andi", "budi", "citra", "dewi", "eka", "fina"]) {
    market = await startMarket(names, ["gita"]);
    openEpoch(market, 42);
    return market;
  }

  /** A match of `seller` and `buyer`; the buyer registered `paid` for it (0: not at all). `delivery`: a row of BE-047. */
  function deal(m: Market, seller: string, buyer: string, o: { paid?: number; delivery?: { state: string; deliveredAfter?: number; cancelledBy?: string }; mode?: string; kind?: string; termsHash?: string } = {}) {
    const hash = (++n).toString(16).padStart(64, "0");
    const id = m.db
      .prepare(
        `INSERT INTO matches (circle_id, listing_hash, offer_hash, seller, counterparty, mode, kind, epoch, terms_hash, listing_value, discount_value, searcher_account, searcher_value, matched_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, 42, ?, '100000000', '10000000', NULL, '0', ?)`,
      )
      .run(CIRCLE, hash, hash, acct(seller), acct(buyer), o.mode ?? "pay", o.kind ?? "payment", o.termsHash ?? null, m.clock.now).lastInsertRowid;
    const paid = o.paid ?? PAID;
    if (paid > 0) {
      const existing = m.db.prepare("SELECT cumulative_amount AS c FROM obligations WHERE circle_id = ? AND epoch = 42 AND debtor = ? AND creditor = ?").get(CIRCLE, acct(buyer), acct(seller)) as { c: number } | undefined;
      if (existing) m.db.prepare("UPDATE obligations SET cumulative_amount = ? WHERE circle_id = ? AND epoch = 42 AND debtor = ? AND creditor = ?").run(Math.max(existing.c, paid), CIRCLE, acct(buyer), acct(seller));
      else m.db.prepare("INSERT INTO obligations (circle_id, epoch, debtor, creditor, seq, cumulative_amount, cleared, registration_mode, registered_block, receipt_id) VALUES (?, 42, ?, ?, 1, ?, NULL, 'cumulative', 1, 'r')").run(CIRCLE, acct(buyer), acct(seller), paid);
    }
    if (o.delivery) {
      const created = Math.floor(m.clock.now / 1000);
      m.db
        .prepare(
          `INSERT INTO deliveries (circle_id, listing_hash, side, offer_hash, match_id, deliverer, receiver, deliver_by, state, delivered_at, cancelled_by, created_at_ms)
           VALUES (?, ?, 'offer', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(CIRCLE, hash, hash, id, acct(seller), acct(buyer), created + 86_400, o.delivery.state, o.delivery.deliveredAfter === undefined ? null : created + o.delivery.deliveredAfter, o.delivery.cancelledBy ? acct(o.delivery.cancelledBy) : null, m.clock.now);
    }
    return Number(id);
  }
  const rep = async (m: Market, who: string) => (await m.get(`/reputation/${acct(who)}`)).json;

  it("TC-BE-053-01 two sellers with different histories get scores that follow the histories; the formula is in the answer", async () => {
    const m = await start();
    for (const buyer of ["budi", "citra", "dewi"]) deal(m, "andi", buyer);
    deal(m, "eka", "budi");
    const andi = await rep(m, "andi");
    const eka = await rep(m, "eka");
    expect(andi).toMatchObject({ account: acct("andi"), completed: { transactions: 3, counterparties: 3 }, completionRate: 1, basis: "paid deals only; one count per counterparty" });
    expect(andi.score).toBe(Math.round((1000 * 3) / 8)); // confidence 3/(3+5)
    expect(eka.score).toBe(Math.round(1000 / 6));
    expect(andi.score).toBeGreaterThan(eka.score);
    expect(andi.formula).toContain("distinct counterparties");
  });

  it("TC-BE-053-02 two accounts that trade with each other again and again do not raise the score: five deals with the same buyer count as one", async () => {
    const m = await start();
    deal(m, "andi", "budi");
    const once = (await rep(m, "andi")).score;
    for (let i = 0; i < 4; i++) deal(m, "andi", "budi");
    deal(m, "budi", "andi");
    const again = await rep(m, "andi");
    expect(again.completed).toEqual({ transactions: 5, counterparties: 1 });
    expect(again.score).toBe(once);
    // the other way round it is one more seller with one counterparty, no more: a ring of two accounts can lift each other to the score of one deal and no higher
    expect((await rep(m, "budi")).score).toBe(once);
  });

  it("TC-BE-053-03 a deal that was not paid, or paid less than the price, counts for nothing", async () => {
    const m = await start();
    deal(m, "andi", "budi", { paid: 0 });
    deal(m, "andi", "citra", { paid: PAID - 1 });
    const r = await rep(m, "andi");
    expect([r.completed.transactions, r.score, r.completionRate]).toEqual([0, 0, null]);
    deal(m, "andi", "dewi");
    expect((await rep(m, "andi")).completed.counterparties).toBe(1);
  });

  it("TC-BE-053-04 disputes lower the score, but only a dispute from an account that has itself paid somebody counts; abandoned deals count too", async () => {
    const m = await start();
    for (const buyer of ["budi", "citra", "dewi"]) deal(m, "andi", buyer);
    const base = (await rep(m, "andi")).score;
    // fina has never paid anybody: its dispute is ignored
    deal(m, "andi", "fina", { paid: 0, delivery: { state: "disputed", deliveredAfter: 60 } });
    expect((await rep(m, "andi")).disputes).toEqual({ transactions: 0, counterparties: 0 });
    expect((await rep(m, "andi")).score).toBe(base);
    // eka has paid citra, so its dispute counts
    deal(m, "citra", "eka");
    deal(m, "andi", "eka", { paid: 0, delivery: { state: "disputed", deliveredAfter: 60 } });
    const disputed = await rep(m, "andi");
    expect(disputed.disputes).toEqual({ transactions: 1, counterparties: 1 });
    expect(disputed.completionRate).toBe(0.75);
    expect(disputed.score).toBe(Math.round(1000 * 0.75 * (3 / 8)));
    deal(m, "andi", "gita", { paid: 0, delivery: { state: "cancelled", cancelledBy: "andi" } });
    expect((await rep(m, "andi")).abandoned).toEqual({ transactions: 1, counterparties: 1 });
  });

  it("TC-BE-053-05 response time is the median of the time from the match to the delivery, over paid and confirmed deliveries only", async () => {
    const m = await start();
    deal(m, "andi", "budi", { delivery: { state: "confirmed", deliveredAfter: 60 } });
    deal(m, "andi", "citra", { delivery: { state: "confirmed", deliveredAfter: 600 } });
    deal(m, "andi", "dewi", { delivery: { state: "confirmed", deliveredAfter: 3600 } });
    deal(m, "andi", "eka", { paid: 0, delivery: { state: "confirmed", deliveredAfter: 5 } }); // confirmed but unpaid: not counted
    const r = await rep(m, "andi");
    expect(r.responseSeconds).toEqual({ median: 600, samples: 3 });
    expect(r.completed.counterparties).toBe(3);
  });

  it("TC-BE-053-06 a barter deal gives a performance to both sides, and the bundle leg is what the receiver must have paid", async () => {
    const m = await start();
    const terms = { circle: CONTRACT, epoch: 42, legs: [{ payer: acct("andi"), payee: acct("budi"), max_amount: "107000000" }, { payer: acct("budi"), payee: acct("andi"), max_amount: "100000000" }] };
    m.db.prepare("INSERT INTO bundle_proposals (circle_id, terms_hash, match_id, epoch, terms_json, status, source, created_at_ms) VALUES (?, ?, NULL, 42, ?, 'ready', 'accept', 1)").run(CIRCLE, "ab".repeat(32), JSON.stringify(terms));
    deal(m, "andi", "budi", { mode: "barter", kind: "bundle", termsHash: "ab".repeat(32), paid: 0 });
    // budi paid 100 to andi (the leg budi -> andi), andi paid only 50 to budi (the leg andi -> budi is 107)
    m.db.prepare("INSERT INTO obligations (circle_id, epoch, debtor, creditor, seq, cumulative_amount, cleared, registration_mode, registered_block, receipt_id) VALUES (?, 42, ?, ?, 1, 100000000, NULL, 'cumulative', 1, 'r')").run(CIRCLE, acct("budi"), acct("andi"));
    m.db.prepare("INSERT INTO obligations (circle_id, epoch, debtor, creditor, seq, cumulative_amount, cleared, registration_mode, registered_block, receipt_id) VALUES (?, 42, ?, ?, 1, 50000000, NULL, 'cumulative', 1, 'r')").run(CIRCLE, acct("andi"), acct("budi"));
    expect((await rep(m, "andi")).completed).toEqual({ transactions: 1, counterparties: 1 });
    expect((await rep(m, "budi")).completed).toEqual({ transactions: 0, counterparties: 0 });
    m.db.prepare("UPDATE obligations SET cumulative_amount = 107000000 WHERE debtor = ? AND creditor = ?").run(acct("andi"), acct("budi"));
    expect((await rep(m, "budi")).completed).toEqual({ transactions: 1, counterparties: 1 });
  });

  const notice = (m: Market, over: Partial<SpotCheckNotice> = {}): SpotCheckNotice => ({
    circle: CONTRACT, subject: acct("andi"), verifier: acct("fina"), job_hash: "ab".repeat(32), passed: true, expected_hash: "cd".repeat(32), got_hash: "cd".repeat(32),
    at: Math.floor(m.clock.now / 1000), ...over,
  });
  const send = (m: Market, n: SpotCheckNotice, as = "fina") => m.post("/reputation/spot-checks", { notice: n, signature: signSpotCheck(n, m.keys[as]!.secretKey) });

  it("TC-BE-053-07 the result of a random check, signed by a verifier that is an active member, changes the score: a failed check lowers it, a passed one raises the factor", async () => {
    const m = await start();
    for (const buyer of ["budi", "citra", "dewi"]) deal(m, "andi", buyer);
    const base = (await rep(m, "andi")).score;
    const failed = await send(m, notice(m, { passed: false, got_hash: "ef".repeat(32) }));
    expect(failed.status).toBe(201);
    expect(failed.json.reputation.spotChecks).toEqual({ passed: 0, failed: 1, verifiers: 1 });
    expect(failed.json.reputation.score).toBe(Math.round(1000 * (3 / 8) * (1 / 4)));
    expect(failed.json.reputation.score).toBeLessThan(base);
    const ok = await send(m, notice(m, { job_hash: "12".repeat(32) }));
    expect(ok.json.reputation.spotChecks).toEqual({ passed: 1, failed: 1, verifiers: 1 });
    expect((await rep(m, "andi")).spotChecks.failed).toBe(1);
  });

  it("TC-BE-053-08 refusals of a random check: a second result for the same job, self-check, an inactive or unknown verifier, a wrong key, a stale time, a bad format", async () => {
    const m = await start();
    expect((await send(m, notice(m))).status).toBe(201);
    expect((await send(m, notice(m, { passed: false, got_hash: "ef".repeat(32) }))).json.error.code).toBe("already_exists");
    expect((await send(m, notice(m, { subject: acct("fina"), job_hash: "01".repeat(32) }))).status).toBe(400);
    expect((await send(m, notice(m, { verifier: acct("gita"), job_hash: "02".repeat(32) }), "fina")).json.error.code).toBe("member_not_active");
    expect((await send(m, notice(m, { verifier: acct("ghost"), job_hash: "03".repeat(32) }), "fina")).json.error.code).toBe("member_not_found");
    expect((await send(m, notice(m, { job_hash: "04".repeat(32) }), "eka")).json.error.code).toBe("invalid_signature");
    expect((await send(m, notice(m, { job_hash: "05".repeat(32), at: NOW_S - 7200 }))).status).toBe(400);
    expect((await send(m, notice(m, { subject: acct("ghost"), job_hash: "06".repeat(32) }))).json.error.code).toBe("member_not_found");
    expect((await m.post("/reputation/spot-checks", { notice: { ...notice(m, { job_hash: "07".repeat(32) }), passed: "yes" }, signature: "x" })).status).toBe(400);
    expect((await m.post("/reputation/spot-checks", { notice: notice(m, { job_hash: "08".repeat(32), passed: true, got_hash: "ee".repeat(32) }), signature: "x" })).status).toBe(400);
    expect((await m.post("/reputation/spot-checks", { notice: notice(m, { circle: "other.near", job_hash: "09".repeat(32) }), signature: "x" })).status).toBe(400);
    expect(m.db.prepare("SELECT COUNT(*) AS n FROM spot_checks").get()).toEqual({ n: 1 });
  });

  it("TC-BE-053-09 the read routes: one account, the list sorted by score, a stranger is 404, a member with no history has a score of 0", async () => {
    const m = await start();
    for (const buyer of ["budi", "citra"]) deal(m, "andi", buyer);
    deal(m, "eka", "budi");
    const list = await m.get("/reputation");
    expect(list.json.items.map((i: any) => i.account)).toEqual([acct("andi"), acct("eka")]);
    expect((await m.get(`/reputation/${acct("fina")}`)).json).toMatchObject({ score: 0, completionRate: null, memberStatus: "active" });
    expect((await m.get(`/reputation/${acct("ghost")}`)).json.error.code).toBe("member_not_found");
    expect((await m.get("/reputation/BAD NAME")).status).toBe(400);
    expect((await m.get("/reputation?limit=1")).json.items).toHaveLength(1);
  });
});
