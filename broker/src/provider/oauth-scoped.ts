// OAuth scoped-token adapter (BE-083, ADR-47 group B, catalog #19 `oauth:scoped-token`): a generic P2 adapter for any provider that speaks OAuth 2.0. The grantor's client credentials stay on
// the machine of the broker; for a grant the broker asks the token endpoint (client credentials grant, RFC 6749 4.4) for an access token that has ONLY scopes from the allowlist of the
// operator and that lives until the end of the paid day, and gives that token to the lessee.
//   POST token endpoint          grant_type=client_credentials&scope=<scopes>&expires_in=<seconds>   (Basic auth with the client)  -> {access_token, token_type, expires_in, scope}
//   POST revocation endpoint     token=<token>&token_type_hint=access_token                          (RFC 7009)  -> 200
//   POST introspection endpoint  token=<token>                                                       (RFC 7662)  -> {active, exp, scope}
// Scope of the grant: `resource` = the scopes, separated by spaces or commas (`read:repo write:issues`); `permission` is not used. `grantee_ref` is only a label of the token (the lessee has no
// account at the provider, so there is nothing to prove: the manager marks the access `not_applicable`).
// What is enforced here, not trusted to the provider: a scope outside the allowlist is refused before any call; if the provider answers with a scope that was not asked for, the token is revoked at once
// and the grant fails; `expires_in` asks the provider for the lifetime of the paid day, and a provider that ignores it is covered by the `revoke` of the manager at the end of the day.
// Limits: OAuth has no way to extend a token, so a renewal (the rent of the next day) makes a NEW token, revokes the old one and delivers the new one. The handle holds the token (it is the only
// thing RFC 7009 and RFC 7662 accept); it lives in the broker's own database and is never sent to the lessee or logged, and the error of a failed call names the path, never the body.
import type { AccessState, ProviderAccessAdapter, ProviderGrantRequest, ProviderGrantResult } from "./adapter.js";
import { call, type FetchLike } from "./http.js";

export interface OAuthScopedOptions {
  /** Token endpoint (https). */
  tokenUrl: string;
  /** RFC 7009 revocation endpoint (https). */
  revocationUrl: string;
  /** RFC 7662 introspection endpoint (https). */
  introspectionUrl: string;
  /** The client of the grantor at the provider. The secret never leaves the broker. */
  clientId: string;
  clientSecret: string;
  /** The permission list: the only scopes a grant may ask for. */
  allowedScopes: readonly string[];
  /** Largest number of scopes in one grant; default 8. */
  maxScopes?: number;
  /** Name of the parameter that asks for the lifetime in seconds; default `expires_in`; `null` to send none (the broker then revokes at the end of the day). */
  lifetimeParam?: string | null;
  now?: () => number;
  fetch?: FetchLike;
}

/** RFC 6749 3.3: a scope token is printable ASCII without space, quote and backslash. */
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/;

/** `oa:<grant id>:<expiry ms>:<token, base64url>`: all that `revoke` and `status` need, so a restart of the broker loses nothing. */
const handleOf = (grantId: number, expiresAtMs: number, token: string): string => `oa:${grantId}:${expiresAtMs}:${Buffer.from(token, "utf8").toString("base64url")}`;
const parseHandle = (handle: string): { grantId: number; expiresAtMs: number; token: string } => {
  const m = /^oa:(\d+):(\d+):([A-Za-z0-9_-]{1,4096})$/.exec(handle);
  if (!m) throw new Error("unknown OAuth handle");
  return { grantId: Number(m[1]), expiresAtMs: Number(m[2]), token: Buffer.from(m[3] as string, "base64url").toString("utf8") };
};

export class OAuthScopedAdapter implements ProviderAccessAdapter {
  readonly provider = "oauth-scoped";
  readonly real = true;
  readonly nativeExpiry = false;
  readonly #o: OAuthScopedOptions;
  readonly #allowed: ReadonlySet<string>;
  readonly #fetch: FetchLike;
  readonly #now: () => number;

  constructor(options: OAuthScopedOptions) {
    for (const [name, url] of [["tokenUrl", options.tokenUrl], ["revocationUrl", options.revocationUrl], ["introspectionUrl", options.introspectionUrl]] as const) {
      if (!/^https:\/\/[^\s/]+(\/\S*)?$/.test(url)) throw new Error(`${name} must be an https URL`);
    }
    if (options.clientId === "" || options.clientSecret === "") throw new Error("clientId and clientSecret are required");
    if (options.allowedScopes.length === 0) throw new Error("allowedScopes is empty: the permission list must name at least one scope");
    for (const s of options.allowedScopes) if (!SCOPE_TOKEN.test(s)) throw new Error(`allowedScopes: ${JSON.stringify(s)} is not a valid scope token`);
    this.#o = options;
    this.#allowed = new Set(options.allowedScopes);
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? Date.now;
  }

