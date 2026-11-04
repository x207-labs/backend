import { afterEach, describe, expect, it } from "vitest";
import { listingHash } from "@x207/core";
import { acct, bid, openEpoch, signedListing, startMarket, type Market } from "./helpers.js";

const C = (n: number): string => (BigInt(n) * 1_000_000n).toString();

// UM-097: a handover that needs the confirmation of the receiver (BE-047), such as airtime or loyalty points, asks for a bond (CT-094) from the bond threshold up. Only flagged, like invoices and orders.
describe("UM-097 delivery of a deal at or above the bond threshold is flagged needsBond", () => {
  let market: Market | undefined;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });

  async function matched(value: number, options: Record<string, unknown> = {}) {
    market = await startMarket(["andi", "budi"], [], undefined, options);
    const m = market;
    openEpoch(m);
    const body = signedListing(m, "andi", { offer: { asset_type: "telco:airtime-data", asset_class: "B", quantity: 1, value: C(value) } });
    const hash = listingHash(body.listing);
    await m.post("/listings", body);
    const first = bid(m, "budi", body.listing, { mode: "pay", value: C(value) });
    const posted = await m.post(`/listings/${hash}/offers`, first);
    const accepted = await m.post(`/listings/${hash}/offers/${posted.json.offerHash}/accept`, { account: acct("andi") });
    return { m, hash, accepted };
  }

  it("TC-UM-097-01 99 credit is not flagged, 100 credit is; the answer of accept and the GET of the delivery say the same", async () => {
    const small = await matched(99);
    expect(small.accepted.json.result.delivery).toMatchObject({ required: true, payable: false, needsBond: false });
    expect((await small.m.get(`/listings/${small.hash}/delivery`)).json.needsBond).toBe(false);
    await market?.srv.close();
    const big = await matched(100);
    expect(big.accepted.json.result.delivery).toMatchObject({ required: true, payable: false, needsBond: true });
    expect((await big.m.get(`/listings/${big.hash}/delivery`)).json).toMatchObject({ needsBond: true, payable: false });
  });

  it("TC-UM-097-02 the threshold is the one of the operator (bondThreshold)", async () => {
    const r = await matched(40, { bondThreshold: 30_000_000n });
    expect(r.accepted.json.result.delivery.needsBond).toBe(true);
    await market?.srv.close();
    const r2 = await matched(40, { bondThreshold: 50_000_000n });
    expect(r2.accepted.json.result.delivery.needsBond).toBe(false);
  });
});
