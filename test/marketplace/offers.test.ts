import { afterEach, describe, expect, it } from "vitest";
import { listingHash, offerHash } from "@x207/core";
import { acct, bid, signedListing, startMarket, type Market } from "./helpers.js";

describe("BE-041 negotiation: offers and counter-offers", () => {
  let market: Market | undefined;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });

  async function withListing() {
    market = await startMarket(["andi", "budi", "citra"]);
    const m = market;
    const body = signedListing(m, "andi");
    const hash = listingHash(body.listing);
    expect((await m.post("/listings", body)).status).toBe(201);
    return { m, l: body.listing, hash };
  }

  it("one bargaining round: the counterparty bids, the lister replies, the thread status moves", async () => {
    const { m, l, hash } = await withListing();
    const first = bid(m, "budi", l, { value: "95000000" });
    const r1 = await m.post(`/listings/${hash}/offers`, first);
    expect(r1.status).toBe(201);
    expect(r1.json).toMatchObject({ round: 1, proposer: acct("budi"), counterparty: acct("budi"), awaiting: acct("andi"), status: "pending", mode: "barter", value: "95000000", offerHash: offerHash(first.offer) });

    const second = bid(m, "andi", l, { value: "98000000", previous: first.offer });
    const r2 = await m.post(`/listings/${hash}/offers`, { ...second, inReplyTo: r1.json.offerHash });
    expect(r2.status).toBe(201);
    expect(r2.json).toMatchObject({ round: 2, proposer: acct("andi"), counterparty: acct("budi"), awaiting: acct("budi"), inReplyTo: r1.json.offerHash });

    const thread = await m.get(`/listings/${hash}/offers`);
    expect(thread.json.items.map((o: any) => [o.round, o.status])).toEqual([[1, "countered"], [2, "pending"]]);
    expect((await m.get(`/listings/${hash}/offers?status=pending`)).json.items).toHaveLength(1);
  });

  it("inbox per agent: the lister sees the offers waiting for them; they disappear when the listing expires", async () => {
    const { m, l, hash } = await withListing();
    await m.post(`/listings/${hash}/offers`, bid(m, "budi", l));
    await m.post(`/listings/${hash}/offers`, bid(m, "citra", l));
    const inbox = await m.get(`/offers?account=${acct("andi")}`);
    expect(inbox.json.items.map((o: any) => o.proposer)).toEqual([acct("budi"), acct("citra")]);
    expect((await m.get(`/offers?account=${acct("budi")}`)).json.items).toHaveLength(0);
    expect((await m.get(`/offers?account=${acct("budi")}&box=sent`)).json.items).toHaveLength(1);
    expect((await m.get("/offers")).status).toBe(400);
    expect((await m.get(`/offers?account=${acct("andi")}&box=x`)).status).toBe(400);
    m.clock.now = (l.expires_at + 1) * 1000;
    expect((await m.get(`/offers?account=${acct("andi")}`)).json.items).toHaveLength(0);
  });

  it("round rules: the lister does not bid on their own listing, the counterparty does not reply to itself, the round rises by one, one thread per counterparty", async () => {
    const { m, l, hash } = await withListing();
    const own = bid(m, "andi", l);
    expect((await m.post(`/listings/${hash}/offers`, own)).json.error.message).toContain("cannot make an offer on their own listing");
    const first = bid(m, "budi", l);
    const r1 = await m.post(`/listings/${hash}/offers`, first);
    expect((await m.post(`/listings/${hash}/offers`, bid(m, "budi", l, { value: "1" }))).json.error.code).toBe("already_exists");
    // a reply without inReplyTo, from the wrong party, and with a skipped round
    const reply = bid(m, "andi", l, { previous: first.offer });
    expect((await m.post(`/listings/${hash}/offers`, reply)).status).toBe(400);
    const sameSide = bid(m, "budi", l, { round: 2 });
    expect((await m.post(`/listings/${hash}/offers`, { ...sameSide, inReplyTo: r1.json.offerHash })).json.error.message).toContain("the other party");
    expect((await m.post(`/listings/${hash}/offers`, { ...reply, inReplyTo: "f".repeat(64) })).json.error.code).toBe("offer_not_found");
    expect((await m.post(`/listings/${hash}/offers`, { ...reply, inReplyTo: r1.json.offerHash })).status).toBe(201);
    // an offer that has been replied to cannot be replied to again
    const again = bid(m, "andi", l, { previous: first.offer, value: "7" });
    expect((await m.post(`/listings/${hash}/offers`, { ...again, inReplyTo: r1.json.offerHash })).json.error.code).toBe("offer_not_open");
  });

  it("rejects pay mode without accept_payment, a wrong signature, an inactive member, a listing that is not open", async () => {
    market = await startMarket(["andi", "budi"], ["gita"]);
    const m = market;
    const noPay = signedListing(m, "andi", { accept_payment: false });
    const hash = listingHash(noPay.listing);
    await m.post("/listings", noPay);
    expect((await m.post(`/listings/${hash}/offers`, bid(m, "budi", noPay.listing, { mode: "pay" }))).json.error.message).toContain("accept_payment");
    const good = bid(m, "budi", noPay.listing);
    const forged = { ...good, signature: bid(m, "andi", noPay.listing).signature };
    expect((await m.post(`/listings/${hash}/offers`, forged)).json.error.code).toBe("invalid_signature");
    expect((await m.post(`/listings/${hash}/offers`, bid(m, "gita", noPay.listing))).json.error.code).toBe("member_not_active");
    expect((await m.post(`/listings/${hash}/offers`, { ...good, offer: { ...good.offer, listing_hash: "a".repeat(64) } })).status).toBe(400);
    expect((await m.post(`/listings/${"b".repeat(64)}/offers`, good)).json.error.code).toBe("listing_not_found");
    const { signCancelListing } = await import("@x207/core");
    await m.post(`/listings/${hash}/cancel`, { signature: signCancelListing(noPay.listing, m.keys.andi!.secretKey) });
    expect((await m.post(`/listings/${hash}/offers`, good)).json.error.code).toBe("listing_not_open");
  });

  it("a round above the limit is rejected with negotiation_closed", async () => {
    const { m, l, hash } = await withListing();
    const res = await m.post(`/listings/${hash}/offers`, bid(m, "budi", l, { round: 11 }));
    expect([res.status, res.json.error.code]).toEqual([409, "negotiation_closed"]);
  });
});
