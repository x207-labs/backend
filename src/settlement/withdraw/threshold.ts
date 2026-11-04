/** Creditor withdrawal threshold (ADR-19, BE-031). Pure function; called by the withdraw quote endpoint (BE-030). */

const BASE_MIN_AMOUNT = 250_000n;
const HIGH_FEE_PCT_NUM = 1n; // fee > 1% of nominal
const VARIABLE_FEE_BPS_ESTIMATE = 14;

export interface WithdrawThresholdInput {
  /** 1Click destination asset, e.g. `nep141:base-0x….omft.near`. */
  destinationAsset: string;
  /** Smallest unit, 6 decimals. */
  amount: string;
  withdrawFee: string;
  /** `amountOut` from the `dry` quote; if present, used to estimate the loss. */
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
          message: `Withdrawals to Base need at least ${usd(BASE_MIN_AMOUNT)} USD; ${usd(amount)} USD would lose about ${pct(estimatedLossPct)}`,
          details: { chain, minAmount: BASE_MIN_AMOUNT.toString(), amount: input.amount, withdrawFee: input.withdrawFee, estimatedLossPct },
        },
      };
    }
    return { ok: true, threshold: { chain, minAmount: BASE_MIN_AMOUNT.toString(), ok: true }, warnings: [] };
  }

  // Chains other than Base: a fixed cost > 1% of nominal needs explicit approval.
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
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

function pct(value: number): string {
  return value >= 10 ? `~${Math.round(value)}%` : `${value.toFixed(2)}%`;
}
