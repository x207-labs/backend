import { describe, expect, it } from "vitest";
import { evaluateWithdrawThreshold } from "../../src/settlement/withdraw/threshold.js";

const BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const TRON = "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near";

describe("BE-031 ambang pencairan (ADR-19)", () => {
  it("TC-BE-031-01 Base di bawah ambang", () => {
    const result = evaluateWithdrawThreshold({ destinationAsset: BASE, amount: "100000", withdrawFee: "2400", amountOut: "97450" });
    expect(result).toEqual({
      ok: false,
      error: {
        code: "below_withdraw_threshold",
        message: "Pencairan ke Base minimal 0,25 USD; 0,10 USD kehilangan sekitar 2,55%",
        details: { chain: "base", minAmount: "250000", amount: "100000", withdrawFee: "2400", estimatedLossPct: 2.55 },
      },
    });
  });

  it("TC-BE-031-01 tanpa quote: estimasi dari withdrawFee dan 14 bps", () => {
    const result = evaluateWithdrawThreshold({ destinationAsset: BASE, amount: "100000", withdrawFee: "2400" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details.estimatedLossPct).toBe(2.54);
  });

  it("TC-BE-031-02 batas bawah Base", () => {
    expect(evaluateWithdrawThreshold({ destinationAsset: BASE, amount: "249999", withdrawFee: "2400" }).ok).toBe(false);
    expect(evaluateWithdrawThreshold({ destinationAsset: BASE, amount: "250000", withdrawFee: "2400" })).toEqual({
      ok: true,
      threshold: { chain: "base", minAmount: "250000", ok: true },
      warnings: [],
    });
  });

  it("TC-BE-031-03 acceptHighFee tidak membuka ambang Base", () => {
    const result = evaluateWithdrawThreshold({ destinationAsset: BASE, amount: "100000", withdrawFee: "2400", acceptHighFee: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("below_withdraw_threshold");
  });

  it("TC-BE-031-04 Tron nominal kecil", () => {
    const result = evaluateWithdrawThreshold({ destinationAsset: TRON, amount: "5000000", withdrawFee: "900000" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("high_fee_requires_ack");
      expect(result.error.message).toContain("~18%");
    }
  });

  it("TC-BE-031-05 Tron dengan persetujuan", () => {
    const result = evaluateWithdrawThreshold({ destinationAsset: TRON, amount: "5000000", withdrawFee: "900000", acceptHighFee: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.map((w) => w.code)).toEqual(["high_fee_acknowledged"]);
      expect(result.threshold.chain).toBe("tron");
    }
  });

  it("TC-BE-031-06 batas 1%", () => {
    expect(evaluateWithdrawThreshold({ destinationAsset: TRON, amount: "90000000", withdrawFee: "900000" }).ok).toBe(true);
    const below = evaluateWithdrawThreshold({ destinationAsset: TRON, amount: "89999999", withdrawFee: "900000" });
    expect(below.ok).toBe(false);
    if (!below.ok) expect(below.error.code).toBe("high_fee_requires_ack");
  });

  it("TC-BE-031-07 deteksi chain dari aset", () => {
    const base = evaluateWithdrawThreshold({ destinationAsset: BASE, amount: "1000000", withdrawFee: "2400" });
    const tron = evaluateWithdrawThreshold({ destinationAsset: TRON, amount: "1000000000", withdrawFee: "900000" });
    expect(base.ok && base.threshold.chain).toBe("base");
    expect(tron.ok && tron.threshold.chain).toBe("tron");
  });

  it("aset yang bukan nep141 bernama chain ditolak", () => {
    expect(() => evaluateWithdrawThreshold({ destinationAsset: "bogus", amount: "1", withdrawFee: "0" })).toThrow(/destinationAsset/);
  });
});
