import { afterEach, describe, expect, it } from "vitest";
import { CIRCLE, listing, startMarket, type Market } from "./helpers.js";

describe("BE-042 asset_type bebas dan kelas A/B/C/D", () => {
  let market: Market | undefined;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });

  const typed = (assetType: string, assetClass: string) => ({ asset_type: assetType, asset_class: assetClass as "A", quantity: 1, value: "1000000" });

  it("aset beragam dengan kelas sah diterima, bentuk apa pun", async () => {
    market = await startMarket();
    const m = market;
    const { signListing } = await import("@x207/core");
    const cases: Array<[string, string]> = [["compute:gpu-h100", "D"], ["dataset.weather-2026", "C"], ["nft:near.example", "A"], ["access:github-seat", "B"]];
    // since BE-049 an `nft:` listing names its escrow: the type is registered in D10 and `detail` carries the scope
    m.db.prepare("INSERT INTO asset_classes (circle_id, asset_type, class, block_height, receipt_id, log_index) VALUES (?, 'nft:near.example', 'A', 1, 'r', 0)").run(CIRCLE);
    for (const [type, cls] of cases) {
      const detail = type.startsWith("nft:") ? JSON.stringify({ scope: { nft_contract: "example.near", token_id: "1" } }) : undefined;
      const l = listing("andi", { offer: { ...typed(type, cls), quantity: 1 }, nonce: `n-${cls}`, ...(detail ? { detail } : {}) });
      const res = await m.post("/listings", { listing: l, signature: signListing(l, m.keys.andi!.secretKey) });
      expect(res.status, `${type}/${cls}`).toBe(201);
      expect(res.json.offer).toMatchObject({ assetType: type, assetClass: cls });
    }
    expect((await m.get("/listings")).json.items).toHaveLength(4);
  });

  it("kelas X ditolak dengan error jelas di offer maupun want", async () => {
    market = await startMarket();
    const m = market;
    for (const side of ["offer", "want"] as const) {
      const res = await m.post("/listings", { listing: listing("andi", { [side]: typed("netflix-family-plan", "X") }), signature: "ed25519:x" });
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe("asset_class_rejected");
      expect(res.json.error.details).toMatchObject({ side, assetClass: "X", allowed: ["A", "B", "C", "D"] });
      expect(res.json.error.message).toContain("kelas X");
    }
    expect((await m.get("/listings?status=all")).json.items).toHaveLength(0);
  });

  it("kelas tidak dikenal juga ditolak; asset_type berformat salah tetap invalid_request", async () => {
    market = await startMarket();
    const m = market;
    const unknown = await m.post("/listings", { listing: listing("andi", { offer: typed("x", "Z") }), signature: "ed25519:x" });
    expect([unknown.status, unknown.json.error.code]).toEqual([400, "asset_class_rejected"]);
    const badType = await m.post("/listings", { listing: listing("andi", { offer: typed("Bad Type", "A") }), signature: "ed25519:x" });
    expect([badType.status, badType.json.error.code]).toEqual([400, "invalid_request"]);
  });

  it("GET asset-classes menampilkan daftar lokal", async () => {
    market = await startMarket();
    const res = await market.get("/marketplace/asset-classes");
    expect(res.status).toBe(200);
    expect(res.json.items.map((i: any) => i.class)).toEqual(["A", "B", "C", "D"]);
    expect(res.json).toMatchObject({ source: "local", rejected: ["X"] });
  });
});
