import { afterEach, describe, expect, it } from "vitest";
import { buildAssetTemplate, type AssetInput } from "@x207/core";
import { CATALOG, CATALOG_MISSING } from "../helpers/asset-catalog.js";
import { ESCROW_ASSET_TYPES } from "../../src/marketplace/listing-scope.js";
import { CIRCLE, NOW_S, signedListing, startMarket, type Market } from "./helpers.js";

const C = (n: number): string => (BigInt(n) * 1_000_000n).toString();
let nonce = 0;
const PRICE = C(100);

if (CATALOG_MISSING) it.skip(`BE-049 listing validation ${CATALOG_MISSING}`, () => {});

describe.skipIf(CATALOG_MISSING)("BE-049 validation of a listing per kind of asset (catalogue #1 to #10)", () => {
  let market: Market | undefined;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });

  async function start(options: Parameters<typeof startMarket>[3] = { rwaWhitelist: ["rwa.token.near"] }) {
    market = await startMarket(["andi", "budi"], [], undefined, options);
    for (const e of CATALOG.filter((c: { cls: string }) => c.cls === "A")) {
      market.db.prepare("INSERT INTO asset_classes (circle_id, asset_type, class, block_height, receipt_id, log_index) VALUES (?, ?, 'A', 1, 'r', 0)").run(CIRCLE, e.assetType);
    }
    market.db.prepare("INSERT INTO asset_classes (circle_id, asset_type, class, block_height, receipt_id, log_index) VALUES (?, 'saas:team-seat-a', 'B', 1, 'r', 0)").run(CIRCLE);
    return market;
  }

  const expiresAt = NOW_S + 3600;
  const common = { unitPrice: PRICE, expiresAt };
  /** The inputs of the SDK, one per kind, valid at `NOW_S`. */
  const inputs: Record<string, AssetInput> = {
    nft: { kind: "nft", name: "Art", nftContract: "art.near", tokenId: "42", ...common },
    ticket: { kind: "ticket", event: { name: "Conf", startsAt: NOW_S + 7200, endsAt: NOW_S + 10_000 }, nftContract: "tix.near", tokenId: "A1", ...common },
    "game-item": { kind: "game-item", game: { name: "Chain Quest", collection: "weapons" }, nftContract: "game.near", tokenId: "sword-7", ...common },
    coupon: { kind: "coupon", description: "10 percent off", validUntil: NOW_S + 5000, nftContract: "cpn.near", tokenId: "c1", ...common },
    license: { kind: "license", product: "Studio", termsHash: "ab".repeat(32), seats: 3, nftContract: "lic.near", tokenId: "seat-1", ...common },
    ft: { kind: "ft", ftContract: "usdc.token.near", amount: "1000000", decimals: 6, symbol: "USDC", ...common },
    rwa: { kind: "rwa", ftContract: "rwa.token.near", amount: "5000", decimals: 6, symbol: "BOND", whitelist: { circleContract: true, grantor: true }, ...common },
    lst: { kind: "lst", ftContract: "meta-pool.near", amount: "340282366920938463463374607431768211455", decimals: 24, symbol: "stNEAR", rate: { nearPerToken: "1.07", source: "pool", asOf: NOW_S - 60 }, ...common },
    "intents-balance": { kind: "intents-balance", mtContract: "intents.near", tokenId: "nep141:usdc.near", amount: "250", ...common },
    "pool-share-ft": { kind: "pool-share", pool: "wNEAR-USDC", standard: "nep141", ftContract: "lp.near", amount: "99", decimals: 18, symbol: "LP", ...common },
    "pool-share-mt": { kind: "pool-share", pool: "wNEAR-USDC", standard: "nep245", mtContract: "amm.near", tokenId: "pool-3", amount: "99", ...common },
  };

  const post = (m: Market, over: { assetType: string; detail: string; assetClass?: string; quantity?: number; expiresAt?: number }) =>
    m.post("/listings", signedListing(m, "andi", {
      offer: { asset_type: over.assetType, asset_class: (over.assetClass ?? "A") as "A", quantity: over.quantity ?? 1, value: PRICE },
      detail: over.detail, expires_at: over.expiresAt ?? expiresAt, nonce: `n${++nonce}`,
    }));
  /** The listing exactly as the SDK would build it from `input`. */
  const fromTemplate = (m: Market, key: string, patch: (detail: Record<string, unknown>) => Record<string, unknown> = (d) => d, over: { expiresAt?: number } = {}) => {
    const t = buildAssetTemplate(inputs[key]!, NOW_S);
    return post(m, { assetType: t.assetType, detail: JSON.stringify(patch(JSON.parse(t.detail))), ...(over.expiresAt !== undefined ? { expiresAt: over.expiresAt } : { expiresAt: t.grantInput.limits.expires_at ? Number(BigInt(t.grantInput.limits.expires_at) / 1_000_000_000n) : expiresAt }) });
  };
  const message = (r: { status: number; json: any }) => [r.status, r.json.error?.code, r.json.error?.message as string];

  it("TC-BE-049-00 the table of asset types is the registry D10: same names, same delivery methods", () => {
    const escrow = CATALOG.filter((c: { delivery: string[]; cls: string }) => c.delivery.some((d) => d.startsWith("escrow_") && ["escrow_nft", "escrow_ft", "escrow_mt"].includes(d)) && c.cls === "A");
    expect(escrow.map((c: { assetType: string }) => c.assetType).sort()).toEqual(Object.keys(ESCROW_ASSET_TYPES).sort());
    for (const c of escrow as Array<{ assetType: string; delivery: string[] }>) expect(ESCROW_ASSET_TYPES[c.assetType]!.delivery, c.assetType).toEqual(c.delivery);
  });

  it("TC-BE-049-01 the listing that the SDK builds for each of the ten kinds is accepted (nft, ticket, game item, coupon, license, ft, rwa, lst, Intents balance, pool share as ft and as mt)", async () => {
    const m = await start();
    for (const key of Object.keys(inputs)) {
      const r = await fromTemplate(m, key);
      expect([key, r.status, r.json.error?.message]).toEqual([key, 201, undefined]);
    }
  });

  it("TC-BE-049-02 the scope must be exactly what the escrow takes: a key missing, of another shape, or badly formed is refused", async () => {
    const m = await start();
    const cases: Array<[string, (d: Record<string, unknown>) => Record<string, unknown>, RegExp]> = [
      ["nft", ({ token_id: _t, ...d }) => d, /must contain exactly nft_contract, token_id/],
      ["nft", (d) => ({ ...d, amount: "1" }), /must contain exactly nft_contract, token_id/],
      ["nft", (d) => ({ ...d, nft_contract: "Bad Name" }), /account id/],
      ["nft", (d) => ({ ...d, token_id: "" }), /token_id/],
      ["ft", (d) => ({ ...d, amount: "0" }), /amount/],
      ["ft", (d) => ({ ...d, amount: 5 }), /amount/],
      ["ft", (d) => ({ ...d, amount: "-1" }), /amount/],
      ["ft", (d) => ({ ...d, amount: "1.5" }), /amount/],
      ["ft", (d) => ({ ...d, amount: "340282366920938463463374607431768211456" }), /u128/],
      ["ft", (d) => ({ ...d, nft_contract: "n.near" }), /must contain exactly ft_contract, amount/],
      ["intents-balance", ({ amount: _a, ...d }) => d, /must contain exactly mt_contract, token_id, amount/],
      ["intents-balance", (d) => ({ ...d, ft_contract: "f.near" }), /must contain exactly mt_contract, token_id, amount/],
      ["nft", (d) => ({ ...d, kind: "ft" }), /detail.kind/],
    ];
    for (const [key, patch, pattern] of cases) {
      const r = await fromTemplate(m, key, patch);
      expect([key, r.status, r.json.error?.code]).toEqual([key, 400, "scope_invalid"]);
      expect(r.json.error.message, key).toMatch(pattern);
    }
    // a detail that is not JSON, or not an object
    for (const detail of ["not json", "[1]", "null"]) expect(message(await post(m, { assetType: "nft:nep171", detail }))[1]).toBe("scope_invalid");
  });

  it("TC-BE-049-03 the display keys are not checked: whatever the SDK puts next to the scope does not matter", async () => {
    const m = await start();
    const r = await fromTemplate(m, "ft", (d) => ({ ...d, decimals: 99, symbol: "ANY", display: "ten thousand", extra: { x: 1 } }));
    expect(r.status).toBe(201);
  });

  it("TC-BE-049-04 class A only, one lot, and the type registered in D10 with class A", async () => {
    const m = await start();
    const detail = buildAssetTemplate(inputs.ft!, NOW_S).detail;
    expect(message(await post(m, { assetType: "token:nep141", detail, assetClass: "B" }))[2]).toContain("must be A");
    expect(message(await post(m, { assetType: "token:nep141", detail, quantity: 2 }))[2]).toContain("quantity must be 1");
    m.db.prepare("DELETE FROM asset_classes WHERE asset_type = 'token:nep141'").run();
    expect(message(await post(m, { assetType: "token:nep141", detail }))[2]).toContain("is not registered");
    m.db.prepare("INSERT INTO asset_classes (circle_id, asset_type, class, block_height, receipt_id, log_index) VALUES (?, 'token:nep141', 'B', 1, 'r', 0)").run(CIRCLE);
    expect(message(await post(m, { assetType: "token:nep141", detail }))[2]).toContain("class B");
  });

  it("TC-BE-049-05 a ticket ends with its event and a coupon with its validity; the listing may not outlive them", async () => {
    const m = await start();
    const eventEnds = (ends: number) => (d: Record<string, unknown>) => ({ ...d, event: { ...(d.event as object), ends_at: ends } });
    expect(message(await fromTemplate(m, "ticket", eventEnds(NOW_S + 1000), { expiresAt: NOW_S + 2000 }))[2]).toContain("event.ends_at");
    expect(message(await fromTemplate(m, "ticket", eventEnds(NOW_S - 5)))[2]).toContain("already passed");
    // the SDK writes the end of the event in `event.ends_at` and, in newer versions, in `valid_until` too: remove both
    const noEvent = await fromTemplate(m, "ticket", ({ event: _e, valid_until: _v, ...d }) => d);
    expect(message(noEvent)[2]).toContain("event.ends_at or valid_until");
    expect((await fromTemplate(m, "ticket", eventEnds(NOW_S + 1000), { expiresAt: NOW_S + 1000 })).status).toBe(201);
    expect(message(await fromTemplate(m, "coupon", ({ valid_until: _v, ...d }) => d))[2]).toContain("valid_until");
    expect(message(await fromTemplate(m, "coupon", (d) => ({ ...d, valid_until: "soon" })))[2]).toContain("valid_until");
    expect(message(await fromTemplate(m, "coupon", (d) => ({ ...d, valid_until: NOW_S + 100 }), { expiresAt: NOW_S + 3000 }))[2]).toContain("must not be after valid_until");
    expect(message(await fromTemplate(m, "coupon", (d) => ({ ...d, valid_until: NOW_S - 1 })))[2]).toContain("already passed");
  });

  it("TC-BE-049-06 a license keeps its terms hash and seats well formed", async () => {
    const m = await start();
    expect(message(await fromTemplate(m, "license", (d) => ({ ...d, terms_hash: "XYZ" })))[2]).toContain("terms_hash");
    expect(message(await fromTemplate(m, "license", (d) => ({ ...d, seats: 0 })))[2]).toContain("seats");
  });

  it("TC-BE-049-07 a real-world-asset token must be whitelisted by the circle; with no whitelist every such listing is refused; other tokens need none", async () => {
    const m = await start({ rwaWhitelist: ["rwa.token.near"] });
    expect((await fromTemplate(m, "rwa")).status).toBe(201);
    const scam = await fromTemplate(m, "rwa", (d) => ({ ...d, ft_contract: "scam.near" }));
    expect([scam.status, scam.json.error.code, scam.json.error.details.ftContract]).toEqual([400, "scope_invalid", "scam.near"]);
    expect((await fromTemplate(m, "ft", (d) => ({ ...d, ft_contract: "scam.near" }))).status).toBe(201);
    expect((await fromTemplate(m, "lst", (d) => ({ ...d, ft_contract: "scam.near" }))).status).toBe(201);
    await market?.srv.close();
    const none = await start({});
    expect((await fromTemplate(none, "rwa")).status).toBe(400);
  });

  it("TC-BE-049-08 the USDT of the circle held at Intents is refused; another token held there is accepted", async () => {
    const m = await start({ intentsId: "intents.near", usdtTokenId: "usdt.token.near" });
    const usdt = await fromTemplate(m, "intents-balance", (d) => ({ ...d, token_id: "nep141:usdt.token.near" }));
    expect([usdt.status, usdt.json.error.code, usdt.json.error.message]).toEqual([400, "scope_invalid", expect.stringContaining("not an escrow asset")]);
    expect((await fromTemplate(m, "intents-balance")).status).toBe(201);
    expect((await fromTemplate(m, "intents-balance", (d) => ({ ...d, mt_contract: "other.near", token_id: "nep141:usdt.token.near" }))).status).toBe(201);
  });

  it("TC-BE-049-08b the USDT of the circle as a NEP-141 token (ft, lst, pool share) is refused, since the contract refuses its deposit", async () => {
    const m = await start({ intentsId: "intents.near", usdtTokenId: "usdt.token.near" });
    for (const key of ["ft", "lst", "pool-share-ft"]) {
      const r = await fromTemplate(m, key, (d) => ({ ...d, ft_contract: "usdt.token.near" }));
      expect([key, r.status, r.json.error?.code, r.json.error?.message]).toEqual([key, 400, "scope_invalid", expect.stringContaining("ERR_ESCROW_USDT")]);
    }
    expect((await fromTemplate(m, "ft")).status).toBe(201);
  });

  it("TC-BE-049-09 a pool share is told apart by its keys; a detail with both kinds of keys is refused", async () => {
    const m = await start();
    expect((await fromTemplate(m, "pool-share-ft")).status).toBe(201);
    expect((await fromTemplate(m, "pool-share-mt")).status).toBe(201);
    const both = await fromTemplate(m, "pool-share-ft", (d) => ({ ...d, mt_contract: "m.near", token_id: "t" }));
    expect(both.json.error.code).toBe("scope_invalid");
    expect(message(await post(m, { assetType: "amm:lp-share", detail: JSON.stringify({ pool: "x" }) }))[2]).toContain("ft_contract or mt_contract");
  });

  it("TC-BE-049-10 other asset types are not looked at, and a typed name from the old convention (nft:*) is an ordinary type again", async () => {
    const m = await start();
    expect((await post(m, { assetType: "compute:gpu-h100", detail: "A100 80GB", assetClass: "D" })).status).toBe(201);
    expect((await post(m, { assetType: "nft:near.example", detail: "free text" })).status).toBe(201);
  });
});
