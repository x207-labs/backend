// Messaging sub-account adapter (BE-085, ADR-47 group C, catalog #63 `messaging:subaccount`): a generic P2 adapter for an SMS or e-mail provider that has sub-accounts with their own limits. The
// admin token of the grantor stays on the machine of the broker. A grant makes a sub-account whose limits are written at the PROVIDER (the provider refuses a send past them; this adapter does not count):
//   POST {base}/subaccounts                {name, daily_limit (messages), budget (USD)}  -> 201 {id, api_key}   (the key of the sub-account is shown once)
//   GET  {base}/subaccounts/{id}           -> {id, status: "active"|"deactivated", sent_today, daily_limit, spent_today (USD), budget}
//   POST {base}/subaccounts/{id}/deactivate                                              -> 200 or 404           (revoke)
// Scope of the grant: `resource` = the daily send limit in messages (integer), `permission` = the budget in USD ("5", "2.5"); `grantee_ref` is only a name for the sub-account (the lessee has no
// account at the provider, so there is nothing to prove: the manager marks the access `not_applicable`). The operator caps both with `maxDailyLimit` and `maxBudgetUsd`.
// Cost (BE-059 pattern): `cost` reads `spent_today` and so is exact for the current UTC day only. Limits: the provider has no end date for a sub-account, so the broker deactivates it at the end of the
// paid day (`revoke`, with the retry of the manager); a renewal keeps the same sub-account and does not show its key again (the provider shows it once).
import type { AccessState, ProviderAccessAdapter, ProviderGrantRequest, ProviderGrantResult } from "./adapter.js";
import { call, ProviderHttpError, type FetchLike } from "./http.js";

export interface MessagingSubaccountOptions {
  baseUrl: string;
  /** The admin token of the grantor. It makes and deactivates sub-accounts; it is never delivered, never logged. */
  token: string;
  /** Largest daily send limit a grant may ask for; default 1000. */
  maxDailyLimit?: number;
  /** Largest budget (USD) a grant may ask for; default 50. */
  maxBudgetUsd?: number;
  /** Credit units (6 decimals) per USD for `cost`; default 1_000_000. */
  creditPerUsd?: number;
  now?: () => number;
  fetch?: FetchLike;
}

export interface MessagingUsage {
  active: boolean;
  sentToday: number;
  dailyLimit: number;
  spentTodayUsd: number;
  budgetUsd: number;
}

const REF = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/;
const COUNT = /^[1-9]\d{0,8}$/;
const USD = /^(?:[1-9]\d{0,5}|0)(?:\.\d{1,4})?$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** `ms:<grant id>:<id of the sub-account>`: all that `revoke` and `status` need. Not a secret. */
const handleOf = (grantId: number, id: string): string => `ms:${grantId}:${id}`;
const idOf = (handle: string): string => {
  const m = /^ms:(\d+):([A-Za-z0-9_-]{1,128})$/.exec(handle);
  if (!m) throw new Error("unknown messaging handle");
  return m[2] as string;
};

export class MessagingSubaccountAdapter implements ProviderAccessAdapter {
  readonly provider = "messaging-subaccount";
  readonly real = true;
  readonly nativeExpiry = false;
  readonly oneTimeKey = true;
  readonly #o: MessagingSubaccountOptions;
  readonly #base: string;
  readonly #fetch: FetchLike;
  readonly #now: () => number;

  constructor(options: MessagingSubaccountOptions) {
    if (!/^https:\/\/[^\s/]+(\/\S*)?$/.test(options.baseUrl)) throw new Error("baseUrl must be an https URL");
    if (options.token === "") throw new Error("token is required");
    this.#o = options;
    this.#base = options.baseUrl.replace(/\/+$/, "");
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? Date.now;
  }

