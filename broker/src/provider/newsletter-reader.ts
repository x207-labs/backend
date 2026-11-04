// Newsletter reader adapter (BE-088, ADR-47 group D, catalog #86 `newsletter:own-archive`): a generic P2 adapter for the publisher of its OWN newsletter or paid content (a members API like Ghost or
// Substack-style tools). A grant adds one paid reader with an end date; when the rent ends the reader goes back to the free tier (or is removed). The publisher token stays on the machine of the broker:
//   GET    {base}/members?email=<e-mail>   -> {members: [{id, email, tier, expires_at}]}       (is the reader a member already?)
//   POST   {base}/members                  {email, tier, expires_at}  -> 201 {id}
//   PUT    {base}/members/{id}             {tier, expires_at}         -> 200, 404               (upgrade, renewal, downgrade)
//   GET    {base}/members/{id}             -> {id, email, tier, expires_at}
//   DELETE {base}/members/{id}                                        -> 200, 204, 404           (only for a member this adapter made, and only with `onRevoke: "delete"`)
// Scope of the grant: `resource` = the paid tier (it must be in `paidTiers`; the free tier and any other tier are refused before any call), `permission` is not used, `grantee_ref` = the e-mail of the
// reader. A reader who was a member before the grant keeps the membership: revoke puts the reader back to `freeTier` and never deletes it. The provider holds the end date (`expires_at`) and
// serves paid content only until it; the broker also downgrades at the end of the paid day (`revoke`, with the retry of the manager). The publisher owns the content, so no real cost is reported.
import type { AccessState, ProviderAccessAdapter, ProviderGrantRequest, ProviderGrantResult } from "./adapter.js";
import { call, ProviderHttpError, type FetchLike } from "./http.js";

export interface NewsletterReaderOptions {
  baseUrl: string;
  /** The token of the publisher. Never delivered, never logged. */
  token: string;
  /** The paid tiers a grant may sell. */
  paidTiers: readonly string[];
  /** The tier a reader goes back to; default `free`. */
  freeTier?: string;
  /** `downgrade` (default): the reader stays as a free member. `delete`: a member this adapter made is removed (one that was there before is still only downgraded). */
  onRevoke?: "downgrade" | "delete";
  now?: () => number;
  fetch?: FetchLike;
}

const TIER = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** `nr:<grant id>:<member id>:<n|e>` (`n`: made by this adapter, `e`: the reader was a member before). Not a secret. */
const handleOf = (grantId: number, id: string, made: boolean): string => `nr:${grantId}:${id}:${made ? "n" : "e"}`;
const parseHandle = (handle: string): { id: string; made: boolean } => {
  const m = /^nr:(\d+):([A-Za-z0-9_-]{1,128}):([ne])$/.exec(handle);
  if (!m) throw new Error("unknown newsletter handle");
  return { id: m[2] as string, made: m[3] === "n" };
};

interface Member {
  id?: unknown;
  email?: unknown;
  tier?: unknown;
  expires_at?: unknown;
}

export class NewsletterReaderAdapter implements ProviderAccessAdapter {
  readonly provider = "newsletter-reader";
  readonly real = true;
  readonly nativeExpiry = false;
  readonly #o: NewsletterReaderOptions;
  readonly #base: string;
  readonly #paid: ReadonlySet<string>;
  readonly #free: string;
  readonly #fetch: FetchLike;
  readonly #now: () => number;

