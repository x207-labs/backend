import { afterEach, describe, expect, it } from "vitest";
import { block, eventLog, acct } from "../helpers/fx-log42.js";
import { fxServer } from "../helpers/fx-api.js";
import { rebuildReadModel } from "../../src/indexer/rebuild.js";

const V = "0.0.7";
const offered = (h: number, id: number) =>
  block(h, { logs: [eventLog("grant_offered", { grant_id: id, asset_type: "nft:ticket", grantor: acct("scraper"), class: "A", unit: "once", unit_price: "10000000", expires_at: "1795000000000000000" }, V)] });
const held = (h: number, id: number) => block(h, { logs: [eventLog("escrow_held", { grant_id: id, nft_contract: "nft.test.near", token_id: `t${id}` }, V)] });
const registered = (h: number, payer: string, seq: number, cumulative: string, debt: string) =>
  block(h, { logs: [eventLog("voucher_registered", { payer: acct(payer), payee: acct("scraper"), epoch: 42, seq, cumulative_amount: cumulative, delta: "10000000", obligation: cumulative, outstanding_debt: debt, mode: "cumulative" }, V)] });
const failed = (h: number, payer: string, reverted: boolean, step = "complete") =>
  block(h, { logs: [eventLog("escrow_failed", { grant_id: 1, step, epoch: 42, payer: acct(payer), payee: acct("scraper"), delta: reverted ? "10000000" : "0", reverted }, V)] });
const activated = (h: number) => block(h, { logs: [eventLog("grant_activated", { grant_id: 1, grantee: acct("gpu"), delivery_pubkey: null }, V)] });
const revoked = (h: number) => block(h, { logs: [eventLog("grant_revoked", { grant_id: 1, reason: "grantor" }, V)] });

describe("CT-075 escrow events in D9", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  async function server(extra: ReturnType<typeof block>[]) {
    const f = await fxServer(11, extra);
    close = f.close;
    return f;
  }
  const obligation = (f: Awaited<ReturnType<typeof server>>, payer: string) =>
    f.db.prepare("SELECT seq, cumulative_amount AS cumulative FROM obligations WHERE epoch = 42 AND debtor = ? AND creditor = ?").get(acct(payer), acct("scraper"));
  const debt = (f: Awaited<ReturnType<typeof server>>, who: string) =>
    (f.db.prepare("SELECT outstanding_debt AS d FROM members WHERE account_id = ?").get(acct(who)) as { d: number }).d;

  it("TC-CT-075-D9-01 a payment whose transfer failed leaves no obligation and no debt, and the escrow is held again", async () => {
    const f = await server([offered(1011, 1), held(1012, 1), registered(1013, "gpu", 1, "10000000", "10000000"), failed(1014, "gpu", true)]);
    const debtBefore = debt(f, "gpu");
    expect(obligation(f, "gpu")).toBeUndefined();
    expect(debtBefore).toBe(0);
    expect(f.db.prepare("SELECT state FROM escrows").all()).toEqual([{ state: "held" }]);
    const res = await fetch(`${f.srv.url}/x207/circles/agents-main/grants/1`);
    expect(((await res.json()) as { escrow: unknown }).escrow).toEqual({ kind: "nft", nftContract: "nft.test.near", tokenId: "t1", state: "held" });
    expect(f.db.prepare("SELECT event, handled FROM events_raw WHERE event LIKE 'escrow_%' ORDER BY event").all()).toEqual([{ event: "escrow_failed", handled: 1 }, { event: "escrow_held", handled: 1 }]);
  });

  it("TC-CT-075-D9-02 an earlier payment of the same pair comes back as it was (seq, cumulative, debt)", async () => {
    const f = await server([
      offered(1011, 1), held(1012, 1), registered(1013, "gpu", 1, "4000000", "4000000"), registered(1014, "gpu", 2, "14000000", "14000000"), failed(1015, "gpu", true),
    ]);
    expect(obligation(f, "gpu")).toEqual({ seq: 1, cumulative: 4_000_000 });
    expect(debt(f, "gpu")).toBe(4_000_000);
  });

  it("TC-CT-075-D9-03 a delivered escrow stays delivered with the obligation; a cancelled one is cancelled", async () => {
    const delivered = await server([offered(1011, 1), held(1012, 1), registered(1013, "gpu", 1, "10000000", "10000000"), activated(1014)]);
    expect(obligation(delivered, "gpu")).toEqual({ seq: 1, cumulative: 10_000_000 });
    expect(delivered.db.prepare("SELECT state FROM escrows").all()).toEqual([{ state: "delivered" }]);
    await close?.();
    const cancelled = await server([offered(1011, 1), held(1012, 1), revoked(1013)]);
    expect(cancelled.db.prepare("SELECT state FROM escrows").all()).toEqual([{ state: "cancelled" }]);
  });

  it("TC-CT-075-D9-04 not reverted means the contract kept the payment: the escrow is stuck and the obligation stays; a failed cancel changes nothing", async () => {
    const f = await server([offered(1011, 1), held(1012, 1), registered(1013, "gpu", 1, "10000000", "10000000"), failed(1014, "gpu", false)]);
    expect(obligation(f, "gpu")).toEqual({ seq: 1, cumulative: 10_000_000 });
    expect(f.db.prepare("SELECT state FROM escrows").all()).toEqual([{ state: "stuck" }]);
    await close?.();
    const c = await server([offered(1011, 1), held(1012, 1), failed(1013, "scraper", false, "cancel")]);
    expect(c.db.prepare("SELECT state FROM escrows").all()).toEqual([{ state: "held" }]);
  });

  it("TC-CT-075-D9-05 a rebuild of the read model gives the same rows", async () => {
    const f = await server([offered(1011, 1), held(1012, 1), registered(1013, "gpu", 1, "4000000", "4000000"), registered(1014, "gpu", 2, "14000000", "14000000"), failed(1015, "gpu", true)]);
    const snapshot = () => ({ o: f.db.prepare("SELECT * FROM obligations ORDER BY debtor").all(), m: f.db.prepare("SELECT account_id, outstanding_debt FROM members ORDER BY account_id").all(), e: f.db.prepare("SELECT * FROM escrows").all() });
    const before = snapshot();
    rebuildReadModel(f.db, "agents-main");
    expect(snapshot()).toEqual(before);
  });
});
