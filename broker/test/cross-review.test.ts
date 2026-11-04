import { describe, expect, it } from "vitest";
import { OAuthScopedAdapter, ProviderAccessManager, type FetchLike, type ProviderAccessAdapter } from "../src/provider/index.js";
import { ProviderHttpError, call } from "../src/provider/http.js";
import { NewsletterReaderAdapter } from "../src/provider/newsletter-reader.js";
import { BrokerStore } from "../src/store.js";
import { NOW } from "./helpers.js";

const DAY = 86_400_000;

// UM-112: cross review of the adapters and the fixes of the security batch 8. Each test is a finding that was checked in the code and is closed here.
describe("UM-112 cross review: oauth-scoped", () => {
  const adapterWith = (fetchImpl: FetchLike) => new OAuthScopedAdapter({
    tokenUrl: "https://idp.test/token", revocationUrl: "https://idp.test/revoke", introspectionUrl: "https://idp.test/introspect",
    clientId: "app", clientSecret: "client-secret-0123456789", allowedScopes: ["read:repo"], fetch: fetchImpl, now: () => NOW,
  });
  const request = (grantId: number, existingHandle: string | null = null) => ({ grantId, granteeRef: "agent-andi", resource: "read:repo", permission: null, expiresAtMs: NOW + DAY, existingHandle });

  it("TC-UM-112-01 F3: a provider that answers the same token twice does not have the token just made revoked by the renewal", async () => {
    const revoked: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const path = new URL(url).pathname;
      if (path === "/token") return new Response(JSON.stringify({ access_token: "cached-token-0001", token_type: "Bearer", expires_in: 86_400, scope: "read:repo" }), { status: 200 });
      if (path === "/revoke") { revoked.push(new URLSearchParams(init?.body).get("token") ?? ""); return new Response("", { status: 200 }); }
      return new Response("{}", { status: 404 });
    };
    const a = adapterWith(fetchImpl);
    const first = await a.grant(request(1));
    const second = await a.grant(request(1, first.handle));
    expect(second.delivery.accessToken).toBe("cached-token-0001");
    expect(revoked).toEqual([]); // the renewal made the same token again: nothing is revoked
  });

  it("TC-UM-112-02 F4: if the previous token cannot be revoked at the renewal, the new one is revoked and the call fails, so the record keeps the previous handle", async () => {
    let n = 0;
    const revoked: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const path = new URL(url).pathname;
      if (path === "/token") return new Response(JSON.stringify({ access_token: `tok-${++n}-abcdef`, token_type: "Bearer", expires_in: 86_400, scope: "read:repo" }), { status: 200 });
      const token = new URLSearchParams(init?.body).get("token") ?? "";
      if (path === "/revoke" && token === "tok-1-abcdef") return new Response("unavailable", { status: 503 });
      if (path === "/revoke") { revoked.push(token); return new Response("", { status: 200 }); }
      return new Response("{}", { status: 404 });
    };
    const a = adapterWith(fetchImpl);
    const first = await a.grant(request(1));
    await expect(a.grant(request(1, first.handle))).rejects.toThrow(/previous token could not be revoked/);
    expect(revoked).toEqual(["tok-2-abcdef"]); // the one that would have been lost
  });

  it("TC-UM-112-03 F5: an opaque token that the provider echoes in the error of a revoke is cut out of the message", async () => {
    const fetchImpl: FetchLike = async (url) => {
      const path = new URL(url).pathname;
      if (path === "/token") return new Response(JSON.stringify({ access_token: "opaque-7f3a9c0d41b2", token_type: "Bearer", expires_in: 86_400, scope: "read:repo" }), { status: 200 });
      return new Response('{"error_description":"token opaque-7f3a9c0d41b2 malformed"}', { status: 400 });
    };
    const a = adapterWith(fetchImpl);
    const granted = await a.grant(request(1));
    const failure = await a.revoke(granted.handle).then(() => null, (e: unknown) => e as Error);
    expect(failure).toBeInstanceOf(ProviderHttpError);
    expect(failure!.message).not.toContain("opaque-7f3a9c0d41b2");
    expect(failure!.message).toContain("[redacted]");
  });

  it("TC-UM-112-04 F5: the raw form of a URL-encoded client secret is cut out too", async () => {
    const secret = "pa ss/word+with=chars";
    const encoded = encodeURIComponent(secret);
    const basic = `Basic ${Buffer.from(`app:${encoded}`).toString("base64")}`;
    const fetchImpl: FetchLike = async () => new Response(`bad client: ${secret}`, { status: 401 });
    const failure = await call(fetchImpl, "https://idp.test", { authorization: basic }, { method: "POST", path: "/x" }, [200]).then(() => null, (e: unknown) => e as Error);
    expect(failure!.message).not.toContain(secret);
  });
});

