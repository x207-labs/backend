// Hosting sub-account adapter (BE-086, ADR-47 group C, catalog #65 `hosting:reseller-account`): a generic P2 adapter for a hosting or VPS provider with a reseller plan (WHM-like): the reseller makes
// derived accounts with quotas and an end date. The admin token of the grantor stays on the machine of the broker. A grant makes ONE derived account:
//   POST {base}/accounts               {name, disk_mb, bandwidth_gb, expires_at}  -> 201 {id, username, password}   (the password is shown once)
//   PUT  {base}/accounts/{id}          {expires_at}                               -> 200, 404                       (the rent of the next day moves the end)
//   GET  {base}/accounts/{id}          -> {id, status: "active"|"suspended", disk_mb, disk_used_mb, bandwidth_gb, bandwidth_used_gb, expires_at}
//   POST {base}/accounts/{id}/suspend                                             -> 200 or 404                     (revoke)
// Scope of the grant: `resource` = `<disk MB>:<bandwidth GB per month>` (two integers, e.g. `5120:100`); `permission` is not used; `grantee_ref` is only a name for the account (the lessee has no
// account at the provider, so there is nothing to prove: the manager marks the access `not_applicable`). The operator caps the quotas with `maxDiskMb` and `maxBandwidthGb`; a quota above the caps
// is refused before any call. The provider holds the end date (`expires_at`) and refuses to serve an account past it; the broker also suspends the account at the end of the paid day (`revoke`).
// `usage` reads the used quota. A reseller plan is paid by the grantor, so the adapter reports no real cost.
import type { AccessState, ProviderAccessAdapter, ProviderGrantRequest, ProviderGrantResult } from "./adapter.js";
import { call, ProviderHttpError, type FetchLike } from "./http.js";

export interface HostingSubaccountOptions {
  baseUrl: string;
  /** The reseller token of the grantor. It makes, extends and suspends accounts; it is never delivered, never logged. */
  token: string;
  /** Largest disk quota (MB) a grant may ask for; default 51200 (50 GB). */
  maxDiskMb?: number;
  /** Largest bandwidth quota (GB) a grant may ask for; default 1000. */
  maxBandwidthGb?: number;
  now?: () => number;
  fetch?: FetchLike;
}

export interface HostingUsage {
  active: boolean;
  diskMb: number;
  diskUsedMb: number;
  bandwidthGb: number;
  bandwidthUsedGb: number;
  expiresAtMs: number | null;
}

const REF = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/;
const QUOTA = /^([1-9]\d{0,8}):([1-9]\d{0,6})$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** `hs:<grant id>:<id of the account>`: all that `revoke` and `status` need. Not a secret. */
const handleOf = (grantId: number, id: string): string => `hs:${grantId}:${id}`;
const idOf = (handle: string): string => {
  const m = /^hs:(\d+):([A-Za-z0-9_-]{1,128})$/.exec(handle);
  if (!m) throw new Error("unknown hosting handle");
  return m[2] as string;
};

export class HostingSubaccountAdapter implements ProviderAccessAdapter {
  readonly provider = "hosting-subaccount";
  readonly real = true;
  readonly nativeExpiry = false;
  readonly oneTimeKey = true;
  readonly #o: HostingSubaccountOptions;
  readonly #base: string;
  readonly #fetch: FetchLike;
  readonly #now: () => number;

  constructor(options: HostingSubaccountOptions) {
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
    return REF.test(ref) ? { ok: true } : { ok: false, reason: "grantee_ref is the name of the account: 1 to 64 characters [A-Za-z0-9._:@-]" };
  }

