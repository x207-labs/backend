// OpenRouter sub-key adapter (BE-070 fix, ADR-48 point 4, #61): credit for AI APIs is shared ONLY through the official feature of the provider, a key made with the Management (provisioning) API
// that has its own credit limit. The master key of the grantor never reaches the lessee: the grantor's Management key stays on the machine of the broker and only makes and deletes keys; the lessee
// gets the NEW key, whose limit is the most it can spend (the loss of the grantor is at most that limit, per `limit_reset`).
//   POST   /api/v1/keys        {name, limit (USD), limit_reset}  -> 201 {data: {hash, ...}, key}      (the secret `key` is shown once)
//   GET    /api/v1/keys/{hash}                                  -> {data: {disabled, usage_daily, ...}}
//   DELETE /api/v1/keys/{hash}
// Scope of the grant: `resource` = the credit limit in USD ("5", "2.5"), `permission` = `daily` (default), `weekly` or `monthly` for `limit_reset`. `grantee_ref` is only a name for the key (the lessee has no
// account at the provider, so there is nothing to prove: the manager marks the access `not_applicable`).
// Limits: the key cannot be given an end by the provider that moves with the rent (`expires_at` is fixed at creation and the rent is renewed day by day), so the broker deletes the key at the end of the
// paid day (`revoke`, with the retry of the manager); a renewal keeps the same key and does not show it again (the provider shows it once). `cost` reads `usage_daily` and so is exact for today only.
import type { AccessState, ProviderAccessAdapter, ProviderGrantRequest, ProviderGrantResult } from "./adapter.js";
import { call, ProviderHttpError, type FetchLike } from "./http.js";

export interface OpenRouterSubkeyOptions {
  /** The Management (provisioning) key of the grantor. It makes and deletes keys and cannot call the models. */
  managementKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Largest limit (USD) a grant may ask for; default 50. */
  maxLimitUsd?: number;
  /** Smallest credit units per USD for `cost`; default 1_000_000 (1 USD = 1 credit). */
  creditPerUsd?: number;
}

const REF = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/;
const LIMIT = /^(?:[1-9]\d{0,5}|0)(?:\.\d{1,4})?$/;
const RESETS = ["daily", "weekly", "monthly"] as const;
type Reset = (typeof RESETS)[number];

/** `or:<grant id>:<hash of the key at the provider>`: all that `revoke` and `status` need, so a restart of the broker loses nothing. */
const handleOf = (grantId: number, hash: string): string => `or:${grantId}:${hash}`;
const hashOf = (handle: string): string => {
  const m = /^or:(\d+):([A-Za-z0-9]{8,128})$/.exec(handle);
  if (!m) throw new Error("unknown OpenRouter handle");
  return m[2] as string;
};

export class OpenRouterSubkeyAdapter implements ProviderAccessAdapter {
  readonly provider = "openrouter-subkey";
  readonly real = true;
  readonly nativeExpiry = false;
  readonly #o: OpenRouterSubkeyOptions;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(options: OpenRouterSubkeyOptions) {
    this.#o = options;
    this.#base = (options.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  #headers(): Record<string, string> {
    return { authorization: `Bearer ${this.#o.managementKey}`, accept: "application/json", "content-type": "application/json", "user-agent": "x207-broker" };
  }

  async verifyGranteeRef(ref: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    return REF.test(ref) ? { ok: true } : { ok: false, reason: "grantee_ref is the key name: 1 to 64 characters [A-Za-z0-9._:@-]" };
  }

  /** The limit and the reset of a grant, checked; `resource` is the limit in USD. */
  #terms(request: ProviderGrantRequest): { limit: number; reset: Reset } {
    const limit = request.resource ?? "";
    if (!LIMIT.test(limit) || Number(limit) <= 0) throw new Error("resource must be a credit limit in USD, e.g. \"5\" or \"2.5\" (greater than 0)");
    if (Number(limit) > (this.#o.maxLimitUsd ?? 50)) throw new Error(`limit ${limit} USD exceeds this broker's maxLimitUsd (${this.#o.maxLimitUsd ?? 50})`);
    const reset = (request.permission ?? "daily") as Reset;
    if (!RESETS.includes(reset)) throw new Error("permission must be daily, weekly, or monthly (limit_reset)");
    return { limit: Number(limit), reset };
  }

  async grant(request: ProviderGrantRequest): Promise<ProviderGrantResult> {
    const { limit, reset } = this.#terms(request);
    // the rent of the next day: the key is already there and is not shown again
    if (request.existingHandle) {
      const hash = hashOf(request.existingHandle);
      const still = await call(this.#fetch, this.#base, this.#headers(), { method: "GET", path: `/keys/${hash}` }, [200, 404]);
      if (still.status === 200 && (JSON.parse(still.text) as { data?: { disabled?: boolean } }).data?.disabled !== true) {
        return { handle: request.existingHandle, nativeExpiresAtMs: null, delivery: { provider: "openrouter-subkey", key: null, note: "the key was shown on the first day; ask the grantor for a new access if it was lost", limitUsd: limit, limitReset: reset } };
      }
    }
    const made = await call(this.#fetch, this.#base, this.#headers(), { method: "POST", path: "/keys", body: JSON.stringify({ name: `x207-${request.grantId}-${request.granteeRef}`.slice(0, 256), limit, limit_reset: reset }) }, [200, 201]);
    const body = JSON.parse(made.text) as { data?: { hash?: unknown }; key?: unknown };
    if (typeof body.key !== "string" || body.key === "" || typeof body.data?.hash !== "string") throw new Error("OpenRouter response does not contain key and hash");
    return {
      handle: handleOf(request.grantId, body.data.hash), nativeExpiresAtMs: null,
      delivery: { provider: "openrouter-subkey", key: body.key, baseUrl: "https://openrouter.ai/api/v1", limitUsd: limit, limitReset: reset },
    };
  }

  async revoke(handle: string): Promise<void> {
    await call(this.#fetch, this.#base, this.#headers(), { method: "DELETE", path: `/keys/${hashOf(handle)}` }, [200, 204, 404]);
  }

  async status(handle: string): Promise<AccessState> {
    try {
      const r = await call(this.#fetch, this.#base, this.#headers(), { method: "GET", path: `/keys/${hashOf(handle)}` }, [200]);
      return (JSON.parse(r.text) as { data?: { disabled?: boolean } }).data?.disabled === true ? "absent" : "active";
    } catch (error) {
      if (error instanceof ProviderHttpError && error.status === 404) return "absent";
      throw error;
    }
  }

  /** What the key spent today (`usage_daily`, USD) in credit units. Exact for the current UTC day only; an earlier interval gives 0 (the provider keeps no per-day history on the key). */
  async cost(handle: string, _fromMs: number, toMs: number): Promise<bigint> {
    if (toMs < Date.now() - 60_000) return 0n;
    const r = await call(this.#fetch, this.#base, this.#headers(), { method: "GET", path: `/keys/${hashOf(handle)}` }, [200, 404]);
    if (r.status === 404) return 0n;
    const usd = Number((JSON.parse(r.text) as { data?: { usage_daily?: unknown } }).data?.usage_daily ?? 0);
    return Number.isFinite(usd) && usd > 0 ? BigInt(Math.round(usd * (this.#o.creditPerUsd ?? 1_000_000))) : 0n;
  }
}