  #headers(): Record<string, string> {
    return { authorization: `Bearer ${this.#o.token}`, accept: "application/json", "content-type": "application/json", "user-agent": "x207-broker" };
  }

  async verifyGranteeRef(ref: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    return REF.test(ref) ? { ok: true } : { ok: false, reason: "grantee_ref is the name of the sub-account: 1 to 64 characters [A-Za-z0-9._:@-]" };
  }

  /** The limits of a grant, checked against the caps of the operator. */
  #terms(request: ProviderGrantRequest): { dailyLimit: number; budgetUsd: number } {
    if (!COUNT.test(request.resource ?? "")) throw new Error("resource must be the daily send limit in messages, e.g. \"200\"");
    const dailyLimit = Number(request.resource);
    if (dailyLimit > (this.#o.maxDailyLimit ?? 1000)) throw new Error(`daily limit ${dailyLimit} exceeds this broker's maxDailyLimit (${this.#o.maxDailyLimit ?? 1000})`);
    const budget = request.permission ?? "";
    if (!USD.test(budget) || Number(budget) <= 0) throw new Error("permission must be the budget in USD, e.g. \"5\" (greater than 0)");
    if (Number(budget) > (this.#o.maxBudgetUsd ?? 50)) throw new Error(`budget ${budget} USD exceeds this broker's maxBudgetUsd (${this.#o.maxBudgetUsd ?? 50})`);
    return { dailyLimit, budgetUsd: Number(budget) };
  }

  async grant(request: ProviderGrantRequest): Promise<ProviderGrantResult> {
    const { dailyLimit, budgetUsd } = this.#terms(request);
    // the rent of the next day: the sub-account is there and its key is not shown again
    if (request.existingHandle) {
      const still = await call(this.#fetch, "", this.#headers(), { method: "GET", path: `${this.#base}/subaccounts/${idOf(request.existingHandle)}` }, [200, 404]);
      if (still.status === 200 && (JSON.parse(still.text) as { status?: unknown }).status === "active") {
        return { handle: request.existingHandle, nativeExpiresAtMs: null, delivery: { provider: "messaging-subaccount", key: null, dailyLimit, budgetUsd, note: "the key was shown on the first day; ask the grantor for a new access if it was lost" } };
      }
    }
    const made = await call(this.#fetch, "", this.#headers(), { method: "POST", path: `${this.#base}/subaccounts`, body: JSON.stringify({ name: `x207-${request.grantId}-${request.granteeRef}`.slice(0, 128), daily_limit: dailyLimit, budget: budgetUsd }) }, [200, 201]);
    const body = JSON.parse(made.text) as { id?: unknown; api_key?: unknown };
    if (typeof body.id !== "string" || !ID.test(body.id) || typeof body.api_key !== "string" || body.api_key === "") throw new Error("the provider answered the sub-account without id and api_key");
    return { handle: handleOf(request.grantId, body.id), nativeExpiresAtMs: null, delivery: { provider: "messaging-subaccount", key: body.api_key, dailyLimit, budgetUsd } };
  }

  async revoke(handle: string): Promise<void> {
    await call(this.#fetch, "", this.#headers(), { method: "POST", path: `${this.#base}/subaccounts/${idOf(handle)}/deactivate` }, [200, 204, 404]);
  }

  /** What the provider counts for the sub-account now. `null` when it is gone. */
  async usage(handle: string): Promise<MessagingUsage | null> {
    const r = await call(this.#fetch, "", this.#headers(), { method: "GET", path: `${this.#base}/subaccounts/${idOf(handle)}` }, [200, 404]);
    if (r.status === 404) return null;
    const b = JSON.parse(r.text) as { status?: unknown; sent_today?: unknown; daily_limit?: unknown; spent_today?: unknown; budget?: unknown };
    return { active: b.status === "active", sentToday: Number(b.sent_today ?? 0), dailyLimit: Number(b.daily_limit ?? 0), spentTodayUsd: Number(b.spent_today ?? 0), budgetUsd: Number(b.budget ?? 0) };
  }

  async status(handle: string): Promise<AccessState> {
    try {
      const u = await this.usage(handle);
      return u !== null && u.active ? "active" : "absent";
    } catch (error) {
      if (error instanceof ProviderHttpError && error.status === 404) return "absent";
      throw error;
    }
  }

  /** The spend of the sub-account today (`spent_today`, USD) in credit units. Exact for the current UTC day only; an earlier interval gives 0. */
  async cost(handle: string, _fromMs: number, toMs: number): Promise<bigint> {
    if (toMs < this.#now() - 60_000) return 0n;
    const u = await this.usage(handle);
    return u !== null && Number.isFinite(u.spentTodayUsd) && u.spentTodayUsd > 0 ? BigInt(Math.round(u.spentTodayUsd * (this.#o.creditPerUsd ?? 1_000_000))) : 0n;
  }
}
