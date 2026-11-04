import { describe, expect, it } from "vitest";
import { NewsletterReaderAdapter, ProviderAccessManager, type FetchLike } from "../src/provider/index.js";
import { BrokerStore } from "../src/store.js";
import { NOW } from "./helpers.js";

const DAY = 86_400_000;
const TOKEN = "publisher-token-do-not-leak-0123456789";
const NS = (ms: number): string => (BigInt(ms) * 1_000_000n).toString();
const input = (over: Record<string, unknown> = {}, id = 1) => ({ grant_id: id, limits: { scope: JSON.stringify({ provider: "newsletter-reader", grantee_ref: "reader@example.org", resource: "premium", permission: null, ...over }), expires_at: NS(NOW + 10 * DAY) } });

/** A mock members API of a publisher: members with a tier and an end; paid content is served only to a paid tier whose end has not passed. */
function publisher(clock: { now: number }) {
  const members = new Map<string, { email: string; tier: string; expires_at: string | null }>();
  const calls: Array<{ method: string; path: string; query: string; auth: string | null; body: any }> = [];
  let n = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method, path: u.pathname, query: u.search, auth: headers.authorization ?? null, body: init?.body ? JSON.parse(init.body) : null });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (headers.authorization !== `Bearer ${TOKEN}`) return json(401, {});
    if (u.pathname === "/api/members" && method === "GET") {
      const email = u.searchParams.get("email")?.toLowerCase();
      return json(200, { members: [...members].filter(([, m]) => m.email.toLowerCase() === email).map(([id, m]) => ({ id, ...m })) });
    }
    if (u.pathname === "/api/members" && method === "POST") {
      const b = JSON.parse(init!.body!);
      const id = `mem${String(++n).padStart(4, "0")}`;
      members.set(id, { email: b.email, tier: b.tier, expires_at: b.expires_at });
      return json(201, { id });
    }
    const m = /^\/api\/members\/([\w-]+)$/.exec(u.pathname);
    const member = m ? members.get(m[1] as string) : undefined;
    if (!m || !member) return json(404, {});
    if (method === "PUT") {
      const b = JSON.parse(init!.body!);
      Object.assign(member, { tier: b.tier, expires_at: b.expires_at });
      return json(200, {});
    }
    if (method === "DELETE") {
      members.delete(m[1] as string);
      return new Response(null, { status: 204 });
    }
    return json(200, { id: m[1], ...member });
  };
  /** Can this member read the paid post? */
  const canRead = (id: string): boolean => {
    const x = members.get(id);
    return Boolean(x && x.tier !== "free" && (x.expires_at === null || Date.parse(x.expires_at) > clock.now));
  };
  return { members, calls, canRead, adapter: (extra: Record<string, unknown> = {}) => new NewsletterReaderAdapter({ baseUrl: "https://pub.test/api", token: TOKEN, paidTiers: ["premium", "founder"], fetch: fetchImpl, now: () => clock.now, ...extra }) };
}
const setup = (extra: Record<string, unknown> = {}) => {
  const clock = { now: NOW };
  const p = publisher(clock);
  const store = new BrokerStore(":memory:");
  const m = new ProviderAccessManager({ store, now: () => clock.now });
  m.register(p.adapter(extra));
  return { p, clock, store, m };
};

