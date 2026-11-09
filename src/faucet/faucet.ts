// BE-114: the test-funds faucet for a new user (the Privy wallet starts empty; `join` needs 0.35 NEAR, the stake needs mock USDT).
//   POST /x207/faucet  {"account_id": "...", "include_usdt"?: true}   one grant per account, ever
//   GET  /x207/faucet                                                  what is paid out and how much is left today
// Design (docs: `x207 - Faucet Test Funds` in the vault):
//   - the NEAR is the scarce part; the mock USDT (`probes/mock_ft`) has an open `mint`, so the faucet only adds convenience for it (storage_deposit + mint, paid by the faucet account);
//   - limits, in this order: shape of the account, one grant per account (primary key), per address per day, grants per day for everybody, the account must not hold funds already
//     (`fundedAboveYocto`), the faucet itself must keep a reserve. The counters are reserved in one synchronous step before any network call, so two parallel requests cannot both pass;
//   - an account that does not exist is funded only if it is an implicit account (64 hex): a transfer creates it, which is what a fresh Privy wallet is. A named account must exist already;
//   - the key of the faucet account is only in the env of the process (`X207_FAUCET_KEY`), never in a response, a log or the database;
//   - `allowInReadOnly`: the server of the public demo is read-only; this one POST stays open, it moves test funds only.
import type Database from "better-sqlite3";
import { ApiError, invalidRequest } from "../api/errors.js";
import { rateLimited } from "../api/abuse.js";
import { row } from "../api/format.js";
import type { Route } from "../api/router.js";
import { migrate } from "../db/migrate.js";
import { MARKETPLACE_MIGRATIONS } from "../marketplace/migrations.js";

const DAY_MS = 86_400_000;
const NAMED = /^(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/;
const IMPLICIT = /^[0-9a-f]{64}$/;
const NEAR = 10n ** 24n;

/** What the faucet needs from the chain; the real one is `NearFaucetChain`, the tests give a fake. */
export interface FaucetChain {
  /** Balance in yocto, or `null` when the account does not exist. */
  balance(accountId: string): Promise<bigint | null>;
  /** Spendable balance of the faucet account. */
  faucetBalance(): Promise<bigint>;
  /** Plain transfer from the faucet account; the hash of the transaction. */
  transfer(accountId: string, yocto: bigint): Promise<string>;
  /** `storage_deposit` then `mint` of the mock USDT for the account; the hashes. */
  fundUsdt(accountId: string, amount: bigint): Promise<string[]>;
}

export interface FaucetConfig {
  /** NEAR paid to the account (join deposit 0.35 + storage + gas). Default 0.6 NEAR. */
  nearYocto: bigint;
  /** Mock USDT paid, in its smallest unit (6 decimals). Default 300 USDT (the wizard stakes 150). */
  usdtAmount: bigint;
  usdtContract: string;
  /** Grants per address per rolling day. Default 3. */
  perIpPerDay: number;
  /** Grants for everybody per rolling day. Default 100. */
  perDay: number;
  /** An account holding more than this is refused as already funded. Default 1 NEAR. */
  fundedAboveYocto: bigint;
  /** The faucet refuses to pay when it would be left with less than this. Default 2 NEAR. */
  reserveYocto: bigint;
}

export const FAUCET_DEFAULTS: Omit<FaucetConfig, "usdtContract"> = {
  nearYocto: 6n * NEAR / 10n,
  usdtAmount: 300_000_000n,
  perIpPerDay: 3,
  perDay: 100,
  fundedAboveYocto: NEAR,
  reserveYocto: 2n * NEAR,
};

interface GrantRow {
  account_id: string;
  ip: string;
  state: "pending" | "near_sent" | "sent";
  near_yocto: string;
  usdt_amount: string;
  near_tx: string | null;
  usdt_txs: string | null;
  created_at_ms: bigint;
}

const fail = (status: number, code: ApiError["code"], message: string, details: Record<string, unknown> = {}): never => {
  throw new ApiError(status, code, message, details);
};

function bodyOf(raw: unknown): { accountId: string; includeUsdt: boolean } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw invalidRequest("body must be a JSON object");
  const b = raw as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => k !== "account_id" && k !== "include_usdt");
  if (unknown.length > 0) throw invalidRequest(`unknown field ${unknown[0]}`, { field: unknown[0] });
  const id = b.account_id;
  if (typeof id !== "string" || id.length < 2 || id.length > 64 || !(NAMED.test(id) || IMPLICIT.test(id))) {
    return fail(400, "faucet_bad_account", "account_id must be a NEAR account id (lowercase, 2 to 64 characters) or a 64-hex implicit account", { field: "account_id" });
  }
  if (b.include_usdt !== undefined && typeof b.include_usdt !== "boolean") throw invalidRequest("include_usdt must be a boolean", { field: "include_usdt" });
  return { accountId: id, includeUsdt: b.include_usdt !== false };
}

/** Runs the sends one after the other: the faucet account has one key, so two transactions at once would fight for the same nonce. */
class Queue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export function faucetRoutes(db: Database.Database, chain: FaucetChain, config: FaucetConfig): Route[] {
  migrate(db, MARKETPLACE_MIGRATIONS);
  const queue = new Queue();
  // `row` reads integers as bigint (safeIntegers), so counts and times go through Number
  const used = (since: number) => Number(row<{ n: bigint }>(db, "SELECT COUNT(*) AS n FROM faucet_grants WHERE created_at_ms > ?", since)?.n ?? 0n);

