import { IndexerHaltError } from "./errors.js";

/** Safe limit for a u128 amount from an event (Spec Skema D9 1): 2^63 − 1. */
export const MAX_UNITS = (1n << 63n) - 1n;

/** `data` fields that hold an amount in the smallest unit; checked at ingest before the handler runs. */
const AMOUNT_FIELDS = new Set([
  "amount", "stake", "limit", "cumulative_amount", "delta", "obligation", "outstanding_debt", "cleared",
  "cleared_total", "total_obligation", "total_due", "total_claimable", "due", "from_stake", "from_reserve",
  "shortfall", "refunded", "settled_history", "clearing_fee", "solver_fee", "total_defaulted", "pool",
  "old_limit", "new_limit", "max_amount", "replaced_cleared_total",
]);

const DIGITS = /^\d+$/;
const SIGNED = /^-?\d+$/;

/** Non-negative integer string from an event becomes a bigint; larger than 2^63 − 1 halts the indexer. */
export function units(value: string, field: string): bigint {
  if (!DIGITS.test(value)) throw new IndexerHaltError(`field ${field} is not an integer: ${value}`);
  const parsed = BigInt(value);
  if (parsed > MAX_UNITS) throw new IndexerHaltError(`field ${field} exceeds 2^63 - 1: ${value}`);
  return parsed;
}

export function signedUnits(value: string, field: string): bigint {
  if (!SIGNED.test(value)) throw new IndexerHaltError(`field ${field} is not an integer: ${value}`);
  const parsed = BigInt(value);
  if (parsed > MAX_UNITS || -parsed > MAX_UNITS) throw new IndexerHaltError(`field ${field} exceeds 2^63 - 1: ${value}`);
  return parsed;
}

/** Nanosecond timestamp from an event (string). */
export function ns(value: string, field: string): bigint {
  return units(value, field);
}

/** Walk the raw `data` and check all amount fields. */
export function assertAmountsInRange(value: unknown, path = "data"): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertAmountsInRange(item, `${path}[${i}]`));
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string" && AMOUNT_FIELDS.has(key) && DIGITS.test(item)) units(item, `${path}.${key}`);
      else assertAmountsInRange(item, `${path}.${key}`);
    }
  }
}
