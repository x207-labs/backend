import { describe, expect, it } from "vitest";
import { settlementConfigFromEnv } from "../../src/settlement/config.js";
import { USDC_BASE, USDT_NEAR } from "../../src/settlement/mock-transport.js";
import { OneClickClient } from "../../src/settlement/one-click.js";

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
});
