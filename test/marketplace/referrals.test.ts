import { afterEach, describe, expect, it } from "vitest";
import { acceptOffer, listingHash, referralHash, signCancelListing, signRefuseReferral } from "@x207/core";
import { acct, bid, NOW_S, openEpoch, referral, signedListing, signedReferral, startMarket, type Market } from "./helpers.js";

const C = (n: number) => String(n * 1_000_000);

describe("BE-044 seeker referral inbox", () => {
  let market: Market | undefined;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });

  async function setup(options: { maxReferrals?: number; listingOver?: Parameters<typeof signedListing>[2] } = {}) {
    market = await startMarket(["andi", "budi", "citra", "dewi"], ["gita"], undefined, options.maxReferrals === undefined ? {} : { maxReferrals: options.maxReferrals });
    const m = market;
    openEpoch(m, 42);
    const body = signedListing(m, "andi", { offer: { asset_type: "gpu-hours", asset_class: "A", quantity: 10, value: C(100) }, ...options.listingOver });
    const hash = listingHash(body.listing);
    expect((await m.post("/listings", body)).status).toBe(201);
    return { m, body, l: body.listing, hash };
  }

  it("a referral lands in the target's inbox, the target bids referencing it, the lister accepts and the seeker share attaches", async () => {
    const { m, l, hash } = await setup();
    const sent = signedReferral(m, "citra", "budi", l);
    const created = await m.post("/referrals", sent);
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ referralHash: referralHash(sent.referral), seeker: acct("citra"), to: acct("budi"), status: "pending", searcherShareBps: 300 });
    expect((await m.get(`/referrals?account=${acct("budi")}`)).json.items.map((r: any) => r.referralHash)).toEqual([created.json.referralHash]);
    expect((await m.get(`/referrals?account=${acct("citra")}&box=sent`)).json.items).toHaveLength(1);
    expect((await m.get(`/referrals?account=${acct("dewi")}`)).json.items).toEqual([]);

    // budi bids on their own (signed by budi), referencing the referral; the content must equal the referral
    const first = bid(m, "budi", l, { mode: "barter", value: C(100) });
    const offered = await m.post(`/listings/${hash}/offers`, { ...first, referralHash: created.json.referralHash });
    expect(offered.status).toBe(201);
    const taken = (await m.get(`/referrals?account=${acct("budi")}&status=taken`)).json.items[0];
    expect(taken).toMatchObject({ status: "taken", offerHash: offered.json.offerHash });
    expect((await m.get(`/referrals?account=${acct("budi")}`)).json.items).toEqual([]);

    // the lister accepts without naming a seeker: the preview and the acceptance use the seeker and share from the referral
    const preview = await m.post(`/listings/${hash}/offers/${offered.json.offerHash}/preview`, { account: acct("andi") });
    expect(preview.json).toMatchObject({ kind: "bundle", searcher: acct("citra"), searcherValue: C(3), discountValue: C(10) });
    expect(preview.json.breakdown).toMatchObject({ mode: "barter", cashback: C(7), sellerBears: C(10) });
    const mine = acceptOffer({ listing: l, offer: first.offer, epoch: 42, searcher: acct("citra"), searcherShareBps: 300, account: acct("andi") }, m.keys.andi!.secretKey);
    if (mine.kind !== "bundle") throw new Error("must be a bundle");
    expect(preview.json.bundle.termsHash).toBe(mine.terms_hash);
    const accepted = await m.post(`/listings/${hash}/offers/${offered.json.offerHash}/accept`, { account: acct("andi"), signature: mine.signature.signature });
    expect(accepted.status).toBe(201);
    expect(accepted.json.match).toMatchObject({ searcher: acct("citra"), searcherValue: C(3) });
    expect(accepted.json.result.proposal.participants.sort()).toEqual([acct("andi"), acct("budi"), acct("citra")]);
  });

  it("rejections when creating a referral", async () => {
    const { m, l, body } = await setup();
    const post = (b: unknown) => m.post("/referrals", b);
    const code = async (b: unknown) => (await post(b)).json.error?.code;
    expect(await code({ referral: referral("citra", "budi", l), signature: signedReferral(m, "dewi", "budi", l).signature })).toBe("invalid_signature");
    expect(await code(signedReferral(m, "citra", "gita", l))).toBe("member_not_active");
    expect(await code({ ...signedReferral(m, "citra", "zed", l) })).toBe("member_not_found");
    expect((await post({ referral: { ...referral("citra", "budi", l), circle: "other.near" }, signature: "ed25519:x" })).status).toBe(400);
    expect(await code(signedReferral(m, "citra", "budi", l, { expires_at: NOW_S - 1 }))).toBe("invalid_request");
    expect(await code(signedReferral(m, "citra", "budi", l, { searcher_share_bps: 1001 }))).toBe("invalid_request"); // above the 10% discount
    expect(await code(signedReferral(m, "citra", "andi", l))).toBe("invalid_request"); // to the lister of the listing
    expect(await code(signedReferral(m, "andi", "budi", l))).toBe("invalid_request"); // the seeker is the lister
    expect(await code(signedReferral(m, "citra", "budi", { ...l, nonce: "other" }))).toBe("listing_not_found");
    expect((await post({})).status).toBe(400);
    // the listing is not discoverable, does not accept payment, or is no longer open
    const closed = signedListing(m, "andi", { nonce: "closed", discoverable: false });
    await m.post("/listings", closed);
    expect(await code(signedReferral(m, "citra", "budi", closed.listing))).toBe("invalid_request");
    const noPay = signedListing(m, "andi", { nonce: "nopay", accept_payment: false });
    await m.post("/listings", noPay);
    expect(await code(signedReferral(m, "citra", "budi", noPay.listing, { mode: "pay" }))).toBe("invalid_request");
    await m.post(`/listings/${listingHash(body.listing)}/cancel`, { signature: signCancelListing(body.listing, m.keys.andi!.secretKey) });
    expect(await code(signedReferral(m, "citra", "budi", l))).toBe("listing_not_open");
  });

  it("spam guard: one pending referral per pair, inbox limit, expired referrals disappear", async () => {
    const { m, l } = await setup({ maxReferrals: 2 });
    const one = await m.post("/referrals", signedReferral(m, "citra", "budi", l));
    expect(one.status).toBe(201);
    const dup = await m.post("/referrals", signedReferral(m, "citra", "budi", l, { nonce: "r2" }));
    expect([dup.status, dup.json.error.code]).toEqual([409, "already_exists"]);
    const l2 = signedListing(m, "andi", { nonce: "l2" });
    const l3 = signedListing(m, "andi", { nonce: "l3" });
    await m.post("/listings", l2);
    await m.post("/listings", l3);
    expect((await m.post("/referrals", signedReferral(m, "citra", "budi", l2.listing))).status).toBe(201);
    const full = await m.post("/referrals", signedReferral(m, "dewi", "budi", l3.listing));
    expect([full.status, full.json.error.code]).toEqual([429, "rate_limited"]);
    // expired: disappears from the inbox and does not count towards the limit
    m.clock.now += 3601 * 1000;
    expect((await m.get(`/referrals?account=${acct("budi")}`)).json.items).toEqual([]);
    expect((await m.get(`/referrals?account=${acct("budi")}&status=expired`)).json.items).toHaveLength(2);
  });

  it("the target agent refuses with a signature; that pair is not invited again", async () => {
    const { m, l } = await setup();
    const sent = signedReferral(m, "citra", "budi", l);
    const hash = (await m.post("/referrals", sent)).json.referralHash;
    expect((await m.post(`/referrals/${hash}/refuse`, { signature: signRefuseReferral(hash, "x207-circle.near", m.keys.dewi!.secretKey) })).json.error.code).toBe("invalid_signature");
    expect((await m.post(`/referrals/${hash}/refuse`, {})).status).toBe(400);
    const refused = await m.post(`/referrals/${hash}/refuse`, { signature: signRefuseReferral(hash, "x207-circle.near", m.keys.budi!.secretKey) });
    expect(refused.json.status).toBe("refused");
    expect((await m.post(`/referrals/${hash}/refuse`, { signature: signRefuseReferral(hash, "x207-circle.near", m.keys.budi!.secretKey) })).json.error.code).toBe("referral_not_open");
    const again = await m.post("/referrals", signedReferral(m, "citra", "budi", l, { nonce: "r9" }));
    expect([again.status, again.json.error.code]).toEqual([409, "referral_refused"]);
    expect((await m.post(`/referrals/${"0".repeat(64)}/refuse`, { signature: "x" })).json.error.code).toBe("referral_not_found");
    // another seeker may still invite that pair
    expect((await m.post("/referrals", signedReferral(m, "dewi", "budi", l))).status).toBe(201);
  });

  it("an offer that references a referral must match: another agent, different content, round 2, already taken, expired", async () => {
    const { m, l, hash } = await setup();
    const a = (await m.post("/referrals", signedReferral(m, "citra", "budi", l))).json.referralHash;
    const offerTo = (name: string, over = {}) => bid(m, name, l, { mode: "barter", value: C(100), ...over });
    expect((await m.post(`/listings/${hash}/offers`, { ...offerTo("dewi"), referralHash: a })).json.error.message).toContain("another agent");
    expect((await m.post(`/listings/${hash}/offers`, { ...offerTo("budi", { value: C(90) }), referralHash: a })).json.error.message).toContain("must match the referral");
    expect((await m.post(`/listings/${hash}/offers`, { ...offerTo("budi"), referralHash: "z" })).status).toBe(400);
    expect((await m.post(`/listings/${hash}/offers`, { ...offerTo("budi"), referralHash: "f".repeat(64) })).json.error.code).toBe("referral_not_found");
    expect((await m.post(`/listings/${hash}/offers`, { ...offerTo("budi"), referralHash: a })).status).toBe(201);
    // already taken
    const l2 = signedListing(m, "andi", { nonce: "l2" });
    await m.post("/listings", l2);
    const r2 = (await m.post("/referrals", signedReferral(m, "citra", "dewi", l2.listing))).json.referralHash;
    m.clock.now += 3601 * 1000;
    const late = bid(m, "dewi", l2.listing, { mode: "barter", value: C(100) });
    // server clock moves ahead: the listing is still open (24 hours) but the referral has passed
    expect((await m.post(`/listings/${listingHash(l2.listing)}/offers`, { ...late, referralHash: r2 })).json.error.code).toBe("referral_not_open");
  });

  it("migration 1105 adds a column without changing old offers", async () => {
    const { default: Database } = await import("better-sqlite3");
    const { migrate } = await import("../../src/db/migrate.js");
    const { MARKETPLACE_MIGRATIONS } = await import("../../src/marketplace/migrations.js");
    const db = new Database(":memory:");
    migrate(db);
    migrate(db, MARKETPLACE_MIGRATIONS.filter((x) => x.version <= 1104));
    db.prepare("INSERT INTO offers (circle_id, offer_hash, listing_hash, proposer, counterparty, awaiting, round, mode, value, quantity, deliver_by, signature, created_at_ms) VALUES ('c','o','l','p','p','a',1,'pay','1',1,1,'s',1)").run();
    expect(migrate(db, MARKETPLACE_MIGRATIONS)).toEqual(MARKETPLACE_MIGRATIONS.map((m) => m.version).filter((v) => v >= 1105));
    expect(db.prepare("SELECT offer_hash, referral_hash FROM offers").all()).toEqual([{ offer_hash: "o", referral_hash: null }]);
    db.close();
  });
});
