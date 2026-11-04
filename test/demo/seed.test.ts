import { afterEach, describe, expect, it } from "vitest";
import { demoKeys, seedDemo, type DemoClient, type DemoOptions } from "../../src/demo/seed.js";
import { MockCodeIssuer } from "../../src/marketplace/code-issuers.js";
import { CATALOG } from "../../../scripts/lib/asset-catalog.mjs";
import { acct, CIRCLE, CONTRACT, NOW_S, openEpoch, startMarket, type Market } from "../marketplace/helpers.js";

// BE-080: the demo seed fills a market with one example of every pipeline, and a second run adds nothing.
describe("BE-080 demo seed", () => {
  let market: Market | undefined;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });

  const SEED = "a demo seed that lives outside the repository";
  async function start() {
    const issuer = new MockCodeIssuer().issue("DEMO-GIFT-0001");
    market = await startMarket(["demoseller", "demobuyer", "demohelper"], [], undefined, { codeIssuers: { "demo-issuer": issuer } });
    openEpoch(market, 42);
    const keys = demoKeys(SEED);
    const accounts = { seller: acct("demoseller"), buyer: acct("demobuyer"), helper: acct("demohelper") };
    // the demo accounts are members with the demo keys, as a join with `--print-members` would make them
    for (const [role, name] of [["seller", "demoseller"], ["buyer", "demobuyer"], ["helper", "demohelper"]] as const) {
      market.db.prepare("UPDATE members SET pubkey_voucher = ? WHERE circle_id = ? AND account_id = ?").run(keys[role].publicKey, CIRCLE, acct(name));
    }
    for (const c of CATALOG.filter((e: { cls: string }) => e.cls === "A")) {
      market.db.prepare("INSERT INTO asset_classes (circle_id, asset_type, class, block_height, receipt_id, log_index) VALUES (?, ?, 'A', 1, 'r', 0)").run(CIRCLE, c.assetType);
    }
    const options: DemoOptions = { circleContract: CONTRACT, accounts, keys, nowS: NOW_S, expiresAt: NOW_S + 30 * 86_400 };
    const client: DemoClient = { get: (p) => market!.get(p), post: (p, b) => market!.post(p, b) };
    return { options, client };
  }
  const counts = (m: Market) => ({
    listings: (m.db.prepare("SELECT COUNT(*) AS n FROM listings").get() as { n: number }).n,
    orders: (m.db.prepare("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n,
    invoices: (m.db.prepare("SELECT COUNT(*) AS n FROM invoices").get() as { n: number }).n,
  });

  it("TC-BE-080-01 one command creates a listing or an object for every pipeline that runs, with no failure", async () => {
    const { options, client } = await start();
    const results = await seedDemo(client, options);
    expect(results.filter((r) => r.outcome === "failed"), JSON.stringify(results.filter((r) => r.outcome === "failed"))).toEqual([]);
    const pipelines = new Set(results.filter((r) => r.outcome === "created").map((r) => r.pipeline));
    expect([...pipelines].sort()).toEqual(["P2 access rent", "P3 one-time code", "P4 transfer", "P5 job", "P6 order", "P7 license", "P8 invoice", "class A"]);
    expect(results.find((r) => r.item === "domain")).toMatchObject({ outcome: "skipped" });
    // the listings are open and discoverable; the order is proposed with both signatures; the invoice is requested
    expect(counts(market!)).toEqual({ listings: 8, orders: 1, invoices: 1 });
    const open = (await market!.get("/listings?status=open&limit=50")).json;
    expect(open.items.length).toBe(8);
    expect((await market!.get(`/orders?party=${acct("demobuyer")}`)).json.items).toHaveLength(1);
  });

  it("TC-BE-080-02 a second run creates nothing: the same objects are answered `already exists` and the tables do not grow", async () => {
    const { options, client } = await start();
    await seedDemo(client, options);
    const before = counts(market!);
    market!.clock.now += 3_600_000; // another moment, the same content
    const again = await seedDemo(client, { ...options, nowS: options.nowS + 3600 });
    expect(again.filter((r) => r.outcome === "failed"), JSON.stringify(again.filter((r) => r.outcome === "failed"))).toEqual([]);
    expect(again.filter((r) => r.outcome === "created")).toEqual([]);
    expect(again.filter((r) => r.outcome === "exists").length).toBe(10);
    expect(counts(market!)).toEqual(before);
  });

  it("TC-BE-080-04 a class A asset type that the circle has not registered is skipped with the reason, not a failure; the other pipelines are posted", async () => {
    const { options, client } = await start();
    market!.db.prepare("DELETE FROM asset_classes").run();
    const results = await seedDemo(client, options);
    expect(results.filter((r) => r.outcome === "failed")).toEqual([]);
    expect(results.filter((r) => r.pipeline === "class A").map((r) => r.outcome)).toEqual(["skipped", "skipped"]);
    expect(counts(market!)).toEqual({ listings: 6, orders: 1, invoices: 1 });
  });

  it("TC-BE-080-03 accounts that are not members with the demo keys are told how to join, and nothing is posted; the seed is a secret that is never in a result", async () => {
    const { options, client } = await start();
    market!.db.prepare("UPDATE members SET pubkey_voucher = ? WHERE account_id = ?").run("ed25519:11111111111111111111111111111111", acct("demobuyer"));
    const results = await seedDemo(client, options);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ pipeline: "members", item: "buyer", outcome: "failed" });
    expect(counts(market!).listings).toBe(0);
    expect(JSON.stringify(results)).not.toContain(SEED);
    expect(() => demoKeys("short")).toThrow(/at least 16/);
    // the same seed gives the same keys, another seed gives other keys
    expect(demoKeys(SEED).seller.publicKey).toBe(demoKeys(SEED).seller.publicKey);
    expect(demoKeys(SEED).seller.publicKey).not.toBe(demoKeys(`${SEED}!`).seller.publicKey);
  });
});
