import { IndexerHaltError } from "./errors.js";

/** Batas aman jumlah u128 dari event (Spec Skema D9 1): 2^63 − 1. */
export const MAX_UNITS = (1n << 63n) - 1n;

/** Field `data` yang berisi jumlah satuan terkecil; dicek di ingest sebelum handler berjalan. */
const AMOUNT_FIELDS = new Set([
  "amount", "stake", "limit", "cumulative_amount", "delta", "obligation", "outstanding_debt", "cleared",
  "cleared_total", "total_obligation", "total_due", "total_claimable", "due", "from_stake", "from_reserve",
  "shortfall", "refunded", "settled_history", "clearing_fee", "solver_fee", "total_defaulted", "pool",
  "old_limit", "new_limit", "max_amount", "replaced_cleared_total",
]);

const DIGITS = /^\d+$/;
const SIGNED = /^-?\d+$/;

/** String bilangan bulat tak negatif dari event menjadi bigint; lebih besar dari 2^63 − 1 menghentikan indexer. */
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

/** Timestamp nanodetik dari event (string). */
export function ns(value: string, field: string): bigint {
  return units(value, field);
}

/** Telusuri `data` mentah dan periksa semua field jumlah. */
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
