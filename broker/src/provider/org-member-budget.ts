// Organisation member with a spending limit (UM-113, ADR-47 group C, catalog #25 `org:spend-limited-member`): a generic P2 adapter for an organisation account (a team of an AI platform, a cloud
// project, a SaaS workspace) that can invite a person as a member with a DAILY spending limit that the PROVIDER keeps. The admin token of the grantor stays on the machine of the broker.
//   POST   {base}/members            {email, role, daily_budget (USD)}  -> 201 {id, status: "invited"}     (409: the e-mail is a member already and is NOT ours: refused, never taken over)
//   GET    {base}/members/{id}       -> {id, email, role, status: "invited"|"active"|"removed", daily_budget, spent_today (USD)}
//   PUT    {base}/members/{id}       {role, daily_budget}               -> 200 or 404                       (the rent of the next day)
//   DELETE {base}/members/{id}                                          -> 200, 204 or 404                  (revoke: the member is taken out of the organisation)
// Scope of the grant: `grantee_ref` = the e-mail of the person, `resource` = the daily budget in USD (`20`, `2.5`), `permission` = the role (one of `allowedRoles`, default the first). The operator caps the
// budget with `maxDailyBudgetUsd`. The limit is enforced by the organisation, not counted here: a spend past it is refused there. `cost` reads `spent_today` and so is exact for the current UTC day only
// (the pattern of BE-059); `usage` says status and spend. The provider has no end date for a membership, so the broker removes the member at the end of the paid day, with the retry of the manager;
// a renewal keeps the same member and moves its budget and role to what the scope says.
import type { AccessState, ProviderAccessAdapter, ProviderGrantRequest, ProviderGrantResult } from "./adapter.js";
import { call, ProviderHttpError, type FetchLike } from "./http.js";

export interface OrgMemberBudgetOptions {
  baseUrl: string;
  /** The admin token of the grantor. It invites and removes members; it is never delivered, never logged. */
  token: string;
  /** The roles a grant may name; the first is the default. */
  allowedRoles?: readonly string[];
  /** Largest daily budget (USD) a grant may ask for; default 100. */
  maxDailyBudgetUsd?: number;
  /** Credit units (6 decimals) per USD for `cost`; default 1_000_000. */
  creditPerUsd?: number;
  now?: () => number;
  fetch?: FetchLike;
}

export interface OrgMemberUsage {
  /** `invited` (the invitation was not accepted yet), `active`, or `removed`. */
  status: string;
  dailyBudgetUsd: number;
  spentTodayUsd: number;
}

const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const ROLE = /^[a-z][a-z0-9_-]{0,31}$/;
const USD = /^(?:[1-9]\d{0,5}|0)(?:\.\d{1,4})?$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** `om:<grant id>:<id of the member>`: all that `revoke` and `status` need. Not a secret. */
const handleOf = (grantId: number, id: string): string => `om:${grantId}:${id}`;
const idOf = (handle: string): string => {
  const m = /^om:(\d+):([A-Za-z0-9_-]{1,128})$/.exec(handle);
  if (!m) throw new Error("unknown organisation member handle");
  return m[2] as string;
};

export class OrgMemberBudgetAdapter implements ProviderAccessAdapter {
  readonly provider = "org-member-budget";
  readonly real = true;
  readonly nativeExpiry = false;
  readonly #o: OrgMemberBudgetOptions;
  readonly #base: string;
  readonly #roles: readonly string[];
  readonly #fetch: FetchLike;
  readonly #now: () => number;

