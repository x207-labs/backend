import { afterEach, describe, expect, it } from "vitest";
import { acceptOffer, listingHash, signBundle } from "@x207/core";
import { deliveryNoticeHash, signDeliveryNotice, type DeliveryAction, type DeliveryNotice } from "../../src/marketplace/delivery-core.js";
import { acct, bid, CONTRACT, openEpoch, signedListing, startMarket, type Market } from "./helpers.js";

const C = (n: number): string => (BigInt(n) * 1_000_000n).toString();
const PROOF = "ab".repeat(32);

describe("BE-047 delivery of an off-chain asset: confirm, dispute, cancel, and the payment waits", () => {
  let market: Market | undefined;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });

  /** andi lists a class C asset (a one-time code), budi bids in `pay` mode and andi accepts. */
  async function matched(over: { offerClass?: "A" | "B" | "C" | "D"; mode?: "pay" | "barter" } = {}) {
    market = await startMarket(["andi", "budi", "citra"]);
    const m = market;
    openEpoch(m);
    const body = signedListing(m, "andi", { offer: { asset_type: "gift-card-code", asset_class: over.offerClass ?? "C", quantity: 1, value: C(100) } });
    const hash = listingHash(body.listing);
    await m.post("/listings", body);
    const first = bid(m, "budi", body.listing, { mode: over.mode ?? "pay", value: C(100) });
    const posted = await m.post(`/listings/${hash}/offers`, first);
    const accepted = await m.post(`/listings/${hash}/offers/${posted.json.offerHash}/accept`, { account: acct("andi") });
    return { m, l: body.listing, hash, offer: first.offer, offerHash: posted.json.offerHash as string, accepted };
  }

  const notice = (hash: string, offerHashHex: string, actor: string, action: DeliveryAction, at: number, over: Partial<DeliveryNotice> = {}): DeliveryNotice => ({
    circle: CONTRACT, listing_hash: hash, offer_hash: offerHashHex, actor: acct(actor), action, at,
    proof_hash: action === "delivered" ? PROOF : null, reason: action === "disputed" ? "not_as_described" : null, ...over,
  });
  const send = (m: Market, hash: string, n: DeliveryNotice, as: string = n.actor.split(".")[0]!) => m.post(`/listings/${hash}/delivery`, { notice: n, signature: signDeliveryNotice(n, m.keys[as]!.secretKey) });

  it("TC-BE-047-01 a class C match starts in awaiting and says the payment is not payable; class A and D do not wait", async () => {
    const { m, hash, accepted, offerHash: oh } = await matched();
    expect(accepted.json.result).toMatchObject({ kind: "payment", payer: acct("budi"), payee: acct("andi"), delivery: { required: true, payable: false, state: "awaiting" } });
    const d = await m.get(`/listings/${hash}/delivery`);
    expect(d.json).toMatchObject({ state: "awaiting", payable: false, deliverer: acct("andi"), receiver: acct("budi"), offerHash: oh, notices: [] });
    await market?.srv.close();
    for (const offerClass of ["A", "D"] as const) {
      const a = await matched({ offerClass });
      expect(a.accepted.json.result.delivery).toBeUndefined();
      expect((await a.m.get(`/listings/${a.hash}/delivery`)).json.error.code).toBe("delivery_not_found");
      await market?.srv.close();
    }
  });

  it("TC-BE-047-02 delivered with a proof, then the buyer confirms: payable, and the notices are kept with their signatures", async () => {
    const { m, hash, offerHash: oh } = await matched();
    const nowS = Math.floor(m.clock.now / 1000);
    const sent = await send(m, hash, notice(hash, oh, "andi", "delivered", nowS));
    expect(sent.status).toBe(201);
    expect(sent.json).toMatchObject({ state: "delivered", payable: false, proofHash: PROOF });
    expect(sent.json.confirmBy).toBe(new Date((nowS + 72 * 3600) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"));
    const done = await send(m, hash, notice(hash, oh, "budi", "confirmed", nowS + 60));
    expect(done.status).toBe(201);
    expect(done.json).toMatchObject({ state: "confirmed", payable: true });
    expect(done.json.notices.map((n: any) => [n.actor, n.action])).toEqual([[acct("andi"), "delivered"], [acct("budi"), "confirmed"]]);
    expect(done.json.notices[1].noticeHash).toBe(deliveryNoticeHash(notice(hash, oh, "budi", "confirmed", nowS + 60)));
    // a confirmed delivery takes no more notices
    expect((await send(m, hash, notice(hash, oh, "budi", "disputed", nowS + 70))).json.error.code).toBe("delivery_state");
    expect((await send(m, hash, notice(hash, oh, "andi", "cancelled", nowS + 70))).json.error.code).toBe("delivery_state");
  });

  it("TC-BE-047-03 who may send what, a bad signature, a stale time, a replay and a notice for another match", async () => {
    const { m, hash, offerHash: oh } = await matched();
    const nowS = Math.floor(m.clock.now / 1000);
    // the buyer cannot say delivered, the seller cannot confirm, a third member is not a party
    expect((await send(m, hash, notice(hash, oh, "budi", "delivered", nowS))).json.error.code).toBe("not_a_party");
    await send(m, hash, notice(hash, oh, "andi", "delivered", nowS));
    expect((await send(m, hash, notice(hash, oh, "andi", "confirmed", nowS))).json.error.code).toBe("not_a_party");
    expect((await send(m, hash, notice(hash, oh, "citra", "confirmed", nowS))).json.error.code).toBe("not_a_party");
    // somebody signs for budi with another key
    const forged = notice(hash, oh, "budi", "confirmed", nowS);
    expect((await send(m, hash, forged, "citra")).json.error.code).toBe("invalid_signature");
    // the time of the notice must be close to the clock of the server (no notice signed in advance)
    expect((await send(m, hash, notice(hash, oh, "budi", "confirmed", nowS + 3600))).status).toBe(400);
    expect((await send(m, hash, notice(hash, oh, "budi", "confirmed", nowS - 3600))).status).toBe(400);
    // a notice that names another listing or offer
    expect((await send(m, hash, notice(hash, "c".repeat(64), "budi", "confirmed", nowS))).status).toBe(400);
    expect((await send(m, "f".repeat(64), notice("f".repeat(64), oh, "budi", "confirmed", nowS))).json.error.code).toBe("listing_not_found");
    // nothing above changed the state; the right notice works once
    expect((await m.get(`/listings/${hash}/delivery`)).json.state).toBe("delivered");
    expect((await send(m, hash, notice(hash, oh, "budi", "confirmed", nowS))).status).toBe(201);
    expect((await send(m, hash, notice(hash, oh, "budi", "confirmed", nowS))).status).toBe(409);
  });

  it("TC-BE-047-04 a dispute inside the window closes the way to payment; after the window it is refused; a dispute needs a known reason", async () => {
    const { m, hash, offerHash: oh } = await matched();
    const nowS = Math.floor(m.clock.now / 1000);
    await send(m, hash, notice(hash, oh, "andi", "delivered", nowS));
    // a reason outside the list is refused before the signature is looked at (the client cannot even sign it)
    expect((await m.post(`/listings/${hash}/delivery`, { notice: notice(hash, oh, "budi", "disputed", nowS + 30, { reason: "because" as never }), signature: "ed25519:x" })).status).toBe(400);
    const d = await send(m, hash, notice(hash, oh, "budi", "disputed", nowS + 30, { reason: "not_received" }));
    expect(d.json).toMatchObject({ state: "disputed", payable: false, disputeReason: "not_received" });
    expect((await send(m, hash, notice(hash, oh, "budi", "confirmed", nowS + 40))).json.error.code).toBe("delivery_state");
    expect((await m.get(`/listings/${hash}/delivery`)).json.payable).toBe(false);
  });

  it("TC-BE-047-05 a dispute after the window is refused, a late confirmation is still accepted", async () => {
    const { m, hash, offerHash: oh } = await matched();
    const nowS = Math.floor(m.clock.now / 1000);
    await send(m, hash, notice(hash, oh, "andi", "delivered", nowS));
    m.clock.now += (72 * 3600 + 120) * 1000;
    const later = Math.floor(m.clock.now / 1000);
    const late = await send(m, hash, notice(hash, oh, "budi", "disputed", later));
    expect([late.status, late.json.error.code]).toEqual([409, "delivery_state"]);
    expect((await send(m, hash, notice(hash, oh, "budi", "confirmed", later))).json).toMatchObject({ state: "confirmed", payable: true });
  });

  it("TC-BE-047-06 cancel: the seller until the buyer confirms; the buyer only when nothing came by deliver_by", async () => {
    const { m, hash, offerHash: oh, offer } = await matched();
    const nowS = Math.floor(m.clock.now / 1000);
    expect((await send(m, hash, notice(hash, oh, "budi", "cancelled", nowS))).json.error.message).toContain("deliver_by");
    m.clock.now = (offer.deliver_by + 10) * 1000;
    const after = Math.floor(m.clock.now / 1000);
    const cancelled = await send(m, hash, notice(hash, oh, "budi", "cancelled", after));
    expect(cancelled.json).toMatchObject({ state: "cancelled", cancelledBy: acct("budi"), payable: false });
    expect((await send(m, hash, notice(hash, oh, "andi", "delivered", after))).json.error.code).toBe("delivery_state");
    await market?.srv.close();

    const second = await matched();
    const t = Math.floor(second.m.clock.now / 1000);
    await send(second.m, second.hash, notice(second.hash, second.offerHash, "andi", "delivered", t));
    // the buyer cannot cancel a delivery that was made; the seller can withdraw it
    second.m.clock.now = (second.offer.deliver_by + 10) * 1000;
    const t2 = Math.floor(second.m.clock.now / 1000);
    expect((await send(second.m, second.hash, notice(second.hash, second.offerHash, "budi", "cancelled", t2))).json.error.code).toBe("delivery_state");
    expect((await send(second.m, second.hash, notice(second.hash, second.offerHash, "andi", "cancelled", t2))).json).toMatchObject({ state: "cancelled", cancelledBy: acct("andi") });
  });

  it("TC-BE-047-07 a barter bundle on a class C asset is not ready to commit until the buyer confirmed", async () => {
    market = await startMarket(["andi", "budi", "citra"]);
    const m2 = market;
    openEpoch(m2);
    const body = signedListing(m2, "andi", { offer: { asset_type: "gift-card-code", asset_class: "C", quantity: 1, value: C(100) } });
    const lh = listingHash(body.listing);
    await m2.post("/listings", body);
    const first = bid(m2, "budi", body.listing, { mode: "barter", value: C(100) });
    const posted = await m2.post(`/listings/${lh}/offers`, first);
    const mine = acceptOffer({ listing: body.listing, offer: first.offer, epoch: 42, searcher: acct("citra"), searcherShareBps: 300, account: acct("andi") }, m2.keys.andi!.secretKey);
    if (mine.kind !== "bundle") throw new Error("must be a bundle");
    const res = await m2.post(`/listings/${lh}/offers/${posted.json.offerHash}/accept`, { account: acct("andi"), signature: mine.signature.signature, searcher: acct("citra"), searcherShareBps: 300 });
    expect(res.status).toBe(201);
    expect(res.json.result.delivery).toMatchObject({ required: true, payable: false, state: "awaiting" });
    for (const who of ["budi", "citra"]) {
      const s = await m2.post(`/bundle-proposals/${mine.terms_hash}/signatures`, { account: acct(who), signature: signBundle(mine.terms, acct(who), m2.keys[who]!.secretKey).signature });
      expect(s.status).toBe(201);
    }
    // everybody signed, but the delivery has not been confirmed
    expect((await m2.get(`/bundle-proposals/${mine.terms_hash}`)).json).toMatchObject({ status: "proposed", missing: [] });
    expect((await m2.get("/bundle-proposals?status=ready")).json.items).toHaveLength(0);
    const nowS = Math.floor(m2.clock.now / 1000);
    const ohash = posted.json.offerHash as string;
    await send(m2, lh, notice(lh, ohash, "andi", "delivered", nowS));
    expect((await m2.get(`/bundle-proposals/${mine.terms_hash}`)).json.status).toBe("proposed");
    await send(m2, lh, notice(lh, ohash, "budi", "confirmed", nowS + 5));
    expect((await m2.get(`/bundle-proposals/${mine.terms_hash}`)).json.status).toBe("ready");
    expect((await m2.get("/bundle-proposals?status=ready")).json.items).toHaveLength(1);
  });
});
