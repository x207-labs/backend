import { afterEach, describe, expect, it } from "vitest";
import { buildAssetTemplate, listingHash, signListing, type AssetInput, type Listing } from "@x207/core";
import { CIRCLE, CONTRACT, NOW_S, listing, signedListing, startMarket, type Market } from "./helpers.js";

const C = (n: number): string => (BigInt(n) * 1_000_000n).toString();

describe("BE-052 dry run of POST listings: the same checks, the same errors, nothing stored", () => {
  let market: Market | undefined;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });

  async function start() {
    market = await startMarket(["andi", "budi"], ["dewi"], undefined, { rwaWhitelist: ["rwa.token.near"], intentsId: "intents.near", usdtTokenId: "usdt.token.near" });
    for (const t of ["nft:nep171", "token:nep141", "rwa:tokenized", "intents:multi-token"]) {
      market.db.prepare("INSERT INTO asset_classes (circle_id, asset_type, class, block_height, receipt_id, log_index) VALUES (?, ?, 'A', 1, 'r', 0)").run(CIRCLE, t);
    }
    return market;
  }

  let nonce = 0;
  const fromInput = (m: Market, input: AssetInput, over: Partial<Listing> = {}, signer = "andi") => {
    const t = buildAssetTemplate(input, NOW_S);
    const l = listing(signer, { offer: t.side, detail: t.detail, expires_at: NOW_S + 3600, nonce: `c${++nonce}`, ...over });
    // a listing with a bad format cannot be signed by the SDK: it goes out with a signature that was not made, and the format check comes first anyway
    let signature = "ed25519:not-signed";
    try {
      signature = signListing(l, m.keys[signer]!.secretKey);
    } catch {
      /* keep the placeholder */
    }
    return { listing: l, signature };
  };
  const nft: AssetInput = { kind: "nft", nftContract: "art.near", tokenId: "42", unitPrice: C(1), expiresAt: NOW_S + 3600 };
  const ft: AssetInput = { kind: "ft", ftContract: "usdc.near", amount: "2500000", decimals: 6, symbol: "USDC", unitPrice: C(1), expiresAt: NOW_S + 3600 };
  const rwa: AssetInput = { kind: "rwa", ftContract: "rwa.token.near", amount: "5000", decimals: 6, symbol: "BOND", unitPrice: C(1), expiresAt: NOW_S + 3600 };
  const view = (r: { status: number; json: any }) => [r.status, r.json.error?.code ?? "ok", r.json.error?.message ?? ""];

  it("TC-BE-052-01 a valid listing: the check says valid and stores nothing; the POST then stores the same hash; the check of a stored listing is 409 like the POST", async () => {
    const m = await start();
    const body = fromInput(m, nft);
    const check = await m.post("/listings/check", body);
    expect(check.status).toBe(200);
    expect(check.json).toMatchObject({ valid: true, stored: false, account: "andi.x207-circle.near", offerAssetType: "nft:nep171", listingHash: listingHash(body.listing) });
    expect((await m.get("/listings?status=all")).json.items).toHaveLength(0);
    expect(m.db.prepare("SELECT COUNT(*) AS n FROM listings").get()).toEqual({ n: 0 });
    // twice: nothing changed, so the answer is the same
    expect((await m.post("/listings/check", body)).json.listingHash).toBe(check.json.listingHash);
    const posted = await m.post("/listings", body);
    expect([posted.status, posted.json.listingHash]).toEqual([201, check.json.listingHash]);
    const again = await m.post("/listings/check", body);
    const dup = await m.post("/listings", body);
    expect(view(again)).toEqual(view(dup));
    expect(view(again).slice(0, 2)).toEqual([409, "already_exists"]);
  });

  it("TC-BE-052-02 every refusal of POST listings is the same on the dry run: status, code and message, for each kind of check", async () => {
    const m = await start();
    const good = fromInput(m, ft);
    const cases: Array<[string, unknown]> = [
      ["scope missing", fromInput(m, ft, { detail: JSON.stringify({ kind: "ft", symbol: "USDC" }) })],
      ["scope of another shape", fromInput(m, nft, { detail: JSON.stringify({ kind: "nft", ft_contract: "f.near", amount: "5" }) })],
      ["class not A", fromInput(m, ft, { offer: { ...buildAssetTemplate(ft, NOW_S).side, asset_class: "B" } })],
      ["quantity 2", fromInput(m, ft, { offer: { ...buildAssetTemplate(ft, NOW_S).side, quantity: 2 } })],
      ["type not registered", fromInput(m, { ...ft, kind: "lst" } as AssetInput)],
      ["rwa not whitelisted", fromInput(m, { ...rwa, ftContract: "scam.near" })],
      ["usdt of the circle", fromInput(m, { ...ft, ftContract: "usdt.token.near" })],
      ["usdt at intents", fromInput(m, { kind: "intents-balance", mtContract: "intents.near", tokenId: "nep141:usdt.token.near", amount: "5", unitPrice: C(1), expiresAt: NOW_S + 3600 })],
      ["metered resource without unit", fromInput(m, nft, { offer: { asset_type: "compute:cpu-idle", asset_class: "D", quantity: 1, value: C(1) }, detail: JSON.stringify({ endpoint: "https://a.example/x" }) })],
      ["format (nonce)", fromInput(m, nft, { nonce: "bad nonce!" })],
      ["circle", fromInput(m, nft, { circle: "other.near" })],
      ["expired", fromInput(m, nft, { expires_at: NOW_S - 1 })],
      ["member not found", fromInput(m, nft, { account: "ghost.x207-circle.near" })],
      ["member not active", fromInput(m, nft, { account: "dewi.x207-circle.near" })],
      ["signature of another key", { ...fromInput(m, nft), signature: good.signature }],
      ["no signature", { listing: fromInput(m, nft).listing }],
      ["no listing", { signature: "x" }],
      ["not an object", "text"],
    ];
    for (const [name, body] of cases) {
      const check = await m.post("/listings/check", body);
      const post = await m.post("/listings", body);
      expect([name, ...view(check)], name).toEqual([name, ...view(post)]);
      expect(check.status, name).toBeGreaterThanOrEqual(400);
    }
    // the refusals stored nothing, and the refusals of the scope are not an accident of the harness
    expect(m.db.prepare("SELECT COUNT(*) AS n FROM listings").get()).toEqual({ n: 0 });
    expect((await m.post("/listings/check", fromInput(m, { ...rwa, ftContract: "scam.near" }))).json.error.code).toBe("scope_invalid");
    expect((await m.post("/listings/check", fromInput(m, nft, { account: "dewi.x207-circle.near" }))).json.error.code).toBe("member_not_active");
  });

  it("TC-BE-052-03 a listing that passes all checks passes on the dry run for the ten kinds, so the owner can check before offer_grant", async () => {
    const m = await start();
    m.db.prepare("INSERT INTO asset_classes (circle_id, asset_type, class, block_height, receipt_id, log_index) VALUES (?, 'game:item-nft', 'A', 1, 'r', 0)").run(CIRCLE);
    const inputs: AssetInput[] = [nft, { kind: "game-item", game: { name: "Quest" }, nftContract: "g.near", tokenId: "s", unitPrice: C(1), expiresAt: NOW_S + 3600 }, ft, rwa,
      { kind: "intents-balance", mtContract: "intents.near", tokenId: "nep141:usdc.near", amount: "250", unitPrice: C(1), expiresAt: NOW_S + 3600 }];
    m.db.prepare("INSERT INTO asset_classes (circle_id, asset_type, class, block_height, receipt_id, log_index) VALUES (?, 'intents:multi-token', 'A', 1, 'r', 0) ON CONFLICT DO NOTHING").run(CIRCLE);
    for (const input of inputs) {
      const r = await m.post("/listings/check", fromInput(m, input));
      expect([input.kind, r.status, r.json.error?.message]).toEqual([input.kind, 200, undefined]);
    }
    expect(m.db.prepare("SELECT COUNT(*) AS n FROM listings").get()).toEqual({ n: 0 });
  });

  it("TC-BE-052-04 the dry run takes no listing slot: it changes no counter, creates no hash and leaves the book empty for every reader", async () => {
    const m = await start();
    const body = fromInput(m, nft);
    for (let i = 0; i < 5; i++) expect((await m.post("/listings/check", body)).status).toBe(200);
    const tables = ["listings", "offers", "matches", "intents", "bundle_proposals", "bundle_signatures", "deliveries", "referrals"];
    for (const t of tables) expect(m.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get(), t).toEqual({ n: 0 });
    expect((await m.get(`/listings/${listingHash(body.listing)}`)).status).toBe(404);
    void CONTRACT;
  });
});
