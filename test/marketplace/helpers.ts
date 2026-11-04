import Database from "better-sqlite3";
import { generateVoucherKeypair } from "@x207/core";
import type { AbuseLimits } from "../../src/api/abuse.js";
import { marketplaceRoutes } from "../../src/marketplace/index.js";
import type { ViewFunction } from "../../src/settlement/intents.js";
import { acct, CIRCLE, CONTRACT, listen, seedCircle, seedMember, type TestServer } from "../helpers/d9-fixtures.js";

export const NOW = Date.parse("2026-11-04T10:00:00Z");
export const NOW_S = Math.floor(NOW / 1000);

export interface Market {
  db: Database.Database;
  srv: TestServer;
  keys: Record<string, ReturnType<typeof generateVoucherKeypair>>;
  /** Server time that the test can shift. */
  clock: { now: number };
  get: (path: string) => Promise<{ status: number; json: any }>;
  post: (path: string, body: unknown) => Promise<{ status: number; json: any }>;
}

/** D9 with members `names` (real voucher keys) and the marketplace routes mounted. */
export async function startMarket(names: string[] = ["andi", "budi", "citra"], inactive: string[] = [], chainView?: ViewFunction, routeOptions: NonNullable<Parameters<typeof marketplaceRoutes>[1]> = {}, serverOptions: { abuse?: Partial<AbuseLimits>; rateLimitPerMinute?: number } = {}): Promise<Market> {
  const db = new Database(":memory:");
  seedCircle(db);
  const keys: Market["keys"] = {};
  for (const name of [...names, ...inactive]) {
    seedMember(db, { name, status: inactive.includes(name) ? "suspended" : "active" });
    keys[name] = generateVoucherKeypair();
    db.prepare("UPDATE members SET pubkey_voucher = ? WHERE circle_id = ? AND account_id = ?").run(keys[name]!.publicKey, CIRCLE, acct(name));
  }
  const clock = { now: NOW };
  const srv = await listen({ db, now: () => clock.now, ...serverOptions, extraRoutes: marketplaceRoutes(db, { ...(chainView ? { chainView } : {}), ...routeOptions }) });
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

import { listingHash, signListing, type Listing } from "@x207/core";

export const listing = (name: string, over: Partial<Listing> = {}): Listing => ({
  circle: CONTRACT,
  account: acct(name),
  offer: { asset_type: "gpu-hours", asset_class: "A", quantity: 10, value: "100000000" },
  want: { asset_type: "translation", asset_class: "B", quantity: 5, value: "100000000" },
  terms: "deliver within 24h",
  detail: "A100 80GB, batch inference",
  expires_at: NOW_S + 86_400,
  discount_bps: 1000,
  accept_payment: true,
  discoverable: true,
  nonce: `l-${name}`,
  ...over,
});

export const signedListing = (m: Market, name: string, over: Partial<Listing> = {}) => {
  const l = listing(name, over);
  return { listing: l, signature: signListing(l, m.keys[name]!.secretKey) };
};

import { signOffer, type Offer } from "@x207/core";
import { seedEpoch } from "../helpers/d9-fixtures.js";

export const openEpoch = (m: Market, epoch = 42): void => seedEpoch(m.db, { epoch, phase: "open", cutoffAt: "2026-11-05T00:00:00Z" });

/**
 * Offer signed by `name` over `l`, the round after `previous` if there is one. Built directly (not through
 * `counterOffer`) so tests can send offers that the SDK helper forbids.
 */
export function bid(m: Market, name: string, l: Listing, over: { mode?: "pay" | "barter"; value?: string; previous?: Offer; round?: number } = {}) {
  const offer: Offer = {
    circle: l.circle, listing_hash: listingHash(l), proposer: acct(name), round: over.round ?? (over.previous?.round ?? 0) + 1,
    mode: over.mode ?? "barter", value: over.value ?? "100000000", quantity: 5, deliver_by: NOW_S + 3 * 86_400,
  };
  return { offer, signature: signOffer(offer, m.keys[name]!.secretKey) };
}


import { signReferral, type Referral } from "@x207/core";

export const referral = (seeker: string, to: string, l: Listing, over: Partial<Referral> = {}): Referral => ({
  circle: CONTRACT, seeker: acct(seeker), to: acct(to), listing_hash: listingHash(l), mode: "barter", value: "100000000", quantity: 5,
  deliver_by: NOW_S + 3 * 86_400, searcher_share_bps: 300, expires_at: NOW_S + 3600, nonce: `r-${seeker}-${to}`, ...over,
});

export const signedReferral = (m: Market, seeker: string, to: string, l: Listing, over: Partial<Referral> = {}) => {
  const r = referral(seeker, to, l, over);
  return { referral: r, signature: signReferral(r, m.keys[seeker]!.secretKey) };
};

