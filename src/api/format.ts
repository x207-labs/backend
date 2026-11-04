import type Database from "better-sqlite3";

export const UNIT = "credit";
export const DECIMALS = 6;

/** D9 INTEGER columns are read as bigint so large amounts do not lose precision. */
export function rows<T = Record<string, unknown>>(db: Database.Database, sql: string, ...args: unknown[]): T[] {
  return db.prepare(sql).safeIntegers(true).all(...args) as T[];
}

export function row<T = Record<string, unknown>>(db: Database.Database, sql: string, ...args: unknown[]): T | undefined {
  return db.prepare(sql).safeIntegers(true).get(...args) as T | undefined;
}

/** API amount = string of an integer in the smallest unit. */
export const amount = (v: bigint | number): string => v.toString();

/** D9 time (epoch ns) to ISO 8601 UTC without fractional seconds; NULL stays null. */
export function isoFromNs(ns: bigint | null | undefined): string | null {
  if (ns === null || ns === undefined) return null;
  const iso = new Date(Number(ns / 1_000_000n)).toISOString();
  return iso.replace(/\.\d{3}Z$/, "Z");
}

/** Job time (unix ms) to ISO 8601 UTC without fractional seconds. */
export function isoFromMs(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}
