import Database from "better-sqlite3";
import { generateVoucherKeypair } from "@x207/core";
import { marketplaceRoutes } from "../../src/marketplace/index.js";
import { acct, CIRCLE, CONTRACT, listen, seedCircle, seedMember, type TestServer } from "../helpers/d9-fixtures.js";

export const NOW = Date.parse("2026-11-04T10:00:00Z");
export const NOW_S = Math.floor(NOW / 1000);

export interface Market {
  db: Database.Database;
  srv: TestServer;
  keys: Record<string, ReturnType<typeof generateVoucherKeypair>>;
  /** Waktu server yang bisa digeser oleh test. */
  clock: { now: number };
  get: (path: string) => Promise<{ status: number; json: any }>;
  post: (path: string, body: unknown) => Promise<{ status: number; json: any }>;
}

/** D9 dengan anggota `names` (kunci voucher nyata) dan route marketplace terpasang. */
export async function startMarket(names: string[] = ["andi", "budi", "citra"], inactive: string[] = []): Promise<Market> {
  const db = new Database(":memory:");
  seedCircle(db);
  const keys: Market["keys"] = {};
  for (const name of [...names, ...inactive]) {
    seedMember(db, { name, status: inactive.includes(name) ? "suspended" : "active" });
    keys[name] = generateVoucherKeypair();
    db.prepare("UPDATE members SET pubkey_voucher = ? WHERE circle_id = ? AND account_id = ?").run(keys[name]!.publicKey, CIRCLE, acct(name));
  }
  const clock = { now: NOW };
  const srv = await listen({ db, now: () => clock.now, extraRoutes: marketplaceRoutes(db) });
  const call = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const res = await fetch(`${srv.url}/x207/circles/${CIRCLE}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    return { status: res.status, json: await res.json() };
  };
  return { db, srv, keys, clock, get: (p) => call("GET", p), post: (p, b) => call("POST", p, b) };
}

export { acct, CIRCLE, CONTRACT };
