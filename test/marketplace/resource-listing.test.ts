import { afterEach, describe, expect, it } from "vitest";
import { CATALOG } from "../../../scripts/lib/asset-catalog.mjs";
import { endpointProblem, RESOURCE_ASSET_TYPES, RESOURCE_UNITS } from "../../src/marketplace/resource-listing.js";
import { NOW_S, signedListing, startMarket, type Market } from "./helpers.js";

const C = (n: number): string => (BigInt(n) * 1_000_000n).toString();
let nonce = 0;

describe("BE-050 listing of a metered resource (class D): unit, price per unit, endpoint, and the statistics per unit", () => {
  let market: Market | undefined;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });

  const detailOf = (over: Record<string, unknown> = {}) => JSON.stringify({ unit: "job", unit_price: C(2), endpoint: "https://api.provider.example/v1/run", ...over });
  const post = (m: Market, over: { assetType?: string; detail?: string; assetClass?: string; expiresAt?: number } = {}) =>
    m.post("/listings", signedListing(m, "andi", {
      offer: { asset_type: over.assetType ?? "compute:cpu-idle", asset_class: (over.assetClass ?? "D") as "D", quantity: 10, value: C(20) },
      detail: over.detail ?? detailOf(), expires_at: over.expiresAt ?? NOW_S + 3600, nonce: `r${++nonce}`,
    }));
  const message = (r: { status: number; json: any }) => [r.status, r.json.error?.code, r.json.error?.message as string];

  it("TC-BE-050-00 the table of the twelve kinds is the catalogue: same names, same numbers, class D", () => {
    const byNumber = Object.fromEntries((CATALOG as Array<{ no: number | string; assetType: string; cls: string }>).map((c) => [String(c.no), c]));
    for (const [assetType, no] of Object.entries(RESOURCE_ASSET_TYPES)) {
      expect(byNumber[String(no)]?.assetType, `row ${no}`).toBe(assetType);
      expect(byNumber[String(no)]?.cls, assetType).toBe("D");
    }
    expect(Object.values(RESOURCE_ASSET_TYPES).sort((a, b) => a - b)).toEqual([31, 32, 33, 34, 35, 36, 44, 45, 47, 49, 55, 90]);
  });

  it("TC-BE-050-01 every kind with a known unit, a price and an https endpoint is accepted, for each of the six units", async () => {
    market = await startMarket(["andi"]);
    for (const assetType of Object.keys(RESOURCE_ASSET_TYPES)) expect([assetType, (await post(market, { assetType })).status]).toEqual([assetType, 201]);
    for (const unit of RESOURCE_UNITS) expect([unit, (await post(market, { detail: detailOf({ unit }) })).status]).toEqual([unit, 201]);
  });

  it("TC-BE-050-02 a listing without a unit, with an unknown unit or with a bad price is refused", async () => {
    market = await startMarket(["andi"]);
    const m = market;
    expect(message(await post(m, { detail: JSON.stringify({ unit_price: C(1), endpoint: "https://a.example/x" }) }))).toEqual([400, "scope_invalid", "unit tidak dikenal"]);
    for (const unit of ["once", "GBs", "gb", "", 5, null]) expect((await post(m, { detail: detailOf({ unit }) })).json.error.message, String(unit)).toBe("unit tidak dikenal");
    for (const price of ["0", "-1", "1.5", 5, "", "abc", "340282366920938463463374607431768211456"]) {
      const r = await post(m, { detail: detailOf({ unit_price: price }) });
      expect([String(price), r.status, r.json.error.code]).toEqual([String(price), 400, "scope_invalid"]);
      expect(r.json.error.message).toContain("unit_price");
    }
    expect((await post(m, { detail: "not json" })).json.error.code).toBe("scope_invalid");
    expect((await post(m, { detail: "[1]" })).json.error.code).toBe("scope_invalid");
  });

  it("TC-BE-050-03 the endpoint is https only, without credentials, without an IP address or a private name", async () => {
    market = await startMarket(["andi"]);
    const m = market;
    const bad: Array<[string, RegExp]> = [
      ["http://api.provider.example/run", /https/],
      ["ftp://api.provider.example/run", /https/],
      ["https://user:secret@api.provider.example/run", /nama pengguna|kata sandi/],
      ["https://user@api.provider.example/run", /nama pengguna|kata sandi/],
      ["https://api.provider.example/run?api_key=abc", /kredensial/],
      ["https://api.provider.example/run?x=1&Token=abc", /kredensial/],
      ["https://api.provider.example/run#frag", /fragmen/],
      ["https://203.0.113.7/run", /alamat IP/],
      ["https://[::1]/run", /alamat IP/],
      ["https://localhost/run", /host publik/],
      ["https://box.internal/run", /host publik/],
      ["https://printer.local/run", /host publik/],
      ["https://intranet/run", /host publik/],
      ["api.provider.example/run", /bukan URL/],
      ["https://api.provider.example/run run", /ASCII/],
      ["", /endpoint/],
      [`https://api.provider.example/${"a".repeat(600)}`, /512/],
    ];
    for (const [endpoint, pattern] of bad) {
      const r = await post(m, { detail: detailOf({ endpoint }) });
      expect([endpoint.slice(0, 50), r.status, r.json.error?.code]).toEqual([endpoint.slice(0, 50), 400, "scope_invalid"]);
      expect(r.json.error.message, endpoint).toMatch(pattern);
    }
    expect((await post(m, { detail: detailOf({ endpoint: undefined }) })).json.error.message).toContain("endpoint");
    expect(endpointProblem("https://api.provider.example/v1/run?model=big&n=2")).toBeNull();
    expect(endpointProblem("https://cdn.provider.example:8443/x")).toBeNull();
    expect(endpointProblem(5)).not.toBeNull();
  });

  it("TC-BE-050-04 class D only for these kinds; other kinds and classes are not looked at", async () => {
    market = await startMarket(["andi"]);
    const m = market;
    expect(message(await post(m, { assetClass: "A" }))[2]).toContain("harus D");
    expect(message(await post(m, { assetClass: "C" }))[2]).toContain("harus D");
    // an asset type outside the twelve keeps its old rules: free text is fine
    expect((await post(m, { assetType: "text:translation-summary", detail: "translate up to 5 pages" })).status).toBe(201);
    expect((await post(m, { assetType: "gpu-hours", detail: "A100 80GB", assetClass: "A" })).status).toBe(201);
  });

  it("TC-BE-050-05 statistics per unit: count, kinds, lowest, median and highest price of one unit; closed and expired listings do not count", async () => {
    market = await startMarket(["andi"]);
    const m = market;
    for (const [unit, price, assetType] of [["job", "3000000", "compute:cpu-idle"], ["job", "1000000", "compute:gpu-hours"], ["job", "2000000", "compute:cpu-idle"], ["GB", "500000", "storage:capacity"], ["call", "20000", "oracle:data-feed"], ["call", "40000", "iot:sensor-data"]] as const) {
      expect((await post(m, { assetType, detail: detailOf({ unit, unit_price: price }) })).status).toBe(201);
    }
    const old = await post(m, { detail: detailOf({ unit: "day", unit_price: "9" }), expiresAt: NOW_S + 60 });
    expect(old.status).toBe(201);
    const stats = await m.get("/marketplace/resources/stats");
    expect(stats.status).toBe(200);
    expect(stats.json.units).toEqual([
      { unit: "call", openListings: 2, assetTypes: ["iot:sensor-data", "oracle:data-feed"], minUnitPrice: "20000", medianUnitPrice: "30000", maxUnitPrice: "40000" },
      { unit: "day", openListings: 1, assetTypes: ["compute:cpu-idle"], minUnitPrice: "9", medianUnitPrice: "9", maxUnitPrice: "9" },
      { unit: "GB", openListings: 1, assetTypes: ["storage:capacity"], minUnitPrice: "500000", medianUnitPrice: "500000", maxUnitPrice: "500000" },
      { unit: "job", openListings: 3, assetTypes: ["compute:cpu-idle", "compute:gpu-hours"], minUnitPrice: "1000000", medianUnitPrice: "2000000", maxUnitPrice: "3000000" },
    ]);
    expect(stats.json.total).toBe(7);
    // one unit only; an unknown unit is a bad request
    expect((await m.get("/marketplace/resources/stats?unit=job")).json.units.map((u: any) => u.unit)).toEqual(["job"]);
    expect((await m.get("/marketplace/resources/stats?unit=once")).status).toBe(400);
    // after the short listing expires it drops out
    m.clock.now += 120_000;
    const later = await m.get("/marketplace/resources/stats");
    expect(later.json.units.map((u: any) => u.unit)).toEqual(["call", "GB", "job"]);
    expect(later.json.total).toBe(6);
  });

  it("TC-BE-050-06 no listing, no statistics: the answer is empty, not an example", async () => {
    market = await startMarket(["andi"]);
    const stats = await market.get("/marketplace/resources/stats");
    expect(stats.json).toMatchObject({ units: [], total: 0 });
  });
});
