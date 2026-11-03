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
    circle: CONTRACT, listing_hash: hash, offer_hash: offerHashHex, side: "offer", actor: acct(actor), action, at,
    proof_hash: action === "delivered" ? PROOF : null, reason: action === "disputed" ? "not_as_described" : null, ...over,
  });
  /** The handover of one side in the answer of the delivery routes. */
  const side = (json: any, which: "offer" | "want" = "offer") => json.deliveries.find((d: any) => d.side === which);
  const send = (m: Market, hash: string, n: DeliveryNotice, as: string = n.actor.split(".")[0]!) => m.post(`/listings/${hash}/delivery`, { notice: n, signature: signDeliveryNotice(n, m.keys[as]!.secretKey) });

  it("TC-BE-047-01 a class C match starts in awaiting and says the payment is not payable; class A and D do not wait", async () => {
    const { m, hash, accepted, offerHash: oh } = await matched();
    expect(accepted.json.result).toMatchObject({ kind: "payment", payer: acct("budi"), payee: acct("andi"), delivery: { required: true, payable: false, sides: { offer: "awaiting" } } });
    const d = await m.get(`/listings/${hash}/delivery`);
    expect(d.json.payable).toBe(false);
    expect(d.json.deliveries).toHaveLength(1);
    expect(side(d.json)).toMatchObject({ side: "offer", state: "awaiting", deliverer: acct("andi"), receiver: acct("budi"), offerHash: oh, notices: [] });
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
    expect(sent.json.payable).toBe(false);
    expect(side(sent.json)).toMatchObject({ state: "delivered", proofHash: PROOF, autoConfirmed: false });
    expect(side(sent.json).confirmBy).toBe(new Date((nowS + 72 * 3600) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"));
    const done = await send(m, hash, notice(hash, oh, "budi", "confirmed", nowS + 60));
    expect(done.status).toBe(201);
    expect(done.json.payable).toBe(true);
    expect(side(done.json)).toMatchObject({ state: "confirmed", autoConfirmed: false });
    expect(side(done.json).notices.map((n: any) => [n.actor, n.action])).toEqual([[acct("andi"), "delivered"], [acct("budi"), "confirmed"]]);
    expect(side(done.json).notices[1].noticeHash).toBe(deliveryNoticeHash(notice(hash, oh, "budi", "confirmed", nowS + 60)));
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
    expect(side((await m.get(`/listings/${hash}/delivery`)).json).state).toBe("delivered");
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
    expect(d.json.payable).toBe(false);
    expect(side(d.json)).toMatchObject({ state: "disputed", disputeReason: "not_received" });
    expect((await send(m, hash, notice(hash, oh, "budi", "confirmed", nowS + 40))).json.error.code).toBe("delivery_state");
    // a dispute is not undone by the passing of time
    m.clock.now += 10 * 86_400 * 1000;
    const after = (await m.get(`/listings/${hash}/delivery`)).json;
    expect([after.payable, side(after).state, side(after).autoConfirmed]).toEqual([false, "disputed", false]);
  });

  it("TC-BE-047-05 silence for the whole window confirms the delivery by itself; a dispute after the window is refused", async () => {
    const { m, hash, offerHash: oh } = await matched();
    const nowS = Math.floor(m.clock.now / 1000);
    await send(m, hash, notice(hash, oh, "andi", "delivered", nowS));
    // inside the window nothing happens by itself
    m.clock.now += (72 * 3600 - 60) * 1000;
    const inside = (await m.get(`/listings/${hash}/delivery`)).json;
    expect([inside.payable, side(inside).state]).toEqual([false, "delivered"]);
    m.clock.now += 120 * 1000;
    const later = Math.floor(m.clock.now / 1000);
    const late = await send(m, hash, notice(hash, oh, "budi", "disputed", later));
    expect([late.status, late.json.error.code]).toEqual([409, "delivery_state"]);
    const after = (await m.get(`/listings/${hash}/delivery`)).json;
    expect(after.payable).toBe(true);
    expect(side(after)).toMatchObject({ state: "confirmed", autoConfirmed: true, confirmedAt: side(after).confirmBy });
    // the seller cannot take it back after the confirmation
    expect((await send(m, hash, notice(hash, oh, "andi", "cancelled", later))).json.error.code).toBe("delivery_state");
  });

  it("TC-BE-047-05b the dispute inside the last second of the window still counts and stops the automatic confirmation", async () => {
    const { m, hash, offerHash: oh } = await matched();
    const nowS = Math.floor(m.clock.now / 1000);
    await send(m, hash, notice(hash, oh, "andi", "delivered", nowS));
    m.clock.now += (72 * 3600) * 1000;
    const at = Math.floor(m.clock.now / 1000);
    expect(at).toBe(nowS + 72 * 3600);
    const d = await send(m, hash, notice(hash, oh, "budi", "disputed", at, { reason: "other" }));
    expect([d.status, side(d.json).state]).toEqual([201, "disputed"]);
    m.clock.now += 3600 * 1000;
    expect((await m.get(`/listings/${hash}/delivery`)).json.payable).toBe(false);
  });

  it("TC-BE-047-06 cancel: the seller until the buyer confirms; the buyer only when nothing came by deliver_by", async () => {
    const { m, hash, offerHash: oh, offer } = await matched();
    const nowS = Math.floor(m.clock.now / 1000);
    expect((await send(m, hash, notice(hash, oh, "budi", "cancelled", nowS))).json.error.message).toContain("deliver_by");
    m.clock.now = (offer.deliver_by + 10) * 1000;
    const after = Math.floor(m.clock.now / 1000);
    const cancelled = await send(m, hash, notice(hash, oh, "budi", "cancelled", after));
    expect(cancelled.json.payable).toBe(false);
    expect(side(cancelled.json)).toMatchObject({ state: "cancelled", cancelledBy: acct("budi") });
    expect((await send(m, hash, notice(hash, oh, "andi", "delivered", after))).json.error.code).toBe("delivery_state");
    await market?.srv.close();

    const second = await matched();
    // a late delivery is still a delivery: after deliver_by the seller delivers, and from then on the buyer can no longer cancel
    second.m.clock.now = (second.offer.deliver_by + 10) * 1000;
    const t = Math.floor(second.m.clock.now / 1000);
    await send(second.m, second.hash, notice(second.hash, second.offerHash, "andi", "delivered", t));
    expect((await send(second.m, second.hash, notice(second.hash, second.offerHash, "budi", "cancelled", t))).json.error.code).toBe("delivery_state");
    expect(side((await send(second.m, second.hash, notice(second.hash, second.offerHash, "andi", "cancelled", t))).json)).toMatchObject({ state: "cancelled", cancelledBy: acct("andi") });
  });

  it("TC-BE-047-07 a barter bundle on a class C asset is not ready to commit until the buyer confirmed", async () => {
    market = await startMarket(["andi", "budi", "citra"]);
    const m2 = market;
    openEpoch(m2);
    const body = signedListing(m2, "andi", { offer: { asset_type: "gift-card-code", asset_class: "C", quantity: 1, value: C(100) }, want: { asset_type: "translation", asset_class: "A", quantity: 5, value: C(100) } });
    const lh = listingHash(body.listing);
    await m2.post("/listings", body);
    const first = bid(m2, "budi", body.listing, { mode: "barter", value: C(100) });
    const posted = await m2.post(`/listings/${lh}/offers`, first);
    const mine = acceptOffer({ listing: body.listing, offer: first.offer, epoch: 42, searcher: acct("citra"), searcherShareBps: 300, account: acct("andi") }, m2.keys.andi!.secretKey);
    if (mine.kind !== "bundle") throw new Error("must be a bundle");
    const res = await m2.post(`/listings/${lh}/offers/${posted.json.offerHash}/accept`, { account: acct("andi"), signature: mine.signature.signature, searcher: acct("citra"), searcherShareBps: 300 });
    expect(res.status).toBe(201);
    expect(res.json.result.delivery).toMatchObject({ required: true, payable: false, sides: { offer: "awaiting" } });
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
  it("TC-BE-047-08 a bundle becomes ready when the window passes in silence, with no notice at all after the delivery", async () => {
    const f = await barterMatch({ wantClass: "A" });
    const nowS = Math.floor(f.m.clock.now / 1000);
    await send(f.m, f.lh, notice(f.lh, f.oh, "andi", "delivered", nowS));
    expect((await f.m.get(`/bundle-proposals/${f.termsHash}`)).json.status).toBe("proposed");
    f.m.clock.now += (72 * 3600 + 5) * 1000;
    // the bundle routes settle the deliveries that are due, so a reader sees the bundle ready
    expect((await f.m.get(`/bundle-proposals/${f.termsHash}`)).json.status).toBe("ready");
    expect((await f.m.get("/bundle-proposals?status=ready")).json.items).toHaveLength(1);
  });

  it("TC-BE-047-09 in a barter match the counterparty's own handover is tracked too, with the roles turned round, and both must be confirmed", async () => {
    const f = await barterMatch({ wantClass: "C" });
    const nowS = Math.floor(f.m.clock.now / 1000);
    const state = await f.m.get(`/listings/${f.lh}/delivery`);
    expect(state.json.deliveries.map((d: any) => [d.side, d.deliverer, d.receiver, d.state])).toEqual([
      ["want", acct("budi"), acct("andi"), "awaiting"], ["offer", acct("andi"), acct("budi"), "awaiting"],
    ]);
    expect(f.res.json.result.delivery).toMatchObject({ required: true, payable: false, sides: { offer: "awaiting", want: "awaiting" } });
    // each side takes notices from its own parties only
    const wrongWay = await send(f.m, f.lh, notice(f.lh, f.oh, "andi", "delivered", nowS, { side: "want" }));
    expect(wrongWay.json.error.code).toBe("not_a_party");
    expect((await send(f.m, f.lh, notice(f.lh, f.oh, "budi", "delivered", nowS, { side: "want" }))).status).toBe(201);
    expect((await send(f.m, f.lh, notice(f.lh, f.oh, "andi", "delivered", nowS))).status).toBe(201);
    // the seller confirms what the counterparty handed over; the bundle still waits for the other side
    const half = await send(f.m, f.lh, notice(f.lh, f.oh, "andi", "confirmed", nowS + 5, { side: "want" }));
    expect([half.json.payable, side(half.json, "want").state, side(half.json).state]).toEqual([false, "confirmed", "delivered"]);
    expect((await f.m.get(`/bundle-proposals/${f.termsHash}`)).json.status).toBe("proposed");
    // a signature made for one side is not valid for the other
    const crossed = notice(f.lh, f.oh, "budi", "confirmed", nowS + 6);
    const crossedBody = { notice: { ...crossed, side: "want" }, signature: signDeliveryNotice(crossed, f.m.keys.budi!.secretKey) };
    expect((await f.m.post(`/listings/${f.lh}/delivery`, crossedBody)).json.error.code).toBe("invalid_signature");
    const full = await send(f.m, f.lh, notice(f.lh, f.oh, "budi", "confirmed", nowS + 6));
    expect([full.json.payable, side(full.json).state]).toEqual([true, "confirmed"]);
    expect((await f.m.get(`/bundle-proposals/${f.termsHash}`)).json.status).toBe("ready");
  });

  it("TC-BE-047-10 a pay match has one handover only; a barter match whose wanted asset needs no confirmation has one too", async () => {
    const pay = await matched();
    expect((await pay.m.get(`/listings/${pay.hash}/delivery`)).json.deliveries.map((d: any) => d.side)).toEqual(["offer"]);
    expect((await send(pay.m, pay.hash, notice(pay.hash, pay.offerHash, "budi", "delivered", Math.floor(pay.m.clock.now / 1000), { side: "want" }))).json.error.code).toBe("delivery_not_found");
    await market?.srv.close();
    const barter = await barterMatch({ wantClass: "A" });
    expect((await barter.m.get(`/listings/${barter.lh}/delivery`)).json.deliveries.map((d: any) => d.side)).toEqual(["offer"]);
  });

  /** andi offers a class C asset and wants an asset of class `wantClass`; budi bids in barter mode; andi accepts with a signed bundle. */
  async function barterMatch(over: { wantClass: "A" | "B" | "C" | "D" }) {
    market = await startMarket(["andi", "budi", "citra"]);
    const m = market;
    openEpoch(m);
    const body = signedListing(m, "andi", {
      offer: { asset_type: "gift-card-code", asset_class: "C", quantity: 1, value: C(100) },
      want: { asset_type: "translation", asset_class: over.wantClass, quantity: 5, value: C(100) },
    });
    const lh = listingHash(body.listing);
    await m.post("/listings", body);
    const first = bid(m, "budi", body.listing, { mode: "barter", value: C(100) });
    const posted = await m.post(`/listings/${lh}/offers`, first);
    const mine = acceptOffer({ listing: body.listing, offer: first.offer, epoch: 42, searcher: acct("citra"), searcherShareBps: 300, account: acct("andi") }, m.keys.andi!.secretKey);
    if (mine.kind !== "bundle") throw new Error("must be a bundle");
    const res = await m.post(`/listings/${lh}/offers/${posted.json.offerHash}/accept`, { account: acct("andi"), signature: mine.signature.signature, searcher: acct("citra"), searcherShareBps: 300 });
    expect(res.status).toBe(201);
    for (const who of ["budi", "citra"]) {
      const s = await m.post(`/bundle-proposals/${mine.terms_hash}/signatures`, { account: acct(who), signature: signBundle(mine.terms, acct(who), m.keys[who]!.secretKey).signature });
      expect(s.status).toBe(201);
    }
    return { m, lh, oh: posted.json.offerHash as string, termsHash: mine.terms_hash, res };
  }
});
