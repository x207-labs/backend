import { describe, expect, it } from "vitest";
import { settlementConfigFromEnv } from "../../src/settlement/config.js";
import { USDC_BASE, USDT_NEAR } from "../../src/settlement/mock-transport.js";
import { OneClickClient } from "../../src/settlement/one-click.js";
import { depositQuoteRoutes } from "../../src/settlement/deposit/quote.js";
import { fxServer } from "../helpers/fx-api.js";
import { acct } from "../helpers/fx-log42.js";

// Opt-in: jaringan nyata, selalu dry:true, tanpa dana. Jalankan: X207_INTEGRATION=1 npx vitest run test/settlement/one-click.integration.test.ts
const run = process.env.X207_INTEGRATION === "1";
if (run) process.loadEnvFile(new URL("../../.env", import.meta.url));

// Alamat EVM uji seperti spike Ronde 3 (refund quote dry; tidak ada transaksi).
const EVM_REFUND = process.env.X207_TEST_EVM_ADDRESS ?? "0x1111111111111111111111111111111111111111";

describe.skipIf(!run)("BE-025 smoke 1Click dry (integration)", () => {
  const client = () => new OneClickClient({ config: { ...settlementConfigFromEnv(process.env), mode: "dry" } });

  it("TC-BE-025-11 /v0/tokens memuat USDT NEAR dan USDC Base", async () => {
    const ids = (await client().listTokens()).map((t) => t.assetId);
    expect(ids).toContain(USDT_NEAR);
    expect(ids).toContain(USDC_BASE);
  });

  it("TC-BE-025-11 quote dry 201 tanpa depositAddress dan tanpa dana", async () => {
    const q = await client().quote({
      swapType: "EXACT_OUTPUT",
      originAsset: USDC_BASE,
      destinationAsset: USDT_NEAR,
      amount: "1000000",
      depositType: "ORIGIN_CHAIN",
      recipientType: "INTENTS",
      refundType: "ORIGIN_CHAIN",
      refundTo: EVM_REFUND,
      recipient: "near",
      dry: true,
    });
    expect(q.quote.amountOut).toBe("1000000");
    expect(q.quote.depositAddress).toBeUndefined();
    expect(BigInt(q.quote.amountIn)).toBeGreaterThan(0n);
  });

  it("TC-BE-027-12 stake 50 USD dari USDC Base lewat endpoint, dry nyata", async () => {
    const s = await fxServer(8, [], undefined, depositQuoteRoutes({ client: client(), accountExists: async () => true }));
    try {
      const res = await fetch(`${s.srv.url}/x207/settlement/deposit/quote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ purpose: "stake", circle: "agents-main", account: acct("scraper"), amount: "50000000", originAsset: USDC_BASE, refundType: "ORIGIN_CHAIN", refundTo: EVM_REFUND, dry: true }),
      });
      const json = (await res.json()) as Record<string, unknown>;
      expect(res.status).toBe(201);
      expect(json).toMatchObject({ status: "waiting_deposit", dry: true, amountOut: "50000000", recipientType: "INTENTS" });
      // quote dry tidak membawa depositAddress (lihat TC-BE-025-11); alamat hanya ada di mode live
      expect(json.depositAddress).toBeNull();
    } finally {
      await s.close();
    }
  });
});
