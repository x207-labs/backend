/** Ambang pencairan kreditor (ADR-19, BE-031). Fungsi murni; dipanggil endpoint withdraw quote (BE-030). */

const BASE_MIN_AMOUNT = 250_000n;
const HIGH_FEE_PCT_NUM = 1n; // fee > 1% nominal
const VARIABLE_FEE_BPS_ESTIMATE = 14;

export interface WithdrawThresholdInput {
  /** Aset tujuan 1Click, mis. `nep141:base-0x….omft.near`. */
  destinationAsset: string;
  /** Satuan terkecil, 6 desimal. */
  amount: string;
  withdrawFee: string;
  /** `amountOut` dari quote `dry`; bila ada, dipakai untuk estimasi kerugian. */
  amountOut?: string;
  acceptHighFee?: boolean;
}

export interface WithdrawThreshold {
  chain: string;
  minAmount?: string;
  ok: true;
}

export interface WithdrawWarning {
  code: "high_fee_acknowledged";
  message: string;
}

export interface WithdrawThresholdError {
  code: "below_withdraw_threshold" | "high_fee_requires_ack";
  message: string;
  details: {
    chain: string;
    minAmount?: string;
    amount: string;
    withdrawFee: string;
    estimatedLossPct: number;
  };
}

export type WithdrawThresholdResult =
  | { ok: true; threshold: WithdrawThreshold; warnings: WithdrawWarning[] }
  | { ok: false; error: WithdrawThresholdError };

export function chainOfAsset(destinationAsset: string): string {
  const match = /^nep141:([a-z0-9]+)-/.exec(destinationAsset);
  if (!match?.[1]) throw new Error(`destinationAsset has no chain prefix: ${destinationAsset}`);
  return match[1];
}

export function evaluateWithdrawThreshold(input: WithdrawThresholdInput): WithdrawThresholdResult {
  const chain = chainOfAsset(input.destinationAsset);
  const amount = BigInt(input.amount);
  const fee = BigInt(input.withdrawFee);
  const estimatedLossPct = lossPct(amount, fee, input.amountOut);

  if (chain === "base") {
    if (amount < BASE_MIN_AMOUNT) {
      return {
        ok: false,
        error: {
          code: "below_withdraw_threshold",
          message: `Pencairan ke Base minimal ${usd(BASE_MIN_AMOUNT)} USD; ${usd(amount)} USD kehilangan sekitar ${pct(estimatedLossPct)}`,
          details: { chain, minAmount: BASE_MIN_AMOUNT.toString(), amount: input.amount, withdrawFee: input.withdrawFee, estimatedLossPct },
        },
      };
    }
    return { ok: true, threshold: { chain, minAmount: BASE_MIN_AMOUNT.toString(), ok: true }, warnings: [] };
  }

  // Chain selain Base: biaya tetap > 1% nominal butuh persetujuan eksplisit.
  if (fee * 100n > amount * HIGH_FEE_PCT_NUM) {
    const message = `Fixed withdrawal fee to ${chain} is ${usd(fee)} USD, estimated loss ${pct(estimatedLossPct)} of ${usd(amount)} USD`;
    if (!input.acceptHighFee) {
      return {
        ok: false,
        error: {
          code: "high_fee_requires_ack",
          message: `${message}; approve with acceptHighFee`,
          details: { chain, amount: input.amount, withdrawFee: input.withdrawFee, estimatedLossPct },
        },
      };
    }
    return { ok: true, threshold: { chain, ok: true }, warnings: [{ code: "high_fee_acknowledged", message }] };
  }
  return { ok: true, threshold: { chain, ok: true }, warnings: [] };
}

function lossPct(amount: bigint, fee: bigint, amountOut?: string): number {
  if (amount === 0n) return 100;
  if (amountOut !== undefined) return round2(Number(((amount - BigInt(amountOut)) * 1_000_000n) / amount) / 10_000);
  return round2(Number((fee * 1_000_000n) / amount) / 10_000 + VARIABLE_FEE_BPS_ESTIMATE / 100);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function usd(units: bigint): string {
  const cents = units / 10_000n;
  return `${cents / 100n},${(cents % 100n).toString().padStart(2, "0")}`;
}

function pct(value: number): string {
  return value >= 10 ? `~${Math.round(value)}%` : `${value.toFixed(2).replace(".", ",")}%`;
}