  return [
    {
      method: "GET",
      pattern: "/x207/faucet",
      circleScoped: false,
      handler: ({ now }) => ({
        status: 200,
        body: {
          enabled: true,
          near_yocto: config.nearYocto.toString(),
          usdt_amount: config.usdtAmount.toString(),
          usdt_contract: config.usdtContract,
          per_ip_per_day: config.perIpPerDay,
          per_day: config.perDay,
          remaining_today: Math.max(0, config.perDay - used(now() - DAY_MS)),
        },
      }),
    },
    {
      method: "POST",
      pattern: "/x207/faucet",
      circleScoped: false,
      allowInReadOnly: true,
      handler: async ({ body, ip, now }) => {
        const { accountId, includeUsdt } = bodyOf(body);
        const address = ip ?? "unknown";
        const t = now();
        const usdtAmount = includeUsdt ? config.usdtAmount : 0n;

        // one synchronous step: the checks and the reservation, so that parallel requests are counted
        const existing = row<GrantRow>(db, "SELECT * FROM faucet_grants WHERE account_id = ?", accountId);
        let resume = false;
        if (existing) {
          if (existing.state !== "near_sent") return fail(409, "faucet_already_claimed", `${accountId} has received test funds already`, { account_id: accountId });
          resume = true; // the NEAR went out, the USDT did not: the same call finishes it
        } else {
          const perIp = row<{ n: bigint; oldest: bigint | null }>(db, "SELECT COUNT(*) AS n, MIN(created_at_ms) AS oldest FROM faucet_grants WHERE ip = ? AND created_at_ms > ?", address, t - DAY_MS);
          if (Number(perIp?.n ?? 0n) >= config.perIpPerDay) {
            throw rateLimited("This address has received test funds too often today", { scope: "faucet_ip", limitPerDay: config.perIpPerDay }, Math.max(1, Math.ceil((Number(perIp?.oldest ?? BigInt(t)) + DAY_MS - t) / 1000)));
          }
          if (used(t - DAY_MS) >= config.perDay) {
            const oldest = Number(row<{ oldest: bigint | null }>(db, "SELECT MIN(created_at_ms) AS oldest FROM faucet_grants WHERE created_at_ms > ?", t - DAY_MS)?.oldest ?? BigInt(t));
            throw rateLimited("The faucet has paid its daily quota", { scope: "faucet_day", limitPerDay: config.perDay }, Math.max(1, Math.ceil((oldest + DAY_MS - t) / 1000)));
          }
          db.prepare("INSERT INTO faucet_grants (account_id, ip, state, near_yocto, usdt_amount, created_at_ms) VALUES (?, ?, 'pending', ?, ?, ?)").run(accountId, address, config.nearYocto.toString(), usdtAmount.toString(), t);
        }
        const release = () => { if (!resume) db.prepare("DELETE FROM faucet_grants WHERE account_id = ? AND state = 'pending'").run(accountId); };

        let nearTx = existing?.near_tx ?? null;
        try {
          if (!resume) {
            const held = await chain.balance(accountId);
            if (held === null && !IMPLICIT.test(accountId)) return release(), fail(404, "faucet_account_not_found", `${accountId} does not exist on the network; a named account must be created first`, { account_id: accountId });
            if (held !== null && held > config.fundedAboveYocto) return release(), fail(409, "faucet_already_funded", `${accountId} holds funds already`, { account_id: accountId, balance_yocto: held.toString() });
            if ((await chain.faucetBalance()) < config.nearYocto + config.reserveYocto) return release(), fail(503, "faucet_empty", "The faucet is empty; try again later", {});
          }
        } catch (err) {
          release();
          if (err instanceof ApiError) throw err;
          throw new ApiError(502, "faucet_failed", "The network did not answer; nothing was sent", {});
        }

        return queue.run(async () => {
          if (!resume) {
            try {
              nearTx = await chain.transfer(accountId, config.nearYocto);
            } catch {
              release();
              throw new ApiError(502, "faucet_failed", "The transfer failed; nothing was sent", { account_id: accountId });
            }
            db.prepare("UPDATE faucet_grants SET state = 'near_sent', near_tx = ? WHERE account_id = ?").run(nearTx, accountId);
          }
          let usdtTxs: string[] = [];
          if (usdtAmount > 0n || (resume && BigInt(existing?.usdt_amount ?? "0") > 0n)) {
            try {
              usdtTxs = await chain.fundUsdt(accountId, usdtAmount > 0n ? usdtAmount : BigInt(existing?.usdt_amount ?? "0"));
            } catch {
              throw new ApiError(502, "faucet_partial", "The NEAR was sent, the USDT was not; send the same request again to finish", { account_id: accountId, near_tx: nearTx });
            }
          }
          db.prepare("UPDATE faucet_grants SET state = 'sent', usdt_txs = ? WHERE account_id = ?").run(JSON.stringify(usdtTxs), accountId);
          return {
            status: 201,
            body: {
              account_id: accountId,
              near: { amount_yocto: config.nearYocto.toString(), tx: nearTx },
              usdt: usdtAmount > 0n || usdtTxs.length > 0 ? { contract: config.usdtContract, amount: (usdtAmount > 0n ? usdtAmount : BigInt(existing?.usdt_amount ?? "0")).toString(), txs: usdtTxs } : null,
            },
          };
        });
      },
    },
  ];
}
