import { afterEach, describe, expect, it } from "vitest";
import { listingHash, signBundle, termsHash, type BundleTerms } from "@x207/core";
import { acct, bid, CONTRACT, NOW_S, openEpoch, signedListing, startMarket, type Market } from "./helpers.js";

const C = (n: number): string => (BigInt(n) * 1_000_000n).toString();

// UM-097: a handover that needs the confirmation of the receiver (BE-047), such as airtime or loyalty points, is a deal with a bond (CT-094) from the bond threshold up: accept refuses a plain payment
// and takes a bundle of the two parties whose signed terms name an arbiter. The bundle is committed BEFORE the handover, so the bond is what protects the receiver.
describe("UM-097 a handover worth the bond threshold or more is a deal with a bond", () => {
  let market: Market | undefined;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });

  async function offered(value: number, options: Record<string, unknown> = {}) {
    market = await startMarket(["andi", "budi", "citra"], [], undefined, options);
    const m = market;
    openEpoch(m);
    const body = signedListing(m, "andi", { offer: { asset_type: "telco:airtime-data", asset_class: "B", quantity: 1, value: C(value) } });
    const hash = listingHash(body.listing);
    await m.post("/listings", body);
    const first = bid(m, "budi", body.listing, { mode: "pay", value: C(value) });
    const posted = await m.post(`/listings/${hash}/offers`, first);
    return { m, hash, offerHash: posted.json.offerHash as string, value };
  }
  const confirmBy = (m: Market, days: number): string => ((BigInt(Math.floor(m.clock.now / 1000)) + BigInt(days) * 86_400n) * 1_000_000_000n).toString();
  const termsOf = (m: Market, value: number, arbiter = "citra"): BundleTerms => ({
    circle: CONTRACT, epoch: 42, legs: [{ payer: acct("budi"), payee: acct("andi"), max_amount: C(value) }, { payer: acct("andi"), payee: acct("budi"), max_amount: "1" }], arbiter: acct(arbiter), confirm_by: confirmBy(m, 3),
  });

  it("TC-UM-097-01 below the threshold nothing changes; at or above it accept refuses a plain payment with bond_required, and the preview says needsBond", async () => {
    const small = await offered(99);
    const ok = await small.m.post(`/listings/${small.hash}/offers/${small.offerHash}/accept`, { account: acct("andi") });
    expect([ok.status, ok.json.result.delivery.needsBond]).toEqual([201, false]);
    expect((await small.m.get(`/listings/${small.hash}/delivery`)).json.needsBond).toBe(false);
    await market?.srv.close();
    const big = await offered(100);
    const preview = await big.m.post(`/listings/${big.hash}/offers/${big.offerHash}/preview`, { account: acct("andi") });
    expect([preview.status, preview.json.needsBond]).toEqual([200, true]);
    const refused = await big.m.post(`/listings/${big.hash}/offers/${big.offerHash}/accept`, { account: acct("andi") });
    expect([refused.status, refused.json.error.code]).toEqual([409, "bond_required"]);
    expect((await big.m.get(`/listings/${big.hash}`)).json.status).toBe("open"); // nothing was matched
    // an arbiter on a deal below the threshold is a mistake
    await market?.srv.close();
    const odd = await offered(10);
    const wrong = await odd.m.post(`/listings/${odd.hash}/offers/${odd.offerHash}/accept`, { account: acct("andi"), arbiter: acct("citra"), confirmBy: confirmBy(odd.m, 3), signature: "x" });
    expect([wrong.status, wrong.json.error.code]).toEqual([400, "invalid_request"]);
  });

  it("TC-UM-097-02 a deal with a bond is accepted as a bundle with the arbiter in its signed terms; it is ready to commit before the handover, while the payment still waits for the confirmation", async () => {
    const { m, hash, offerHash } = await offered(130);
    // the terms to sign come from the preview (the price is the offer after the discount of the listing)
    const base = termsOf(m, 130);
    const shown = await m.post(`/listings/${hash}/offers/${offerHash}/preview`, { account: acct("andi"), arbiter: base.arbiter, confirmBy: base.confirm_by });
    expect([shown.status, shown.json.kind, shown.json.needsBond]).toEqual([200, "bundle", true]);
    const terms = shown.json.bundle.terms as BundleTerms;
    expect(terms.legs.map((l) => [l.payer, l.payee, l.max_amount])).toEqual([[acct("budi"), acct("andi"), C(117)], [acct("andi"), acct("budi"), "1"]]); // a sale of 130 credit with 10% off, and the nominal return leg
    const hashHex = termsHash(terms);
    // the arbiter cannot be a party; a bad window is refused by the format
    const party = await m.post(`/listings/${hash}/offers/${offerHash}/accept`, { account: acct("andi"), arbiter: acct("budi"), confirmBy: terms.confirm_by, signature: "ed25519:x" });
    expect(party.status).toBe(400);
    const res = await m.post(`/listings/${hash}/offers/${offerHash}/accept`, { account: acct("andi"), arbiter: terms.arbiter, confirmBy: terms.confirm_by, signature: signBundle(terms, acct("andi"), m.keys.andi!.secretKey).signature });
    expect(res.status).toBe(201);
    expect(res.json.result).toMatchObject({ kind: "bundle", delivery: { required: true, payable: false, needsBond: true, sides: { offer: "awaiting" } } });
    expect(res.json.result.proposal).toMatchObject({ termsHash: hashHex, status: "proposed", missing: [acct("budi")] });
    expect(res.json.result.proposal.terms).toMatchObject({ arbiter: terms.arbiter, confirm_by: terms.confirm_by });
    // the buyer signs the same terms: the bundle is ready to commit although nothing was handed over (the bond protects the receiver), but the payment is not payable yet
    const second = await m.post(`/bundle-proposals/${hashHex}/signatures`, { account: acct("budi"), signature: signBundle(terms, acct("budi"), m.keys.budi!.secretKey).signature });
    expect(second.status).toBe(201);
    expect((await m.get(`/bundle-proposals/${hashHex}`)).json).toMatchObject({ status: "ready", missing: [] });
    expect((await m.get(`/listings/${hash}/delivery`)).json).toMatchObject({ needsBond: true, payable: false });
  });

  it("TC-UM-097-03 the threshold is the one of the operator (bondThreshold)", async () => {
    const a = await offered(40, { bondThreshold: 30_000_000n });
    expect((await a.m.post(`/listings/${a.hash}/offers/${a.offerHash}/accept`, { account: acct("andi") })).json.error.code).toBe("bond_required");
    await market?.srv.close();
    const b = await offered(40, { bondThreshold: 50_000_000n });
    expect((await b.m.post(`/listings/${b.hash}/offers/${b.offerHash}/accept`, { account: acct("andi") })).json.result.delivery.needsBond).toBe(false);
  });
});
