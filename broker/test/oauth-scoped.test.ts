import { describe, expect, it } from "vitest";
import { OAuthScopedAdapter, ProviderAccessManager, type FetchLike } from "../src/provider/index.js";
import { BrokerStore } from "../src/store.js";
import { NOW } from "./helpers.js";

const DAY = 86_400_000;
const SECRET = "client-secret-do-not-leak-0123456789";
const NS = (ms: number): string => (BigInt(ms) * 1_000_000n).toString();
const input = (over: Record<string, unknown> = {}, id = 1) => ({ grant_id: id, limits: { scope: JSON.stringify({ provider: "oauth-scoped", grantee_ref: "agent-andi", resource: "read:repo write:issues", ...over }), expires_at: NS(NOW + 10 * DAY) } });
const form = (body: string | undefined) => Object.fromEntries(new URLSearchParams(body ?? ""));

/** A mock OAuth provider: token, revocation (RFC 7009) and introspection (RFC 7662) endpoints, tokens in memory. */
function provider(opts: { widen?: string; ignoreLifetime?: boolean; clock: { now: number } }) {
  const tokens = new Map<string, { scope: string; exp: number; revoked: boolean }>();
  const calls: Array<{ method: string; path: string; auth: string | null; body: Record<string, string> }> = [];
  let n = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = form(init?.body);
    calls.push({ method: init?.method ?? "GET", path, auth: headers.authorization ?? null, body });
    const expected = `Basic ${Buffer.from(`app:${SECRET}`).toString("base64")}`;
    if (headers.authorization !== expected) return new Response('{"error":"invalid_client"}', { status: 401 });
    if (path === "/oauth/token") {
      const scope = opts.widen ? `${body.scope} ${opts.widen}` : (body.scope as string);
      const lifetime = opts.ignoreLifetime ? 30 * 86_400 : Number(body.expires_in);
      const token = `tok-${String(++n).padStart(4, "0")}`;
      tokens.set(token, { scope, exp: opts.clock.now + lifetime * 1000, revoked: false });
      return new Response(JSON.stringify({ access_token: token, token_type: "Bearer", expires_in: lifetime, scope }), { status: 200 });
    }
    if (path === "/oauth/revoke") {
      const t = tokens.get(body.token as string);
      if (t) t.revoked = true;
      return new Response("", { status: 200 }); // RFC 7009: 200 also for an unknown token
    }
    if (path === "/oauth/introspect") {
      const t = tokens.get(body.token as string);
      const active = Boolean(t && !t.revoked && t.exp > opts.clock.now);
      return new Response(JSON.stringify(active ? { active, scope: t!.scope, exp: Math.floor(t!.exp / 1000) } : { active: false }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
  const adapter = (extra: Record<string, unknown> = {}) =>
    new OAuthScopedAdapter({
      tokenUrl: "https://idp.test/oauth/token", revocationUrl: "https://idp.test/oauth/revoke", introspectionUrl: "https://idp.test/oauth/introspect",
      clientId: "app", clientSecret: SECRET, allowedScopes: ["read:repo", "write:issues", "read:user"], fetch: fetchImpl, now: () => opts.clock.now, ...extra,
    });
  return { tokens, calls, adapter };
}
const setup = (opts: { widen?: string; ignoreLifetime?: boolean } = {}) => {
  const clock = { now: NOW };
  const p = provider({ ...opts, clock });
  const store = new BrokerStore(":memory:");
  const m = new ProviderAccessManager({ store, now: () => clock.now });
  m.register(p.adapter());
  return { clock, p, store, m };
};

describe("BE-083: oauth-scoped adapter (ADR-47 group B, catalog #19), mock OAuth provider", () => {
  it("TC-BE-083-01 a grant asks for exactly the scopes of the grant and the lifetime of the paid day; the lessee gets the token, never the client secret", async () => {
    const { p, m, store } = setup();
    const { access, delivery } = await m.grantAccess(input());
    const post = p.calls.find((c) => c.path === "/oauth/token")!;
    expect(post.body).toEqual({ grant_type: "client_credentials", scope: "read:repo write:issues", expires_in: String(DAY / 1000) });
    expect(delivery).toMatchObject({ provider: "oauth-scoped", accessToken: "tok-0001", tokenType: "Bearer", scope: "read:repo write:issues", expiresAtMs: NOW + DAY });
    expect(access).toMatchObject({ status: "active", proof: "not_applicable", paidUntilMs: NOW + DAY, nativeExpiresMs: NOW + DAY });
    expect(JSON.stringify([delivery, access, store.db.prepare("SELECT * FROM provider_access").all()])).not.toContain(SECRET);
    store.close();
  });

  it("TC-BE-083-02 a scope outside the permission list is refused before any call to the provider; so are an empty list and too many scopes", async () => {
    const { p, m, store } = setup();
    await expect(m.grantAccess(input({ resource: "read:repo admin:org" }))).rejects.toThrow(/admin:org is not on the permission list/);
    await expect(m.grantAccess(input({ resource: null }))).rejects.toThrow(/must name the scopes/);
    expect(p.calls).toEqual([]);
    const small = new OAuthScopedAdapter({ tokenUrl: "https://i.test/t", revocationUrl: "https://i.test/r", introspectionUrl: "https://i.test/i", clientId: "a", clientSecret: "b", allowedScopes: ["a", "b", "c"], maxScopes: 2 });
    await expect(small.grant({ grantId: 1, granteeRef: "x", resource: "a b c", permission: null, expiresAtMs: NOW + DAY })).rejects.toThrow(/at most 2 scopes/);
    store.close();
  });

  it("TC-BE-083-03 a provider that issues a wider scope than asked: the token is revoked at once and the grant fails", async () => {
    const { p, m, store } = setup({ widen: "admin:org" });
    await expect(m.grantAccess(input())).rejects.toThrow(/admin:org that was not asked for/);
    expect([...p.tokens.values()].every((t) => t.revoked)).toBe(true);
    expect(store.db.prepare("SELECT count(*) AS n FROM provider_access").get()).toEqual({ n: 0 });
    store.close();
  });

  it("TC-BE-083-04 status by introspection (RFC 7662): active, then absent after a revoke at the provider, then expired when the day is over", async () => {
    const { p, clock, m, store } = setup();
    const { access } = await m.grantAccess(input());
    const a = p.adapter();
    expect(await a.status(access.handle)).toBe("active");
    expect(p.calls.filter((c) => c.path === "/oauth/introspect").at(-1)?.body).toEqual({ token: "tok-0001", token_type_hint: "access_token" });
    p.tokens.get("tok-0001")!.revoked = true;
    expect(await a.status(access.handle)).toBe("absent");
    p.tokens.get("tok-0001")!.revoked = false;
    clock.now += DAY + 1;
    expect(await a.status(access.handle)).toBe("expired");
    store.close();
  });

  it("TC-BE-083-05 revoke by RFC 7009 at the end of the paid day; the token is dead at the provider; revoking twice is a success", async () => {
    const { p, clock, m, store } = setup();
    const { access } = await m.grantAccess(input());
    clock.now += DAY + 1;
    const [done] = await m.sweep();
    expect(done?.status).toBe("revoked");
    expect(p.tokens.get("tok-0001")!.revoked).toBe(true);
    expect(p.calls.find((c) => c.path === "/oauth/revoke")!.body).toEqual({ token: "tok-0001", token_type_hint: "access_token" });
    await expect(p.adapter().revoke(access.handle)).resolves.toBeUndefined();
    store.close();
  });

  it("TC-BE-083-06 the rent of the next day makes a NEW token for the new end and revokes the old one", async () => {
    const { p, clock, m, store } = setup();
    const first = await m.grantAccess(input());
    clock.now += DAY - 1000;
    const second = await m.grantAccess(input());
    expect(second.delivery).toMatchObject({ accessToken: "tok-0002" });
    expect(second.access.handle).not.toBe(first.access.handle);
    expect(p.tokens.get("tok-0001")!.revoked).toBe(true);
    expect(p.tokens.get("tok-0002")!.revoked).toBe(false);
    expect(second.access.paidUntilMs).toBe(NOW + 2 * DAY);
    store.close();
  });

  it("TC-BE-083-07 a provider that ignores the lifetime has no native expiry: the broker's revoke ends the token; the delivered end is the paid day", async () => {
    const { p, clock, m, store } = setup({ ignoreLifetime: true });
    const { access, delivery } = await m.grantAccess(input());
    expect(access.nativeExpiresMs).toBeNull();
    expect(delivery).toMatchObject({ expiresAtMs: NOW + DAY });
    clock.now += DAY + 1;
    await m.sweep();
    expect(p.tokens.get("tok-0001")!.revoked).toBe(true);
    store.close();
  });

  it("TC-BE-083-08 the options are checked: https endpoints, a client, a non-empty permission list of valid scope tokens", () => {
    const base = { tokenUrl: "https://i.test/t", revocationUrl: "https://i.test/r", introspectionUrl: "https://i.test/i", clientId: "a", clientSecret: "b", allowedScopes: ["x"] };
    expect(() => new OAuthScopedAdapter({ ...base, tokenUrl: "http://i.test/t" })).toThrow(/tokenUrl must be an https URL/);
    expect(() => new OAuthScopedAdapter({ ...base, clientSecret: "" })).toThrow(/clientId and clientSecret/);
    expect(() => new OAuthScopedAdapter({ ...base, allowedScopes: [] })).toThrow(/permission list/);
    expect(() => new OAuthScopedAdapter({ ...base, allowedScopes: ['bad"scope'] })).toThrow(/not a valid scope token/);
    expect(() => new OAuthScopedAdapter(base)).not.toThrow();
  });

  it("TC-BE-083-09 a failing provider never puts the client secret or a token in the error", async () => {
    const down: FetchLike = async () => new Response("unavailable", { status: 503 });
    const a = new OAuthScopedAdapter({ tokenUrl: "https://i.test/t", revocationUrl: "https://i.test/r", introspectionUrl: "https://i.test/i", clientId: "app", clientSecret: SECRET, allowedScopes: ["x"], fetch: down });
    const error = await a.grant({ grantId: 1, granteeRef: "x", resource: "x", permission: null, expiresAtMs: NOW + DAY }).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/HTTP 503/);
    expect((error as Error).message).not.toContain(SECRET);
    expect((error as Error).message).not.toContain(Buffer.from(`app:${SECRET}`).toString("base64"));
  });
});