describe("UM-112 cross review: newsletter-reader", () => {
  it("TC-UM-112-05 F7: a reader that bought its own subscription (no end date) is not downgraded at the end of the rent and not shortened by a renewal", async () => {
    const member = { id: "m1", email: "reader@example.com", tier: "gold", expires_at: "2026-11-05T00:00:00.000Z" as string | null };
    const writes: unknown[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const u = new URL(url);
      const method = init?.method ?? "GET";
      if (u.pathname === "/members" && method === "GET") return new Response(JSON.stringify({ members: [] }), { status: 200 });
      if (u.pathname === "/members" && method === "POST") return new Response(JSON.stringify({ id: member.id }), { status: 201 });
      if (u.pathname === "/members/m1" && method === "GET") return new Response(JSON.stringify(member), { status: 200 });
      if (u.pathname === "/members/m1" && method === "PUT") { writes.push(JSON.parse(init!.body!)); return new Response("{}", { status: 200 }); }
      return new Response("{}", { status: 404 });
    };
    const a = new NewsletterReaderAdapter({ baseUrl: "https://news.test", token: "publisher-token-0123", paidTiers: ["gold"], fetch: fetchImpl, now: () => NOW });
    const request = { grantId: 1, granteeRef: "reader@example.com", resource: "gold", permission: null, expiresAtMs: NOW + DAY, existingHandle: null };
    const granted = await a.grant(request);
    // during the day the reader buys a subscription of its own: the same member now has a paid tier and no end date
    member.expires_at = null;
    await expect(a.grant({ ...request, existingHandle: granted.handle })).rejects.toThrow(/changed outside x207/);
    await a.revoke(granted.handle); // nothing to undo: it is not ours any more
    expect(writes).toEqual([]);
    // a member that is still ours is put back to the free tier
    member.expires_at = "2026-11-05T00:00:00.000Z";
    await a.revoke(granted.handle);
    expect(writes).toEqual([{ tier: "free", expires_at: null }]);
    // a member that is gone is a success
    const gone = new NewsletterReaderAdapter({ baseUrl: "https://news.test", token: "publisher-token-0123", paidTiers: ["gold"], fetch: async () => new Response("{}", { status: 404 }), now: () => NOW });
    await expect(gone.revoke(granted.handle)).resolves.toBeUndefined();
  });
});

describe("UM-112 cross review: the close of an access that is still being made", () => {
  it("TC-UM-112-06 F9: revokeAccess waits for the first paid rent of the grant that is in flight and then closes it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const revoked: string[] = [];
    const slow: ProviderAccessAdapter = {
      provider: "slow", real: false, nativeExpiry: false,
      verifyGranteeRef: async () => ({ ok: true }),
      grant: async (r) => { await gate; return { handle: `slow:${r.grantId}`, nativeExpiresAtMs: null, delivery: {} }; },
      revoke: async (h) => { revoked.push(h); },
      status: async () => "active",
    };
    const store = new BrokerStore(":memory:");
    const m = new ProviderAccessManager({ store, now: () => NOW });
    m.register(slow);
    const input = { grant_id: 5, limits: { scope: JSON.stringify({ provider: "slow", grantee_ref: "x", resource: null, permission: null }), expires_at: (BigInt(NOW + 10 * DAY) * 1_000_000n).toString() } };
    const granting = m.grantAccess(input);
    await Promise.resolve();
    expect(m.access(5)).toBeUndefined(); // no row yet: a check done before the call would have dropped the close
    const closing = m.revokeAccess(5, "revoked");
    release();
    await granting;
    const closed = await closing;
    expect(closed.status).toBe("revoked");
    expect(revoked).toEqual(["slow:5"]);
    store.close();
  });
});
