import { describe, expect, it } from "vitest";
import { OpenRouterSubkeyAdapter, ProviderAccessManager, RETRY_BASE_MS, type FetchLike } from "../src/provider/index.js";
import { BrokerStore } from "../src/store.js";
import { NOW } from "./helpers.js";

const MASTER = "sk-or-v1-MANAGEMENT-do-not-leak-0123456789";
const DAY = 86_400_000;
const NS = (ms: number): string => (BigInt(ms) * 1_000_000n).toString();
const input = (over: Record<string, unknown> = {}, id = 1) => ({ grant_id: id, limits: { scope: JSON.stringify({ provider: "openrouter-subkey", grantee_ref: "agent-andi", resource: "5", permission: "daily", ...over }), expires_at: NS(NOW + 10 * DAY) } });

/** The Management API of OpenRouter, in memory: keys by hash; the secret `key` is shown once. */
function provider() {
  const keys = new Map<string, { name: string; limit: number; limit_reset: string; disabled: boolean; usage_daily: number }>();
  const calls: Array<{ method: string; path: string; auth: string | null; body: any }> = [];
  let n = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method, path, auth: headers.authorization ?? null, body: init?.body ? JSON.parse(init.body) : null });
    if (headers.authorization !== `Bearer ${MASTER}`) return new Response("{}", { status: 401 });
    if (method === "POST" && path === "/api/v1/keys") {
      const hash = `hash${String(++n).padStart(8, "0")}`;
      const b = JSON.parse(init!.body!);
      keys.set(hash, { name: b.name, limit: b.limit, limit_reset: b.limit_reset, disabled: false, usage_daily: 0 });
      return new Response(JSON.stringify({ data: { hash, name: b.name, limit: b.limit, disabled: false }, key: `sk-or-v1-DERIVED-${hash}` }), { status: 201 });
    }
    const m = /^\/api\/v1\/keys\/(\w+)$/.exec(path);
    const k = m ? keys.get(m[1] as string) : undefined;
    if (method === "GET" && m) return k ? new Response(JSON.stringify({ data: { hash: m[1], ...k } }), { status: 200 }) : new Response("{}", { status: 404 });
    if (method === "DELETE" && m) {
      if (!k) return new Response("{}", { status: 404 });
      keys.delete(m[1] as string);
      return new Response("{}", { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
  return { keys, calls, fetchImpl, adapter: (extra: Record<string, unknown> = {}) => new OpenRouterSubkeyAdapter({ managementKey: MASTER, fetch: fetchImpl, baseUrl: "https://openrouter.test/api/v1", ...extra }) };
}

describe("BE-070 fix: openrouter-subkey adapter (ADR-48 point 4, #61), mock HTTP", () => {
  it("TC-BE-070-10 a grant makes a NEW key with its own limit and reset; the lessee gets that key, never the management key; the access is marked not applicable", async () => {
    const p = provider();
    const store = new BrokerStore(":memory:");
    const m = new ProviderAccessManager({ store, now: () => NOW });
    m.register(p.adapter());
    const { access, delivery, warnings } = await m.grantAccess(input());
    const post = p.calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ name: "x207-1-agent-andi", limit: 5, limit_reset: "daily" });
    expect(post.auth).toBe(`Bearer ${MASTER}`);
    expect(delivery).toMatchObject({ provider: "openrouter-subkey", limitUsd: 5, limitReset: "daily" });
    expect((delivery.key as string).startsWith("sk-or-v1-DERIVED-")).toBe(true);
    expect(JSON.stringify([delivery, access, store.db.prepare("SELECT * FROM provider_access").all()])).not.toContain(MASTER);
    expect(JSON.stringify(access)).not.toContain("DERIVED"); // the record keeps the handle, not the key
    expect(access).toMatchObject({ status: "active", proof: "not_applicable", handle: expect.stringMatching(/^or:1:hash\d{8}$/) });
    expect(warnings).toEqual(["grantee_unproven"]);
    store.close();
  });

  it("TC-BE-070-11 the rent of the next day keeps the same key and does not show it again; a key that is gone gets a new one", async () => {
    const p = provider();
    const store = new BrokerStore(":memory:");
    const clock = { now: NOW };
    const m = new ProviderAccessManager({ store, now: () => clock.now });
    m.register(p.adapter());
    const first = await m.grantAccess(input());
    m.confirmDelivery(first.access.grantId); // the paid answer with the key went out (B7-P7)
    clock.now += DAY - 1000;
    const second = await m.grantAccess(input());
    expect(p.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(second.access.handle).toBe(first.access.handle);
    expect(second.delivery).toMatchObject({ key: null });
    // the key was deleted at the provider by hand: the next renewal makes another
    p.keys.clear();
    const third = await m.grantAccess(input());
    expect(p.calls.filter((c) => c.method === "POST")).toHaveLength(2);
    expect(third.access.handle).not.toBe(first.access.handle);
    expect(typeof third.delivery.key).toBe("string");
    store.close();
  });

  it("TC-BE-078-P7 a key whose paid answer never went out is deleted and made again by the next paid request; once delivered, the next day is a renewal (B7-P7)", async () => {
    const p = provider();
    const store = new BrokerStore(":memory:");
    const clock = { now: NOW };
    const m = new ProviderAccessManager({ store, now: () => clock.now });
    m.register(p.adapter());
    const first = await m.grantAccess(input()); // the settle failed: the lessee got a 402 and never saw this key
    expect(typeof first.delivery.key).toBe("string");
    const second = await m.grantAccess(input());
    expect(p.calls.filter((c) => c.method === "POST")).toHaveLength(2);
    expect(p.calls.filter((c) => c.method === "DELETE")).toHaveLength(1); // the first key does not live on
    expect(second.access.handle).not.toBe(first.access.handle);
    expect(typeof second.delivery.key).toBe("string");
    expect(second.access.paidUntilMs).toBe(NOW + DAY); // one day paid, from now, not two
    m.confirmDelivery(second.access.grantId);
    const third = await m.grantAccess(input());
    expect(p.calls.filter((c) => c.method === "POST")).toHaveLength(2);
    expect(third.delivery).toMatchObject({ key: null });
    store.close();
  });

  it("TC-BE-070-12 the key is deleted at the end of the paid day, and again when the provider fails first (revoke_pending)", async () => {
    const p = provider();
    const store = new BrokerStore(":memory:");
    const clock = { now: NOW };
    const m = new ProviderAccessManager({ store, now: () => clock.now });
    m.register(p.adapter());
    await m.grantAccess(input());
    expect(p.keys.size).toBe(1);
    clock.now += DAY + 1;
    const [done] = await m.sweep();
    expect(done?.status).toBe("revoked");
    expect(p.keys.size).toBe(0);
    // provider down at the end of the day
    const q = provider();
    let down = false;
    const flaky = q.adapter({ fetch: (async (u: string, i?: { method?: string }) => (down && i?.method === "DELETE" ? new Response("unavailable", { status: 503 }) : q.fetchImpl(u, i as never))) as FetchLike });
    const store2 = new BrokerStore(":memory:");
    const m2 = new ProviderAccessManager({ store: store2, now: () => clock.now });
    m2.register(flaky);
    clock.now = NOW;
    await m2.grantAccess(input());
    clock.now += DAY + 1;
    down = true;
    expect((await m2.sweep())[0]?.status).toBe("revoke_pending");
    expect(q.keys.size).toBe(1);
    down = false;
    clock.now += RETRY_BASE_MS;
    expect((await m2.sweep())[0]?.status).toBe("revoked");
    expect(q.keys.size).toBe(0);
    store.close();
    store2.close();
  });

  it("TC-BE-070-13 the scope is checked: limit in USD above 0 and under the broker's maximum, a known reset, a name for the key; nothing is made otherwise", async () => {
    const p = provider();
    const a = p.adapter({ maxLimitUsd: 10 });
    const base = { grantId: 1, granteeRef: "agent-andi", expiresAtMs: NOW + DAY };
    for (const resource of [null, "", "0", "-1", "abc", "5 USD", "1e3", "11", "1000000"]) await expect(a.grant({ ...base, resource, permission: null }), String(resource)).rejects.toThrow();
    await expect(a.grant({ ...base, resource: "5", permission: "hourly" })).rejects.toThrow(/limit_reset/);
    expect(p.calls).toEqual([]);
    expect((await a.grant({ ...base, resource: "2.5", permission: null })).delivery).toMatchObject({ limitUsd: 2.5, limitReset: "daily" });
    expect((await a.grant({ ...base, grantId: 2, resource: "10", permission: "monthly" })).delivery).toMatchObject({ limitUsd: 10, limitReset: "monthly" });
    expect(await a.verifyGranteeRef("agent-andi")).toEqual({ ok: true });
    for (const ref of ["", " x", "a b", "x".repeat(65), "../x"]) expect((await a.verifyGranteeRef(ref)).ok, ref).toBe(false);
  });

  it("TC-BE-070-14 status follows the provider (gone or disabled is absent); the cost is the spend of today in credit units; an old day is 0; the adapter is real, so hosted refuses it", async () => {
    const p = provider();
    const a = p.adapter();
    const g = await a.grant({ grantId: 3, granteeRef: "agent-andi", resource: "5", permission: "daily", expiresAtMs: NOW + DAY });
    expect(await a.status(g.handle)).toBe("active");
    const hash = g.handle.split(":")[2] as string;
    p.keys.get(hash)!.usage_daily = 1.25;
    expect(await a.cost!(g.handle, Date.now() - DAY, Date.now())).toBe(1_250_000n);
    expect(await a.cost!(g.handle, Date.now() - 3 * DAY, Date.now() - 2 * DAY)).toBe(0n);
    p.keys.get(hash)!.disabled = true;
    expect(await a.status(g.handle)).toBe("absent");
    p.keys.delete(hash);
    expect(await a.status(g.handle)).toBe("absent");
    await a.revoke(g.handle); // already gone: a success
    await expect(a.revoke("or:x")).rejects.toThrow(/handle/);
    const hosted = new ProviderAccessManager({ store: new BrokerStore(":memory:"), now: () => NOW, mode: "hosted" });
    expect(() => hosted.register(a)).toThrow(/hosted_mode_real_provider/);
  });
});
