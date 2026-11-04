import { describe, expect, it } from "vitest";
import { settlementConfigFromEnv } from "../../src/settlement/config.js";
import { USDC_BASE, USDT_NEAR } from "../../src/settlement/mock-transport.js";
import { OneClickClient } from "../../src/settlement/one-click.js";
import { withdrawRoutes } from "../../src/settlement/withdraw/routes.js";
import { depositQuoteRoutes } from "../../src/settlement/deposit/quote.js";
import { fxServer } from "../helpers/fx-api.js";
import { acct } from "../helpers/fx-log42.js";

// Opt-in: real network, always dry:true, no funds. Run: X207_INTEGRATION=1 npx vitest run test/settlement/one-click.integration.test.ts
const run = process.env.X207_INTEGRATION === "1";
if (run) process.loadEnvFile(new URL("../../.env", import.meta.url));

// EVM test address as in the Round 3 spike (dry refund quote; no transaction).
const EVM_REFUND = process.env.X207_TEST_EVM_ADDRESS ?? "0x1111111111111111111111111111111111111111";

describe.skipIf(!run)("BE-025 smoke 1Click dry (integration)", () => {
  const client = () => new OneClickClient({ config: { ...settlementConfigFromEnv(process.env), mode: "dry" } });

  it("TC-BE-025-11 /v0/tokens lists USDT NEAR and USDC Base", async () => {
    const ids = (await client().listTokens()).map((t) => t.assetId);
    expect(ids).toContain(USDT_NEAR);
    expect(ids).toContain(USDC_BASE);
  });

  it("TC-BE-025-11 dry quote 201 without depositAddress and without funds", async () => {
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

  it("TC-BE-027-12 stake 50 USD from USDC Base through the endpoint, real dry run", async () => {
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
      // a dry quote carries no depositAddress (see TC-BE-025-11); the address only exists in live mode
      expect(json.depositAddress).toBeNull();
    } finally {
      await s.close();
    }
  });

  it("TC-BE-030-13 real dry withdraw quote, 1 USDT to USDC Base", async () => {
    const s = await fxServer(8, [], undefined, withdrawRoutes({ client: client(), accountExists: async () => true }));
    try {
      const res = await fetch(`${s.srv.url}/x207/settlement/withdraw/quote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ circle: "agents-main", account: acct("gpu"), destinationAsset: USDC_BASE, amount: "1000000", recipient: EVM_REFUND, refundTo: acct("gpu"), dry: true }),
      });
      const json = (await res.json()) as Record<string, unknown>;
      expect(res.status, JSON.stringify(json)).toBe(201);
      expect(json).toMatchObject({ status: "quoted", dry: true, withdrawFee: "2400", recipientType: "DESTINATION_CHAIN" });
    } finally {
      await s.close();
    }
  });
});