  constructor(options: OrgMemberBudgetOptions) {
    if (!/^https:\/\/[^\s/]+(\/\S*)?$/.test(options.baseUrl)) throw new Error("baseUrl must be an https URL");
    if (options.token === "") throw new Error("token is required");
    this.#roles = options.allowedRoles ?? ["member"];
    if (this.#roles.length === 0) throw new Error("allowedRoles is empty");
    for (const r of this.#roles) if (!ROLE.test(r)) throw new Error(`allowedRoles: ${JSON.stringify(r)} is not a role name`);
    this.#o = options;
    this.#base = options.baseUrl.replace(/\/+$/, "");
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? Date.now;
  }

  #headers(): Record<string, string> {
    return { authorization: `Bearer ${this.#o.token}`, accept: "application/json", "content-type": "application/json", "user-agent": "x207-broker" };
  }

  async verifyGranteeRef(ref: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    return EMAIL.test(ref) ? { ok: true } : { ok: false, reason: "grantee_ref is the e-mail of the person to invite" };
  }

  /** One live membership of an e-mail: a second grant would lose its member when the first ends (B4-F2). */
  sharedKey({ granteeRef }: { granteeRef: string; resource: string | null }): string | null {
    return `org-member-budget:${granteeRef.toLowerCase()}`;
  }

  #terms(request: ProviderGrantRequest): { budgetUsd: number; role: string } {
    const budget = request.resource ?? "";
    if (!USD.test(budget) || Number(budget) <= 0) throw new Error("resource must be the daily budget in USD, e.g. \"20\" or \"2.5\" (greater than 0)");
    const max = this.#o.maxDailyBudgetUsd ?? 100;
    if (Number(budget) > max) throw new Error(`daily budget ${budget} USD exceeds this broker's maxDailyBudgetUsd (${max})`);
    const role = request.permission ?? (this.#roles[0] as string);
    if (!this.#roles.includes(role)) throw new Error(`role ${JSON.stringify(role)} is not one of the roles this broker may give (${this.#roles.join(", ")})`);
    return { budgetUsd: Number(budget), role };
  }

  async grant(request: ProviderGrantRequest): Promise<ProviderGrantResult> {
    const { budgetUsd, role } = this.#terms(request);
    const delivery = { provider: "org-member-budget", email: request.granteeRef, role, dailyBudgetUsd: budgetUsd, note: "accept the invitation that the organisation sends to this address" };
    // the rent of the next day: the member is there, its budget and role are set again from the scope
    if (request.existingHandle) {
      const moved = await call(this.#fetch, "", this.#headers(), { method: "PUT", path: `${this.#base}/members/${idOf(request.existingHandle)}`, body: JSON.stringify({ role, daily_budget: budgetUsd }) }, [200, 404]);
      if (moved.status === 200) return { handle: request.existingHandle, nativeExpiresAtMs: null, delivery };
    }
    const made = await call(this.#fetch, "", this.#headers(), { method: "POST", path: `${this.#base}/members`, body: JSON.stringify({ email: request.granteeRef, role, daily_budget: budgetUsd }) }, [200, 201, 409]);
    // an e-mail that is a member already was not invited for this grant: revoke would take a real person out of the organisation
    if (made.status === 409) throw new Error(`${request.granteeRef} is already a member of the organisation and is not a member of this broker; it was not changed`);
    const id = (JSON.parse(made.text) as { id?: unknown }).id;
    if (typeof id !== "string" || !ID.test(id)) throw new Error("the provider answered the member without a usable id");
    return { handle: handleOf(request.grantId, id), nativeExpiresAtMs: null, delivery };
  }

  /** Takes the member out of the organisation. A member that is gone is a success. */
  async revoke(handle: string): Promise<void> {
    await call(this.#fetch, "", this.#headers(), { method: "DELETE", path: `${this.#base}/members/${idOf(handle)}` }, [200, 204, 404]);
  }

  /** What the organisation says about the member now. `null` when it is gone. */
  async usage(handle: string): Promise<OrgMemberUsage | null> {
    const r = await call(this.#fetch, "", this.#headers(), { method: "GET", path: `${this.#base}/members/${idOf(handle)}` }, [200, 404]);
    if (r.status === 404) return null;
    const b = JSON.parse(r.text) as { status?: unknown; daily_budget?: unknown; spent_today?: unknown };
    return { status: typeof b.status === "string" ? b.status : "unknown", dailyBudgetUsd: Number(b.daily_budget ?? 0), spentTodayUsd: Number(b.spent_today ?? 0) };
  }

  async status(handle: string): Promise<AccessState> {
    try {
      const u = await this.usage(handle);
      return u !== null && (u.status === "active" || u.status === "invited") ? "active" : "absent";
    } catch (error) {
      if (error instanceof ProviderHttpError && error.status === 404) return "absent";
      throw error;
    }
  }

  /** What the member spent today (`spent_today`, USD) in credit units. Exact for the current UTC day only; an earlier interval gives 0. */
  async cost(handle: string, _fromMs: number, toMs: number): Promise<bigint> {
    if (toMs < this.#now() - 60_000) return 0n;
    const u = await this.usage(handle);
    return u !== null && Number.isFinite(u.spentTodayUsd) && u.spentTodayUsd > 0 ? BigInt(Math.round(u.spentTodayUsd * (this.#o.creditPerUsd ?? 1_000_000))) : 0n;
  }
}
