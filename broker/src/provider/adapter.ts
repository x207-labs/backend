// P2 (BE-057, ADR-47): delegated access to a service of a provider (a code host, a chat server, a cloud role, a server over SSH). The grant on the contract says WHO may use WHAT for how long;
// an adapter makes the provider say the same: add the collaborator, give the role, open the key. One interface for every provider, so the broker, the revoker and the tests do not
// know which one they talk to. The adapter of a provider that has an expiry of its own (`expiry-time=` of SSH, the expiry of a presigned URL, the duration of an STS session) MUST use
// it: if the broker is down when the day ends, the provider still closes the access.

/** What the provider needs to know to open the access. Never holds a secret of the grantee. */
export interface ProviderGrantRequest {
  grantId: number;
  /** Who gets the access on the side of the provider: a user name, a public key, a role. Checked by `verifyGranteeRef` before this is called. */
  granteeRef: string;
  /** What is shared: a repository, a channel, a role name; the meaning belongs to the provider. */
  resource: string | null;
  /** Permission asked, e.g. `pull`, `read`, `viewer`. */
  permission: string | null;
  /** The access ends here (unix ms): the end of the paid day, never past `expires_at` of the grant. A provider with native expiry sets this on its own side. */
  expiresAtMs: number;
}

export interface ProviderGrantResult {
  /** The provider's own identifier of the access, kept to revoke it (an invitation id, a key fingerprint, a role member id). Not a secret. */
  handle: string;
  /** When the PROVIDER will close the access by itself, or `null` when the provider has no such expiry. */
  nativeExpiresAtMs: number | null;
  /** What the grantee needs to use the access (an invitation link, an endpoint). Never a secret of the grantor. */
  delivery: Record<string, unknown>;
}

export type AccessState = "active" | "absent" | "expired";

export interface ProviderAccessAdapter {
  /** Name of the provider as the scope of a grant names it (`github`, `discord`, `ssh`, `s3-presigned`, `mock`). */
  readonly provider: string;
  /** `true` for a provider that speaks to a real service with an administrator credential. Refused in `hosted` mode. */
  readonly real: boolean;
  /** `true` when the provider closes the access by itself at an instant given at grant time. */
  readonly nativeExpiry: boolean;
  /** Does the reference name an account that exists on the provider? Called before every grant (ADR-47: a grantee that cannot be checked cannot be granted). */
  verifyGranteeRef(ref: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * Optional: does the lessee control the reference? Called with the `proof` the lessee sent when it asked for the access (a signed challenge, a gist, a code placed on the account).
   * When an adapter has it, the first grant of an access needs a proof that passes; a grant cannot be pointed at an account the lessee only knows the name of.
   */
  proveGranteeRef?(ref: string, proof: string | null): Promise<boolean>;
  /** Open the access. Idempotent by `grantId`: a second call (the next day's rent) moves the expiry and returns the same `handle`. */
  grant(request: ProviderGrantRequest): Promise<ProviderGrantResult>;
  /** Close the access. Idempotent: an access that is already gone is a success. Throws when the provider could not be reached. */
  revoke(handle: string): Promise<void>;
  /** What the provider says now. */
  status(handle: string): Promise<AccessState>;
  /** Real cost in the smallest unit of the credit (6 decimals) that the access caused on the provider in `[fromMs, toMs)`; omitted when the access costs nothing. */
  cost?(handle: string, fromMs: number, toMs: number): Promise<bigint>;
}

export type ProviderAccessErrorCode =
  | "provider_unknown" | "hosted_mode_real_provider" | "grantee_ref_unverified" | "native_expiry_required" | "scope_invalid" | "cap_exceeded" | "access_not_found" | "grant_failed" | "vote_kind_forbidden" | "dao_unknown" | "delegation_not_scoped";

export class ProviderAccessError extends Error {
  constructor(readonly code: ProviderAccessErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProviderAccessError";
  }
}

/** The scope of a P2 grant (`limits.scope`, JSON): which provider, who, what, and the cap of cost per day for a paid access. */
export interface ProviderScope {
  provider: string;
  grantee_ref: string;
  resource: string | null;
  permission: string | null;
  /** Largest real cost per day (smallest unit) that the grantor accepts; the provider is asked to enforce it, and the broker closes the access if it is passed. */
  daily_cap: string | null;
}

export function parseProviderScope(scope: string): ProviderScope {
  let raw: unknown;
  try {
    raw = JSON.parse(scope);
  } catch {
    throw new ProviderAccessError("scope_invalid", "scope bukan JSON");
  }
  const s = raw as Record<string, unknown> | null;
  if (s === null || typeof s !== "object" || typeof s.provider !== "string" || !/^[a-z0-9-]{1,32}$/.test(s.provider) || typeof s.grantee_ref !== "string" || s.grantee_ref.length === 0 || s.grantee_ref.length > 256) {
    throw new ProviderAccessError("scope_invalid", "scope wajib memuat provider dan grantee_ref");
  }
  const text = (v: unknown, name: string): string | null => {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string" || v.length > 256) throw new ProviderAccessError("scope_invalid", `${name} harus teks paling banyak 256 karakter`);
    return v;
  };
  const cap = text(s.daily_cap, "daily_cap");
  if (cap !== null && !/^[1-9]\d*$/.test(cap)) throw new ProviderAccessError("scope_invalid", "daily_cap harus bilangan bulat desimal > 0");
  return { provider: s.provider, grantee_ref: s.grantee_ref, resource: text(s.resource, "resource"), permission: text(s.permission, "permission"), daily_cap: cap };
}
