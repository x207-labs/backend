import type Database from "better-sqlite3";

export const UNIT = "credit";
export const DECIMALS = 6;

/** Kolom INTEGER D9 dibaca sebagai bigint agar jumlah besar tidak kehilangan presisi. */
export function rows<T = Record<string, unknown>>(db: Database.Database, sql: string, ...args: unknown[]): T[] {
  return db.prepare(sql).safeIntegers(true).all(...args) as T[];
}

export function row<T = Record<string, unknown>>(db: Database.Database, sql: string, ...args: unknown[]): T | undefined {
  return db.prepare(sql).safeIntegers(true).get(...args) as T | undefined;
}

/** Jumlah API = string bilangan bulat satuan terkecil. */
export const amount = (v: bigint | number): string => v.toString();

/** Waktu D9 (ns epoch) ke ISO 8601 UTC tanpa pecahan detik; NULL tetap null. */
export function isoFromNs(ns: bigint | null | undefined): string | null {
  if (ns === null || ns === undefined) return null;
  const iso = new Date(Number(ns / 1_000_000n)).toISOString();
  return iso.replace(/\.\d{3}Z$/, "Z");
}
