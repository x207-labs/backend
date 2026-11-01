import { afterEach, describe, expect, it } from "vitest";
import { USDC_BASE, USDT_TRON } from "../../src/settlement/mock-transport.js";
import { JOB, Recording, quoteBody, withdrawServer } from "../helpers/withdraw-server.js";

describe("BE-031 ambang pencairan di POST /x207/settlement/withdraw/quote", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  async function server(options: Parameters<typeof withdrawServer>[0] = {}) {
    const s = await withdrawServer(options);
    close = s.close;
    return s;
  }

  it("TC-BE-031-01 Base di bawah ambang", async () => {
    const { post, db } = await server();
    const { res, json } = await post("quote", quoteBody({ amount: "100000" }));
    expect(res.status).toBe(422);
    expect(json.error.code).toBe("below_withdraw_threshold");
    expect(json.error.message).toContain("0,25");
    expect(json.error.message).toContain("2,55%");
    expect(json.error.details).toEqual({ chain: "base", minAmount: "250000", amount: "100000", withdrawFee: "2400", estimatedLossPct: 2.55 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM settlement_jobs").get()).toEqual({ n: 0 });
  });

  it("TC-BE-031-02 batas bawah Base", async () => {
    const { post } = await server();
    expect((await post("quote", quoteBody({ amount: "249999" }))).res.status).toBe(422);
    const ok = await post("quote", quoteBody({ amount: "250000" }));
    expect(ok.res.status).toBe(201);
    expect(ok.json.threshold.ok).toBe(true);
  });

  it("TC-BE-031-03 acceptHighFee tidak membuka ambang Base", async () => {
    const { post } = await server();
    const { res, json } = await post("quote", quoteBody({ amount: "100000", acceptHighFee: true }));
    expect([res.status, json.error.code]).toEqual([422, "below_withdraw_threshold"]);
  });

  it("TC-BE-031-04 Tron nominal kecil", async () => {
    const { post } = await server();
    const { res, json } = await post("quote", quoteBody({ destinationAsset: USDT_TRON, amount: "5000000" }));
    expect([res.status, json.error.code]).toEqual([422, "high_fee_requires_ack"]);
    expect(json.error.message).toContain("~18%");
  });

  it("TC-BE-031-05 Tron dengan persetujuan", async () => {
    const { post } = await server();
    const { res, json } = await post("quote", quoteBody({ destinationAsset: USDT_TRON, amount: "5000000", acceptHighFee: true }));
    expect(res.status).toBe(201);
    expect(json.warnings).toContain("high_fee_acknowledged");
    expect(json.threshold.chain).toBe("tron");
  });

  it("TC-BE-031-06 batas 1%", async () => {
    const { post } = await server();
    expect((await post("quote", quoteBody({ destinationAsset: USDT_TRON, amount: "90000000" }))).res.status).toBe(201);
    const below = await post("quote", quoteBody({ destinationAsset: USDT_TRON, amount: "89999999" }));
    expect([below.res.status, below.json.error.code]).toEqual([422, "high_fee_requires_ack"]);
  });

  it("TC-BE-031-07 chain dari aset", async () => {
    const { post } = await server();
    const base = await post("quote", quoteBody());
    const tron = await post("quote", quoteBody({ destinationAsset: USDT_TRON, amount: "90000000" }));
    expect([base.json.threshold.chain, tron.json.threshold.chain]).toEqual(["base", "tron"]);
  });

  it("TC-BE-031-08 quote dry di bawah ambang tidak memanggil generate-intent", async () => {
    const t = new Recording();
    const { post } = await server({ transport: t, mode: "dry" });
    const { res, json } = await post("quote", quoteBody({ amount: "100000" }));
    expect([res.status, json.error.code]).toEqual([422, "below_withdraw_threshold"]);
    expect(t.requests).not.toContain("generate-intent");
    expect(t.requests).toContain("quote");
  });
});