  constructor(options: NewsletterReaderOptions) {
    if (!/^https:\/\/[^\s/]+(\/\S*)?$/.test(options.baseUrl)) throw new Error("baseUrl must be an https URL");
    if (options.token === "") throw new Error("token is required");
    this.#free = options.freeTier ?? "free";
    if (!TIER.test(this.#free)) throw new Error(`freeTier ${JSON.stringify(this.#free)} is not a tier name`);
    if (options.paidTiers.length === 0) throw new Error("paidTiers is empty: name at least one paid tier");
    for (const t of options.paidTiers) {
      if (!TIER.test(t)) throw new Error(`paidTiers: ${JSON.stringify(t)} is not a tier name`);
      if (t === this.#free) throw new Error("paidTiers must not contain the free tier");
    }
    this.#o = options;
    this.#base = options.baseUrl.replace(/\/+$/, "");
    this.#paid = new Set(options.paidTiers);
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? Date.now;
  }

  #headers(): Record<string, string> {
    return { authorization: `Bearer ${this.#o.token}`, accept: "application/json", "content-type": "application/json", "user-agent": "x207-broker" };
  }

  async verifyGranteeRef(ref: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    return EMAIL.test(ref) ? { ok: true } : { ok: false, reason: "grantee_ref is the e-mail of the reader" };
  }

  /** One paid subscription of a reader: a second live grant would lose its tier when the first ends (B4-F2). */
  sharedKey({ granteeRef }: { granteeRef: string; resource: string | null }): string | null {
    return `newsletter-reader:${granteeRef.toLowerCase()}`;
  }

  #tier(request: ProviderGrantRequest): string {
    const tier = request.resource ?? "";
    if (!this.#paid.has(tier)) throw new Error(`tier ${JSON.stringify(tier)} is not one of the paid tiers this broker may sell`);
    return tier;
  }

  async #put(id: string, tier: string, expiresAt: string | null): Promise<number> {
    return (await call(this.#fetch, "", this.#headers(), { method: "PUT", path: `${this.#base}/members/${id}`, body: JSON.stringify({ tier, expires_at: expiresAt }) }, [200, 404])).status;
  }

  async grant(request: ProviderGrantRequest): Promise<ProviderGrantResult> {
    const tier = this.#tier(request);
    const expiresAt = new Date(request.expiresAtMs).toISOString();
    const delivery = { provider: "newsletter-reader", email: request.granteeRef, tier, expiresAt, note: "read with the e-mail address of the subscription" };
    // the rent of the next day: move the end of the same membership
    if (request.existingHandle) {
      const old = parseHandle(request.existingHandle);
      if ((await this.#put(old.id, tier, expiresAt)) === 200) return { handle: request.existingHandle, nativeExpiresAtMs: request.expiresAtMs, delivery };
    }
    const found = await call(this.#fetch, "", this.#headers(), { method: "GET", path: `${this.#base}/members?email=${encodeURIComponent(request.granteeRef)}` }, [200]);
    const existing = ((JSON.parse(found.text) as { members?: Member[] }).members ?? []).find((m) => typeof m.email === "string" && m.email.toLowerCase() === request.granteeRef.toLowerCase());
    if (existing !== undefined) {
      if (typeof existing.id !== "string" || !ID.test(existing.id)) throw new Error("the provider answered the member without a usable id");
      // a reader on a paid tier already (bought elsewhere): not touched, the broker must not shorten or end what it did not sell
      if (typeof existing.tier === "string" && existing.tier !== this.#free) throw new Error(`reader ${request.granteeRef} already has the tier ${existing.tier}; it was not changed`);
      if ((await this.#put(existing.id, tier, expiresAt)) !== 200) throw new Error("the member disappeared while it was upgraded");
      return { handle: handleOf(request.grantId, existing.id, false), nativeExpiresAtMs: request.expiresAtMs, delivery };
    }
    const made = await call(this.#fetch, "", this.#headers(), { method: "POST", path: `${this.#base}/members`, body: JSON.stringify({ email: request.granteeRef, tier, expires_at: expiresAt }) }, [200, 201]);
    const id = (JSON.parse(made.text) as { id?: unknown }).id;
    if (typeof id !== "string" || !ID.test(id)) throw new Error("the provider answered the member without a usable id");
    return { handle: handleOf(request.grantId, id, true), nativeExpiresAtMs: request.expiresAtMs, delivery };
  }

  /** Back to the free tier without an end date; with `onRevoke: "delete"` a member this adapter made is removed instead. A member that is gone is a success. */
  async revoke(handle: string): Promise<void> {
    const h = parseHandle(handle);
    if (this.#o.onRevoke === "delete" && h.made) {
      await call(this.#fetch, "", this.#headers(), { method: "DELETE", path: `${this.#base}/members/${h.id}` }, [200, 204, 404]);
      return;
    }
    await this.#put(h.id, this.#free, null);
  }

  /** The subscription: `active` on a paid tier whose end has not passed, `expired` on a paid tier past its end, `absent` on the free tier or when the member is gone. */
  async status(handle: string): Promise<AccessState> {
    const h = parseHandle(handle);
    try {
      const r = await call(this.#fetch, "", this.#headers(), { method: "GET", path: `${this.#base}/members/${h.id}` }, [200, 404]);
      if (r.status === 404) return "absent";
      const m = JSON.parse(r.text) as Member;
      if (typeof m.tier !== "string" || !this.#paid.has(m.tier)) return "absent";
      const end = typeof m.expires_at === "string" ? Date.parse(m.expires_at) : NaN;
      return Number.isFinite(end) && end <= this.#now() ? "expired" : "active";
    } catch (error) {
      if (error instanceof ProviderHttpError && error.status === 404) return "absent";
      throw error;
    }
  }
}