  /** The quotas of a grant, checked against the caps of the operator. */
  #quota(request: ProviderGrantRequest): { diskMb: number; bandwidthGb: number } {
    const m = QUOTA.exec(request.resource ?? "");
    if (!m) throw new Error("resource must be <disk MB>:<bandwidth GB>, e.g. \"5120:100\"");
    const diskMb = Number(m[1]);
    const bandwidthGb = Number(m[2]);
    if (diskMb > (this.#o.maxDiskMb ?? 51_200)) throw new Error(`disk quota ${diskMb} MB exceeds this broker's maxDiskMb (${this.#o.maxDiskMb ?? 51_200})`);
    if (bandwidthGb > (this.#o.maxBandwidthGb ?? 1000)) throw new Error(`bandwidth quota ${bandwidthGb} GB exceeds this broker's maxBandwidthGb (${this.#o.maxBandwidthGb ?? 1000})`);
    return { diskMb, bandwidthGb };
  }

  async grant(request: ProviderGrantRequest): Promise<ProviderGrantResult> {
    const { diskMb, bandwidthGb } = this.#quota(request);
    const expiresAt = new Date(request.expiresAtMs).toISOString();
    // the rent of the next day: the account is there, move its end; its password is not shown again
    if (request.existingHandle) {
      const moved = await call(this.#fetch, "", this.#headers(), { method: "PUT", path: `${this.#base}/accounts/${idOf(request.existingHandle)}`, body: JSON.stringify({ expires_at: expiresAt }) }, [200, 404]);
      if (moved.status === 200) {
        return { handle: request.existingHandle, nativeExpiresAtMs: request.expiresAtMs, delivery: { provider: "hosting-subaccount", key: null, diskMb, bandwidthGb, expiresAt, note: "the password was shown on the first day; ask the grantor for a new access if it was lost" } };
      }
    }
    const made = await call(this.#fetch, "", this.#headers(), { method: "POST", path: `${this.#base}/accounts`, body: JSON.stringify({ name: `x207-${request.grantId}-${request.granteeRef}`.slice(0, 128), disk_mb: diskMb, bandwidth_gb: bandwidthGb, expires_at: expiresAt }) }, [200, 201]);
    const body = JSON.parse(made.text) as { id?: unknown; username?: unknown; password?: unknown };
    if (typeof body.id !== "string" || !ID.test(body.id) || typeof body.username !== "string" || typeof body.password !== "string" || body.password === "") throw new Error("the provider answered the account without id, username and password");
    return {
      handle: handleOf(request.grantId, body.id), nativeExpiresAtMs: request.expiresAtMs,
      delivery: { provider: "hosting-subaccount", key: body.password, username: body.username, diskMb, bandwidthGb, expiresAt },
    };
  }

  /** Suspends the account (it is not deleted: the data stays for the grantor to look at). A suspended or missing account is a success. */
  async revoke(handle: string): Promise<void> {
    await call(this.#fetch, "", this.#headers(), { method: "POST", path: `${this.#base}/accounts/${idOf(handle)}/suspend` }, [200, 204, 404]);
  }

  /** The quota the provider counts for the account. `null` when it is gone. */
  async usage(handle: string): Promise<HostingUsage | null> {
    const r = await call(this.#fetch, "", this.#headers(), { method: "GET", path: `${this.#base}/accounts/${idOf(handle)}` }, [200, 404]);
    if (r.status === 404) return null;
    const b = JSON.parse(r.text) as { status?: unknown; disk_mb?: unknown; disk_used_mb?: unknown; bandwidth_gb?: unknown; bandwidth_used_gb?: unknown; expires_at?: unknown };
    const end = typeof b.expires_at === "string" ? Date.parse(b.expires_at) : NaN;
    return { active: b.status === "active", diskMb: Number(b.disk_mb ?? 0), diskUsedMb: Number(b.disk_used_mb ?? 0), bandwidthGb: Number(b.bandwidth_gb ?? 0), bandwidthUsedGb: Number(b.bandwidth_used_gb ?? 0), expiresAtMs: Number.isFinite(end) ? end : null };
  }

  async status(handle: string): Promise<AccessState> {
    try {
      const u = await this.usage(handle);
      if (u === null || !u.active) return "absent";
      return u.expiresAtMs !== null && u.expiresAtMs <= this.#now() ? "expired" : "active";
    } catch (error) {
      if (error instanceof ProviderHttpError && error.status === 404) return "absent";
      throw error;
    }
  }
}
