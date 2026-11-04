import { describe, expect, it } from "vitest";
import { evaluateWithdrawThreshold } from "../../src/settlement/withdraw/threshold.js";

const BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const TRON = "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near";

describe("BE-031 withdrawal threshold (ADR-19)", () => {
  it("TC-BE-031-01 Base below the threshold", () => {
    const result = evaluateWithdrawThreshold({ destinationAsset: BASE, amount: "100000", withdrawFee: "2400", amountOut: "97450" });
    expect(result).toEqual({
      ok: false,
      error: {
        code: "below_withdraw_threshold",
        message: "Withdrawals to Base need at least 0.25 USD; 0.10 USD would lose about 2.55%",
        details: { chain: "base", minAmount: "250000", amount: "100000", withdrawFee: "2400", estimatedLossPct: 2.55 },
      },
    });
  });

  it("TC-BE-031-01 without a quote: estimate from withdrawFee and 14 bps", () => {
    const result = evaluateWithdrawThreshold({ destinationAsset: BASE, amount: "100000", withdrawFee: "2400" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details.estimatedLossPct).toBe(2.54);
  });

  it("TC-BE-031-02 Base lower bound", () => {
    expect(evaluateWithdrawThreshold({ destinationAsset: BASE, amount: "249999", withdrawFee: "2400" }).ok).toBe(false);
    expect(evaluateWithdrawThreshold({ destinationAsset: BASE, amount: "250000", withdrawFee: "2400" })).toEqual({
      ok: true,
      threshold: { chain: "base", minAmount: "250000", ok: true },
      warnings: [],
    });
  });

  it("TC-BE-031-03 acceptHighFee does not lift the Base threshold", () => {
    const result = evaluateWithdrawThreshold({ destinationAsset: BASE, amount: "100000", withdrawFee: "2400", acceptHighFee: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("below_withdraw_threshold");
  });

  it("TC-BE-031-04 Tron small amount", () => {
    const result = evaluateWithdrawThreshold({ destinationAsset: TRON, amount: "5000000", withdrawFee: "900000" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("high_fee_requires_ack");
      expect(result.error.message).toContain("~18%");
    }
  });

  it("TC-BE-031-05 Tron with approval", () => {
    const result = evaluateWithdrawThreshold({ destinationAsset: TRON, amount: "5000000", withdrawFee: "900000", acceptHighFee: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.map((w) => w.code)).toEqual(["high_fee_acknowledged"]);
      expect(result.threshold.chain).toBe("tron");
    }
  });

  it("TC-BE-031-06 1% limit", () => {
    expect(evaluateWithdrawThreshold({ destinationAsset: TRON, amount: "90000000", withdrawFee: "900000" }).ok).toBe(true);
    const below = evaluateWithdrawThreshold({ destinationAsset: TRON, amount: "89999999", withdrawFee: "900000" });
    expect(below.ok).toBe(false);
    if (!below.ok) expect(below.error.code).toBe("high_fee_requires_ack");
  });

  it("TC-BE-031-07 chain detection from the asset", () => {
    const base = evaluateWithdrawThreshold({ destinationAsset: BASE, amount: "1000000", withdrawFee: "2400" });
    const tron = evaluateWithdrawThreshold({ destinationAsset: TRON, amount: "1000000000", withdrawFee: "900000" });
    expect(base.ok && base.threshold.chain).toBe("base");
    expect(tron.ok && tron.threshold.chain).toBe("tron");
  });

  it("an asset that is not a chain-named nep141 is rejected", () => {
    expect(() => evaluateWithdrawThreshold({ destinationAsset: "bogus", amount: "1", withdrawFee: "0" })).toThrow(/destinationAsset/);
  });
});
