import { afterEach, describe, expect, it } from "vitest";
import { acct, CIRCLE, NOW_S, signedListing, startMarket, type Market } from "./helpers.js";

const C = (n: number): string => (BigInt(n) * 1_000_000n).toString();
let nonce = 0;
const scopeJson = (scope: object, extra: object = {}): string => JSON.stringify({ scope, ...extra });

describe("BE-049 validation of a listing per kind of asset (catalogue #1 to #10)", () => {
  let market: Market | undefined;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });

  async function start(options: Parameters<typeof startMarket>[4] = { rwaWhitelist: ["rwa.token.near"] }) {
    market = await startMarket(["andi", "budi"], [], undefined, options);
    const m = market;
    for (const t of ["nft:ticket", "nft:game-item", "nft:coupon", "nft:license", "nft:art", "ft:usdc", "lst:stnear", "rwa:bond", "mt:usdc", "mt:lp-share", "mt:intents-usdt"]) {
      m.db.prepare("INSERT INTO asset_classes (circle_id, asset_type, class, block_height, receipt_id, log_index) VALUES (?, ?, 'A', 1, 'r', 0)").run(CIRCLE, t);
    }
    m.db.prepare("INSERT INTO asset_classes (circle_id, asset_type, class, block_height, receipt_id, log_index) VALUES (?, 'ft:rented', 'B', 1, 'r', 0)").run(CIRCLE);
    return m;
  }

  const post = (m: Market, assetType: string, detail: string, over: { quantity?: number; assetClass?: string; expiresAt?: number } = {}) =>
    m.post("/listings", signedListing(m, "andi", {
      offer: { asset_type: assetType, asset_class: (over.assetClass ?? "A") as "A", quantity: over.quantity ?? 1, value: C(100) },
      detail, ...(over.expiresAt !== undefined ? { expires_at: over.expiresAt } : {}), nonce: `n${++nonce}`,
    }));
  const reason = (r: { status: number; json: any }) => [r.status, r.json.error?.code, r.json.error?.message as string];

  it("TC-BE-049-01 each kind with the exact scope of its escrow is accepted", async () => {
    const m = await start();
    const valid = NOW_S + 50_000;
    const cases: Array<[string, string]> = [
      ["nft:art", scopeJson({ nft_contract: "art.near", token_id: "42" })],
      ["nft:game-item", scopeJson({ nft_contract: "game.near", token_id: "sword-7" })],
      ["nft:license", scopeJson({ nft_contract: "lic.near", token_id: "seat-1" })],
      ["ft:usdc", scopeJson({ ft_contract: "usdc.token.near", amount: "1000000" })],
      ["lst:stnear", scopeJson({ ft_contract: "meta-pool.near", amount: "340282366920938463463374607431768211455" })],
      ["rwa:bond", scopeJson({ ft_contract: "rwa.token.near", amount: "5000" })],
      ["mt:usdc", scopeJson({ mt_contract: "intents.near", token_id: "nep141:usdc.near", amount: "250" })],
      ["mt:lp-share", scopeJson({ mt_contract: "amm.near", token_id: "pool-3", amount: "99" })],
      ["nft:ticket", scopeJson({ nft_contract: "tix.near", token_id: "A12" }, { valid_until: valid })],
      ["nft:coupon", scopeJson({ nft_contract: "cpn.near", token_id: "c1" }, { valid_until: valid })],
    ];
    for (const [type, detail] of cases) {
      const r = await post(m, type, detail, { expiresAt: NOW_S + 3600 });
      expect([type, r.status]).toEqual([type, 201]);
    }
  });

  it("TC-BE-049-02 the scope must be exactly what the escrow takes: missing, extra and badly formed fields are refused", async () => {
    const m = await start();
    const bad: Array<[string, string, RegExp]> = [
      ["nft:art", "not json", /JSON/],
      ["nft:art", "[1]", /objek JSON/],
      ["nft:art", JSON.stringify({ scope: { nft_contract: "art.near" } }), /tepat nft_contract, token_id/],
      ["nft:art", JSON.stringify({ scope: { nft_contract: "art.near", token_id: "1", amount: "1" } }), /tepat nft_contract, token_id/],
      ["nft:art", JSON.stringify({ scope: { nft_contract: "Bad Name", token_id: "1" } }), /account id/],
      ["nft:art", JSON.stringify({ scope: { nft_contract: "art.near", token_id: "" } }), /token_id/],
      ["nft:art", JSON.stringify({ scope: { nft_contract: "art.near", token_id: "1" }, price: 5 }), /tidak dikenal/],
      ["ft:usdc", JSON.stringify({ scope: { ft_contract: "u.near", amount: "0" } }), /amount/],
      ["ft:usdc", JSON.stringify({ scope: { ft_contract: "u.near", amount: 5 } }), /amount/],
      ["ft:usdc", JSON.stringify({ scope: { ft_contract: "u.near", amount: "-1" } }), /amount/],
      ["ft:usdc", JSON.stringify({ scope: { ft_contract: "u.near", amount: "340282366920938463463374607431768211456" } }), /u128/],
      ["ft:usdc", JSON.stringify({ scope: { ft_contract: "u.near", amount: "1.5" } }), /amount/],
      ["ft:usdc", JSON.stringify({ scope: { ft_contract: "u.near", amount: "5", nft_contract: "n.near" } }), /tepat ft_contract, amount/],
      ["mt:usdc", JSON.stringify({ scope: { mt_contract: "m.near", token_id: "t" } }), /tepat mt_contract, token_id, amount/],
    ];
    for (const [type, detail, pattern] of bad) {
      const r = await post(m, type, detail);
      expect([type, detail.slice(0, 40), r.status, r.json.error?.code]).toEqual([type, detail.slice(0, 40), 400, "scope_invalid"]);
      expect(r.json.error.message, detail).toMatch(pattern);
    }
  });

  it("TC-BE-049-03 class A only, one lot, and the asset type must be in the registry with class A", async () => {
    const m = await start();
    const ok = scopeJson({ ft_contract: "u.near", amount: "5" });
    expect(reason(await post(m, "ft:usdc", ok, { assetClass: "B" }))[1]).toBe("scope_invalid");
    expect(reason(await post(m, "ft:usdc", ok, { quantity: 2 }))[2]).toContain("quantity harus 1");
    expect(reason(await post(m, "ft:unknown", ok))[2]).toContain("belum terdaftar");
    expect(reason(await post(m, "ft:rented", ok))[2]).toContain("kelas B");
  });

  it("TC-BE-049-04 tickets and coupons carry a time of use; the listing may not outlive it", async () => {
    const m = await start();
    const scope = { nft_contract: "tix.near", token_id: "A1" };
    expect(reason(await post(m, "nft:ticket", scopeJson(scope)))[2]).toContain("valid_until");
    expect(reason(await post(m, "nft:ticket", scopeJson(scope, { valid_until: NOW_S - 10 })))[2]).toContain("sudah lewat");
    expect(reason(await post(m, "nft:coupon", scopeJson(scope, { valid_until: "soon" })))[2]).toContain("valid_until");
    const late = await post(m, "nft:ticket", scopeJson(scope, { valid_until: NOW_S + 1000 }), { expiresAt: NOW_S + 2000 });
    expect(reason(late)[2]).toContain("melewati valid_until");
    // the listing that ends with the ticket is fine; an NFT that is not a ticket needs no valid_until, and a past one is refused when given
    expect((await post(m, "nft:ticket", scopeJson(scope, { valid_until: NOW_S + 1000 }), { expiresAt: NOW_S + 1000 })).status).toBe(201);
    expect((await post(m, "nft:art", scopeJson(scope))).status).toBe(201);
    expect((await post(m, "nft:art", scopeJson(scope, { valid_until: NOW_S - 5 }))).status).toBe(400);
  });

  it("TC-BE-049-05 a real-world-asset token must be whitelisted by the circle; with no whitelist every rwa: listing is refused", async () => {
    const m = await start({ rwaWhitelist: ["rwa.token.near"] });
    expect((await post(m, "rwa:bond", scopeJson({ ft_contract: "rwa.token.near", amount: "10" }))).status).toBe(201);
    const other = await post(m, "rwa:bond", scopeJson({ ft_contract: "scam.near", amount: "10" }));
    expect([other.status, other.json.error.code, other.json.error.details.ftContract]).toEqual([400, "scope_invalid", "scam.near"]);
    // an ordinary or liquid staking token needs no whitelist
    expect((await post(m, "ft:usdc", scopeJson({ ft_contract: "scam.near", amount: "10" }))).status).toBe(201);
    await market?.srv.close();
    const none = await start({});
    expect((await post(none, "rwa:bond", scopeJson({ ft_contract: "rwa.token.near", amount: "10" }))).status).toBe(400);
  });

  it("TC-BE-049-06 the USDT of the circle held at Intents is refused; another token held at Intents is accepted", async () => {
    const m = await start({ intentsId: "intents.near", usdtTokenId: "usdt.token.near" });
    const usdt = await post(m, "mt:intents-usdt", scopeJson({ mt_contract: "intents.near", token_id: "nep141:usdt.token.near", amount: "5" }));
    expect([usdt.status, usdt.json.error.code, usdt.json.error.message]).toEqual([400, "scope_invalid", expect.stringContaining("bukan aset escrow")]);
    expect((await post(m, "mt:usdc", scopeJson({ mt_contract: "intents.near", token_id: "nep141:usdc.near", amount: "5" }))).status).toBe(201);
    expect((await post(m, "mt:usdc", scopeJson({ mt_contract: "other.near", token_id: "nep141:usdt.token.near", amount: "5" }))).status).toBe(201);
  });

  it("TC-BE-049-07 other asset types are not looked at: a listing without a typed prefix keeps working, a bad detail on it is not a scope error", async () => {
    const m = await start();
    expect((await post(m, "gpu-hours", "A100 80GB")).status).toBe(201);
    expect((await post(m, "access:near-rpc", "not json at all")).status).toBe(201);
    void acct;
  });
});
