import { afterEach, describe, expect, it } from "vitest";
import { acceptOffer, listingHash, signCancelListing } from "@x207/core";
import { acct, bid, NOW_S, openEpoch, signedListing, startMarket, type Market } from "./helpers.js";

const C = (n: number) => String(n * 1_000_000);

describe("BE-043 marketplace statistics from data", () => {
  let market: Market | undefined;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });

  it("an empty circle yields zero, not samples", async () => {
    market = await startMarket();
    const stats = (await market.get("/marketplace/stats")).json;
    expect(stats.listings).toEqual({ open: 0, matched: 0, cancelled: 0, expired: 0, total: 0 });
    expect(stats.matches).toMatchObject({ count: 0, discountValue: "0", listingValue: "0" });
    expect(stats.timeToMatchSeconds).toEqual({ samples: 0, min: null, max: null, average: null, median: null });
    expect(stats.searcherRevenue).toEqual({ total: "0", matchesWithSearcher: 0, bySearcher: [] });
  });

  it("counts active listings, matches, time to match, discount value and seeker earnings", async () => {
    market = await startMarket(["andi", "budi", "citra", "dewi"]);
    const m = market;
    openEpoch(m, 42);
    const start = m.clock.now;

    // L1 (Andi) listed at t0, matched 60 seconds later through a barter with seeker Citra (discount 10, share 3)
    const l1 = signedListing(m, "andi", { offer: { asset_type: "gpu-hours", asset_class: "A", quantity: 10, value: C(100) }, nonce: "l1" });
    const h1 = listingHash(l1.listing);
    await m.post("/listings", l1);
    const b1 = bid(m, "budi", l1.listing, { value: C(100) });
    const o1 = (await m.post(`/listings/${h1}/offers`, b1)).json.offerHash;

    // L2 (Dewi) listed at t0, paid directly (no seeker) 180 seconds later: discount 20 of 200
    const l2 = signedListing(m, "dewi", { offer: { asset_type: "dataset", asset_class: "D", quantity: 1, value: C(200) }, discount_bps: 1000, nonce: "l2" });
    const h2 = listingHash(l2.listing);
    await m.post("/listings", l2);
    const b2 = bid(m, "budi", l2.listing, { mode: "pay", value: C(200) });
    const o2 = (await m.post(`/listings/${h2}/offers`, b2)).json.offerHash;

    // L3 stays open, L4 is cancelled, L5 expires later
    const l3 = signedListing(m, "citra", { nonce: "l3" });
    await m.post("/listings", l3);
    const l4 = signedListing(m, "citra", { nonce: "l4" });
    await m.post("/listings", l4);
    await m.post(`/listings/${listingHash(l4.listing)}/cancel`, { signature: signCancelListing(l4.listing, m.keys.citra!.secretKey) });
    await m.post("/listings", signedListing(m, "budi", { nonce: "l5", expires_at: NOW_S + 300 }));

    m.clock.now = start + 60_000;
    const mine = acceptOffer({ listing: l1.listing, offer: b1.offer, epoch: 42, searcher: acct("citra"), searcherShareBps: 300, account: acct("andi") }, m.keys.andi!.secretKey);
    if (mine.kind !== "bundle") throw new Error("must be a bundle");
    expect((await m.post(`/listings/${h1}/offers/${o1}/accept`, { account: acct("andi"), signature: mine.signature.signature, searcher: acct("citra"), searcherShareBps: 300 })).status).toBe(201);

    m.clock.now = start + 180_000;
    expect((await m.post(`/listings/${h2}/offers/${o2}/accept`, { account: acct("dewi") })).status).toBe(201);

    m.clock.now = start + 400_000; // L5 is past expires_at
    const stats = (await m.get("/marketplace/stats")).json;
    expect(stats.listings).toEqual({ open: 1, matched: 2, cancelled: 1, expired: 1, total: 5 });
    expect(stats.openListingsByOfferClass).toEqual({ A: 1 });
    expect(stats.matches).toEqual({ count: 2, payment: 1, bundle: 1, pay: 1, barter: 1, listingValue: C(300), discountValue: C(10 + 20) });
    expect(stats.timeToMatchSeconds).toEqual({ samples: 2, min: 60, max: 180, average: 120, median: 120 });
    expect(stats.searcherRevenue).toEqual({ total: C(3), matchesWithSearcher: 1, bySearcher: [{ account: acct("citra"), total: C(3) }] });
    expect(stats.bundleProposals).toEqual({ proposed: 1, ready: 0 });
    expect(stats).toMatchObject({ offersPending: 0, intentsOpen: 0, unit: "credit", decimals: 6 });
  });
});
