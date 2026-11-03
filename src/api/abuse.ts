// Limits against abuse of the write routes (BE-066). Everything here is in memory and per process: with two instances behind a balancer each one counts for itself, so the real ceiling is the
// number of instances times the limit (README, "Limits against abuse"). Defaults are applied by `abuseFromEnv` (the main process); a server made by a test with no options has no limit but the
// body size, the page size and the caps on open objects, which are always on.
import type Database from "better-sqlite3";
import { ApiError } from "./errors.js";
import { row } from "./format.js";

export const WINDOW_MS = 60_000;

export interface AbuseLimits {
  /** Requests per minute per IP, all routes (0 = off). Env `API_RATE_LIMIT_PER_MINUTE`. */
  ipPerMinute: number;
  /** Write requests (POST) per minute per IP, accepted or not (0 = off). Env `API_WRITE_RATE_PER_MINUTE_IP`. */
  writeIpPerMinute: number;
  /** Write requests per minute that an account gets ACCEPTED (0 = off). Only a request that passed its checks and signatures counts, so nobody can use up the quota of an account by naming it. Env `API_WRITE_RATE_PER_MINUTE_ACCOUNT`. */
  writeAccountPerMinute: number;
  /** Largest body in bytes; above it the answer is 413. Env `API_MAX_BODY_BYTES`. */
  maxBodyBytes: number;
  /** Largest `limit` of a list. Env `API_MAX_PAGE_LIMIT`. The code never serves more than 200 anyway. */
  maxPageLimit: number;
  /** Take the last hop of `X-Forwarded-For` as the address of the caller (only behind a proxy you run). Env `API_TRUST_PROXY=1`. */
  trustProxy: boolean;
}

export interface OpenLimits {
  /** Open (proposed or open) orders that one account is a party to. Env `API_MAX_OPEN_ORDERS`. */
  orders: number;
  /** Invoices waiting (requested or approved) that one account issued. Env `API_MAX_OPEN_INVOICES`. */
  invoices: number;
  /** Purchases not final that one account made as buyer. Env `API_MAX_OPEN_PURCHASES`. */
  purchases: number;
}

export const DEFAULT_LIMITS: AbuseLimits = { ipPerMinute: 600, writeIpPerMinute: 120, writeAccountPerMinute: 60, maxBodyBytes: 64 * 1024, maxPageLimit: 200, trustProxy: false };
export const DEFAULT_OPEN: OpenLimits = { orders: 50, invoices: 50, purchases: 50 };

function intFrom(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 0): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min) throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
  return Number(raw);
}

/** `API_LIMITS=off` turns off every rate limit and every cap on open objects at once (for tests that send many requests, e.g. the e2e of the umbrella); the size of a body and of a page stay. Empty or `on`: as set. */
export function limitsOff(env: NodeJS.ProcessEnv): boolean {
  const raw = env.API_LIMITS ?? "";
  if (raw !== "" && raw !== "on" && raw !== "off") throw new Error(`API_LIMITS must be off or on, got "${raw}"`);
  return raw === "off";
}

export function abuseFromEnv(env: NodeJS.ProcessEnv = process.env): { limits: AbuseLimits; open: OpenLimits } {
  const d = DEFAULT_LIMITS;
  if (limitsOff(env)) {
    return {
      limits: { ipPerMinute: 0, writeIpPerMinute: 0, writeAccountPerMinute: 0, maxBodyBytes: intFrom(env, "API_MAX_BODY_BYTES", d.maxBodyBytes, 1024), maxPageLimit: Math.min(200, intFrom(env, "API_MAX_PAGE_LIMIT", d.maxPageLimit, 1)), trustProxy: env.API_TRUST_PROXY === "1" },
      open: { orders: 0, invoices: 0, purchases: 0 },
    };
  }
  return {
    limits: {
      ipPerMinute: intFrom(env, "API_RATE_LIMIT_PER_MINUTE", d.ipPerMinute),
      writeIpPerMinute: intFrom(env, "API_WRITE_RATE_PER_MINUTE_IP", d.writeIpPerMinute),
      writeAccountPerMinute: intFrom(env, "API_WRITE_RATE_PER_MINUTE_ACCOUNT", d.writeAccountPerMinute),
      maxBodyBytes: intFrom(env, "API_MAX_BODY_BYTES", d.maxBodyBytes, 1024),
      maxPageLimit: Math.min(200, intFrom(env, "API_MAX_PAGE_LIMIT", d.maxPageLimit, 1)),
      trustProxy: env.API_TRUST_PROXY === "1",
    },
    open: { orders: intFrom(env, "API_MAX_OPEN_ORDERS", DEFAULT_OPEN.orders), invoices: intFrom(env, "API_MAX_OPEN_INVOICES", DEFAULT_OPEN.invoices), purchases: intFrom(env, "API_MAX_OPEN_PURCHASES", DEFAULT_OPEN.purchases) },
  };
}

/** A fixed window per key. Expired keys are dropped now and then, so the map cannot grow without end. */
export class WindowCounter {
  readonly #hits = new Map<string, { start: number; count: number }>();
  constructor(private readonly windowMs: number = WINDOW_MS) {}

  #entry(key: string, t: number): { start: number; count: number } {
    let e = this.#hits.get(key);
    if (!e || t - e.start >= this.windowMs) {
      if (this.#hits.size > 10_000) for (const [k, v] of this.#hits) if (t - v.start >= this.windowMs) this.#hits.delete(k);
      e = { start: t, count: 0 };
      this.#hits.set(key, e);
    }
    return e;
  }

  /** Seconds to wait when `key` is at `limit`, or 0 when there is room. Does not count. */
  wait(key: string, limit: number, t: number): number {
    if (limit <= 0) return 0;
    const e = this.#entry(key, t);
    return e.count >= limit ? Math.max(1, Math.ceil((e.start + this.windowMs - t) / 1000)) : 0;
  }

  add(key: string, t: number): void {
    this.#entry(key, t).count += 1;
  }
}

export function rateLimited(message: string, details: Record<string, unknown>, retryAfter: number): ApiError {
  return new ApiError(429, "rate_limited", message, details, { "Retry-After": String(retryAfter) });
}

/** The account that signs a write body, read from the places where the routes keep it; `null` when the body does not say (only the IP limit applies then). */
export function accountOfBody(body: unknown): string | null {
  if (body === null || typeof body !== "object") return null;
  const b = body as Record<string, any>;
  const candidates = [b.notice?.actor, b.listing?.account, b.intent?.account, b.offer?.proposer, b.referral?.seeker, b.voucher?.payer, b.order?.buyer, b.account];
  for (const c of candidates) if (typeof c === "string" && c.length > 0 && c.length <= 64) return c;
  return null;
}

/** Refuse a new object when the account already has `limit` of them open (0 = no cap). */
export function assertOpenRoom(db: Database.Database, sql: string, args: unknown[], limit: number, kind: string, account: string): void {
  if (limit <= 0) return;
  const n = row<{ n: bigint }>(db, sql, ...args)?.n ?? 0n;
  if (n >= BigInt(limit)) throw new ApiError(409, "open_limit_reached", `Account ${account} already has ${limit} open ${kind}; settle one of them first`, { kind, limit, account });
}