  #headers(): Record<string, string> {
    const basic = Buffer.from(`${encodeURIComponent(this.#o.clientId)}:${encodeURIComponent(this.#o.clientSecret)}`, "utf8").toString("base64");
    return { authorization: `Basic ${basic}`, accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": "x207-broker" };
  }

  async verifyGranteeRef(ref: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    return LABEL.test(ref) ? { ok: true } : { ok: false, reason: "grantee_ref is the label of the token: 1 to 64 characters [A-Za-z0-9._:@-]" };
  }

  /** The scopes of a grant, checked against the permission list. */
  #scopes(request: ProviderGrantRequest): string[] {
    const asked = [...new Set((request.resource ?? "").split(/[\s,]+/).filter((s) => s !== ""))];
    if (asked.length === 0) throw new Error("resource must name the scopes of the token, e.g. \"read:repo write:issues\"");
    if (asked.length > (this.#o.maxScopes ?? 8)) throw new Error(`at most ${this.#o.maxScopes ?? 8} scopes in one grant`);
    const outside = asked.filter((s) => !this.#allowed.has(s));
    if (outside.length > 0) throw new Error(`scope ${outside.join(", ")} is not on the permission list of this broker`);
    return asked;
  }

  async grant(request: ProviderGrantRequest): Promise<ProviderGrantResult> {
    const scopes = this.#scopes(request);
    const now = this.#now();
    const seconds = Math.max(1, Math.ceil((request.expiresAtMs - now) / 1000));
    const form = new URLSearchParams({ grant_type: "client_credentials", scope: scopes.join(" ") });
    const param = this.#o.lifetimeParam === undefined ? "expires_in" : this.#o.lifetimeParam;
    if (param !== null) form.set(param, String(seconds));
    const made = await call(this.#fetch, "", this.#headers(), { method: "POST", path: this.#o.tokenUrl, body: form.toString() }, [200]);
    const body = JSON.parse(made.text) as { access_token?: unknown; token_type?: unknown; expires_in?: unknown; scope?: unknown };
    if (typeof body.access_token !== "string" || body.access_token === "") throw new Error("the token endpoint answered without access_token");
    const token = body.access_token;
    // the provider may narrow the scope but never widen it
    const given = typeof body.scope === "string" ? body.scope.split(/\s+/).filter((s) => s !== "") : scopes;
    const wider = given.filter((s) => !scopes.includes(s));
    if (wider.length > 0) {
      await this.#revokeToken(token).catch(() => undefined);
      throw new Error(`the provider issued scope ${wider.join(", ")} that was not asked for; the token was revoked`);
    }
    const lifetime = Number(body.expires_in);
    const providerEnd = Number.isFinite(lifetime) && lifetime > 0 ? now + lifetime * 1000 : null;
    // native expiry only when the provider's own end is not later than the paid day (2 s of slack for the round trip)
    const nativeExpiresAtMs = providerEnd !== null && providerEnd <= request.expiresAtMs + 2_000 ? providerEnd : null;
    const endMs = Math.min(request.expiresAtMs, providerEnd ?? request.expiresAtMs);
    // OAuth cannot extend a token: the rent of the next day makes a new one and ends the old one
    if (request.existingHandle) await this.revoke(request.existingHandle).catch(() => undefined);
    return {
      handle: handleOf(request.grantId, endMs, token), nativeExpiresAtMs,
      delivery: { provider: "oauth-scoped", accessToken: token, tokenType: typeof body.token_type === "string" ? body.token_type : "Bearer", scope: given.join(" "), expiresAtMs: endMs },
    };
  }

  async #revokeToken(token: string): Promise<void> {
    await call(this.#fetch, "", this.#headers(), { method: "POST", path: this.#o.revocationUrl, body: new URLSearchParams({ token, token_type_hint: "access_token" }).toString() }, [200, 204]);
  }

  /** RFC 7009 2.2: the provider answers 200 also for a token it does not know, so an access that is already gone is a success. */
  async revoke(handle: string): Promise<void> {
    await this.#revokeToken(parseHandle(handle).token);
  }

  /** RFC 7662: `active: false` is `expired` when the paid day is over, otherwise `absent` (revoked at the provider). */
  async status(handle: string): Promise<AccessState> {
    const h = parseHandle(handle);
    const r = await call(this.#fetch, "", this.#headers(), { method: "POST", path: this.#o.introspectionUrl, body: new URLSearchParams({ token: h.token, token_type_hint: "access_token" }).toString() }, [200]);
    const body = JSON.parse(r.text) as { active?: unknown };
    if (body.active === true) return "active";
    return h.expiresAtMs <= this.#now() ? "expired" : "absent";
  }
}
