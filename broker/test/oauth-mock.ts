// BE-083: a mock OAuth provider (token, RFC 7009 revocation and RFC 7662 introspection endpoints) for the tests of the oauth-scoped adapter.
import { OAuthScopedAdapter, type FetchLike } from "../src/provider/index.js";

export const SECRET = "client-secret-do-not-leak-0123456789";
const form = (body: string | undefined) => Object.fromEntries(new URLSearchParams(body ?? ""));

/** A mock OAuth provider: token, revocation (RFC 7009) and introspection (RFC 7662) endpoints, tokens in memory. */
export function provider(opts: { widen?: string; ignoreLifetime?: boolean; failRevoke?: () => boolean; clock: { now: number } }) {
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
      if (opts.failRevoke?.()) return new Response("unavailable", { status: 503 });
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