describe("BE-088: newsletter-reader adapter (ADR-47 group D, catalog #86), mock publisher API", () => {
  it("TC-BE-088-01 a grant adds a paid reader with the tier of the scope and the end of the paid day; the reader can read, the publisher token reaches nobody", async () => {
    const { p, m, store } = setup();
    const { access, delivery } = await m.grantAccess(input());
    const post = p.calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ email: "reader@example.org", tier: "premium", expires_at: new Date(NOW + DAY).toISOString() });
    expect(post.auth).toBe(`Bearer ${TOKEN}`);
    expect(p.canRead("mem0001")).toBe(true);
    expect(delivery).toMatchObject({ provider: "newsletter-reader", email: "reader@example.org", tier: "premium" });
    expect(access).toMatchObject({ status: "active", handle: "nr:1:mem0001:n", proof: "not_applicable", nativeExpiresMs: NOW + DAY });
    expect(JSON.stringify([delivery, access, store.db.prepare("SELECT * FROM provider_access").all()])).not.toContain(TOKEN);
    store.close();
  });

  it("TC-BE-088-02 a tier outside the paid tiers (the free tier, another name, nothing) is refused before any call", async () => {
    const { p, m, store } = setup();
    for (const resource of ["free", "vip", "PREMIUM", "", null]) await expect(m.grantAccess(input({ resource }))).rejects.toThrow(/not one of the paid tiers/);
    expect(p.calls).toEqual([]);
    store.close();
  });

  it("TC-BE-088-03 a reader who is a free member already is upgraded (not duplicated); revoke puts it back to free and never deletes it", async () => {
    const { p, clock, m, store } = setup({ onRevoke: "delete" });
    p.members.set("old-1", { email: "Reader@Example.org", tier: "free", expires_at: null });
    const { access } = await m.grantAccess(input());
    expect(access.handle).toBe("nr:1:old-1:e");
    expect(p.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(p.members.get("old-1")).toMatchObject({ tier: "premium", expires_at: new Date(NOW + DAY).toISOString() });
    clock.now += DAY + 1;
    const [done] = await m.sweep();
    expect(done?.status).toBe("revoked");
    expect(p.members.get("old-1")).toEqual({ email: "Reader@Example.org", tier: "free", expires_at: null });
    store.close();
  });

  it("TC-BE-088-04 a reader who already has a paid tier is not touched: the grant is refused", async () => {
    const { p, m, store } = setup();
    p.members.set("old-2", { email: "reader@example.org", tier: "founder", expires_at: null });
    await expect(m.grantAccess(input())).rejects.toThrow(/already has the tier founder; it was not changed/);
    expect(p.members.get("old-2")).toEqual({ email: "reader@example.org", tier: "founder", expires_at: null });
    store.close();
  });

  it("TC-BE-088-05 revoke at the end of the paid day downgrades a made member to free (default); the reader can no longer read; revoking again is a success", async () => {
    const { p, clock, m, store } = setup();
    const { access } = await m.grantAccess(input());
    clock.now += DAY + 1;
    const [done] = await m.sweep();
    expect(done?.status).toBe("revoked");
    expect(p.members.get("mem0001")).toEqual({ email: "reader@example.org", tier: "free", expires_at: null });
    expect(p.canRead("mem0001")).toBe(false);
    await expect(p.adapter().revoke(access.handle)).resolves.toBeUndefined();
    store.close();
  });

  it("TC-BE-088-06 with onRevoke delete a member made by the adapter is removed", async () => {
    const { p, clock, m, store } = setup({ onRevoke: "delete" });
    await m.grantAccess(input());
    clock.now += DAY + 1;
    await m.sweep();
    expect(p.members.has("mem0001")).toBe(false);
    store.close();
  });

  it("TC-BE-088-07 status reads the subscription: active, expired once the end has passed, absent on the free tier or when the member is gone", async () => {
    const { p, clock, m, store } = setup();
    const { access } = await m.grantAccess(input());
    const a = p.adapter();
    expect(await a.status(access.handle)).toBe("active");
    clock.now += DAY + 1;
    expect(await a.status(access.handle)).toBe("expired");
    clock.now = NOW;
    p.members.get("mem0001")!.tier = "free";
    expect(await a.status(access.handle)).toBe("absent");
    p.members.delete("mem0001");
    expect(await a.status(access.handle)).toBe("absent");
    store.close();
  });

  it("TC-BE-088-08 the rent of the next day moves the end of the same membership; a member that is gone gets a new one; two live grants for one reader are refused (B4-F2)", async () => {
    const { p, clock, m, store } = setup();
    const first = await m.grantAccess(input());
    await expect(m.grantAccess(input({}, 2))).rejects.toThrow(/already opened the same access/);
    clock.now += DAY - 1000;
    const second = await m.grantAccess(input());
    expect(second.access.handle).toBe(first.access.handle);
    expect(p.members.get("mem0001")!.expires_at).toBe(new Date(NOW + 2 * DAY).toISOString());
    p.members.clear();
    const third = await m.grantAccess(input());
    expect(third.access.handle).toBe("nr:1:mem0002:n");
    store.close();
  });

  it("TC-BE-088-09 the options, the references and the handle are checked; a failing provider never puts the token in the error", async () => {
    const base = { baseUrl: "https://p.test/api", token: "t", paidTiers: ["premium"] };
    expect(() => new NewsletterReaderAdapter({ ...base, baseUrl: "http://p.test" })).toThrow(/https/);
    expect(() => new NewsletterReaderAdapter({ ...base, token: "" })).toThrow(/token is required/);
    expect(() => new NewsletterReaderAdapter({ ...base, paidTiers: [] })).toThrow(/paidTiers is empty/);
    expect(() => new NewsletterReaderAdapter({ ...base, paidTiers: ["free"] })).toThrow(/must not contain the free tier/);
    expect(() => new NewsletterReaderAdapter({ ...base, paidTiers: ["Bad Tier"] })).toThrow(/not a tier name/);
    const a = new NewsletterReaderAdapter(base);
    expect(await a.verifyGranteeRef("reader@example.org")).toEqual({ ok: true });
    expect(await a.verifyGranteeRef("not an email")).toMatchObject({ ok: false });
    await expect(a.revoke("nr:1:../x:n")).rejects.toThrow(/unknown newsletter handle/);
    const down: FetchLike = async () => new Response("unavailable", { status: 503 });
    const b = new NewsletterReaderAdapter({ ...base, token: TOKEN, fetch: down });
    const error = await b.grant({ grantId: 1, granteeRef: "reader@example.org", resource: "premium", permission: null, expiresAtMs: NOW + DAY }).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/HTTP 503/);
    expect((error as Error).message).not.toContain(TOKEN);
  });
});
