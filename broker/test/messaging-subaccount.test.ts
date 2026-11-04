import { describe, expect, it } from "vitest";
import { MessagingSubaccountAdapter, ProviderAccessManager, RETRY_BASE_MS, type FetchLike } from "../src/provider/index.js";
import { BrokerStore } from "../src/store.js";
import { NOW } from "./helpers.js";

const DAY = 86_400_000;
const TOKEN = "messaging-admin-token-do-not-leak-0123456789";
const NS = (ms: number): string => (BigInt(ms) * 1_000_000n).toString();
const input = (over: Record<string, unknown> = {}, id = 1) => ({ grant_id: id, limits: { scope: JSON.stringify({ provider: "messaging-subaccount", grantee_ref: "agent-andi", resource: "3", permission: "5", ...over }), expires_at: NS(NOW + 10 * DAY) } });

/** A mock messaging provider: sub-accounts with a daily limit and a budget, and a send endpoint that refuses past them. */
function messaging() {
  const subs = new Map<string, { key: string; status: string; sent: number; limit: number; spent: number; budget: number }>();
  const calls: Array<{ method: string; path: string; auth: string | null; body: any }> = [];
  let n = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method, path, auth: headers.authorization ?? null, body: init?.body ? JSON.parse(init.body) : null });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (path === "/v1/subaccounts" && method === "POST") {
      if (headers.authorization !== `Bearer ${TOKEN}`) return json(401, {});
      const b = JSON.parse(init!.body!);
      const id = `sub${String(++n).padStart(4, "0")}`;
      subs.set(id, { key: `msg-key-${id}`, status: "active", sent: 0, limit: b.daily_limit, spent: 0, budget: b.budget });
      return json(201, { id, api_key: `msg-key-${id}` });
    }
    const m = /^\/v1\/subaccounts\/(\w+)(\/deactivate)?$/.exec(path);
    const s = m ? subs.get(m[1] as string) : undefined;
    if (!m || !s) return json(404, {});
    if (headers.authorization !== `Bearer ${TOKEN}`) return json(401, {});
    if (m[2]) {
      s.status = "deactivated";
      return json(200, {});
    }
    return json(200, { id: m[1], status: s.status, sent_today: s.sent, daily_limit: s.limit, spent_today: s.spent, budget: s.budget });
  };
  /** What the lessee does with its key: the provider refuses past the limits and for a deactivated sub-account. */
  const send = (id: string): number => {
    const s = subs.get(id)!;
    if (s.status !== "active") return 403;
    if (s.sent >= s.limit) return 429;
    if (s.spent + 0.01 > s.budget) return 402;
    s.sent += 1;
    s.spent += 0.01;
    return 200;
  };
  return { subs, calls, fetchImpl, send, adapter: (extra: Record<string, unknown> = {}) => new MessagingSubaccountAdapter({ baseUrl: "https://msg.test/v1", token: TOKEN, fetch: fetchImpl, now: () => NOW, ...extra }) };
}
const setup = () => {
  const p = messaging();
  const clock = { now: NOW };
  const store = new BrokerStore(":memory:");
  const m = new ProviderAccessManager({ store, now: () => clock.now });
  m.register(p.adapter({ now: () => clock.now }));
  return { p, clock, store, m };
};

describe("BE-085: messaging-subaccount adapter (ADR-47 group C, catalog #63), mock messaging provider", () => {
  it("TC-BE-085-01 a grant makes a sub-account with the daily limit and the budget of the scope; the lessee gets the sub-account key, never the admin token", async () => {
    const { p, m, store } = setup();
    const { access, delivery, warnings } = await m.grantAccess(input());
    const post = p.calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ name: "x207-1-agent-andi", daily_limit: 3, budget: 5 });
    expect(post.auth).toBe(`Bearer ${TOKEN}`);
    expect(delivery).toMatchObject({ provider: "messaging-subaccount", key: "msg-key-sub0001", dailyLimit: 3, budgetUsd: 5 });
    expect(JSON.stringify([delivery, access, store.db.prepare("SELECT * FROM provider_access").all()])).not.toContain(TOKEN);
    expect(JSON.stringify(access)).not.toContain("msg-key"); // the record keeps the id, not the key
    expect(access).toMatchObject({ status: "active", proof: "not_applicable", handle: "ms:1:sub0001" });
    expect(warnings).toEqual(["grantee_unproven"]);
    store.close();
  });

  it("TC-BE-085-02 the provider refuses a send past the daily limit; the limit was written at the provider, not counted by the broker", async () => {
    const { p, m, store } = setup();
    await m.grantAccess(input());
    expect([p.send("sub0001"), p.send("sub0001"), p.send("sub0001"), p.send("sub0001")]).toEqual([200, 200, 200, 429]);
    const u = await p.adapter().usage("ms:1:sub0001");
    expect(u).toMatchObject({ active: true, sentToday: 3, dailyLimit: 3 });
    store.close();
  });

  it("TC-BE-085-03 a limit or a budget above the caps of the operator, and malformed ones, are refused before any call", async () => {
    const { p, m, store } = setup();
    await expect(m.grantAccess(input({ resource: "5000" }))).rejects.toThrow(/exceeds this broker's maxDailyLimit/);
    await expect(m.grantAccess(input({ permission: "500" }))).rejects.toThrow(/exceeds this broker's maxBudgetUsd/);
    await expect(m.grantAccess(input({ resource: "ten" }))).rejects.toThrow(/daily send limit/);
    await expect(m.grantAccess(input({ permission: "0" }))).rejects.toThrow(/budget in USD/);
    await expect(m.grantAccess(input({ permission: null }))).rejects.toThrow(/budget in USD/);
    expect(p.calls).toEqual([]);
    store.close();
  });

  it("TC-BE-085-04 status reads the sub-account: active, absent once deactivated or gone", async () => {
    const { p, m, store } = setup();
    const { access } = await m.grantAccess(input());
    const a = p.adapter();
    expect(await a.status(access.handle)).toBe("active");
    p.subs.get("sub0001")!.status = "deactivated";
    expect(await a.status(access.handle)).toBe("absent");
    p.subs.delete("sub0001");
    expect(await a.status(access.handle)).toBe("absent");
    store.close();
  });

  it("TC-BE-085-05 revoke deactivates the sub-account at the end of the paid day: the next send is refused; revoking again is a success", async () => {
    const { p, clock, m, store } = setup();
    const { access } = await m.grantAccess(input());
    expect(p.send("sub0001")).toBe(200);
    clock.now += DAY + 1;
    const [done] = await m.sweep();
    expect(done?.status).toBe("revoked");
    expect(p.send("sub0001")).toBe(403);
    await expect(p.adapter().revoke(access.handle)).resolves.toBeUndefined();
    store.close();
  });

  it("TC-BE-085-06 the real cost of the day (BE-059): what the sub-account spent today, in credit units, is billed to the lessee and a day over the cap of the grantor closes the access", async () => {
    const { p, clock, m, store } = setup();
    await m.grantAccess(input({ daily_cap: "20000" })); // the grantor accepts 0.02 credit a day
    p.send("sub0001");
    p.send("sub0001");
    p.send("sub0001"); // 0.03 USD
    expect(await p.adapter({ now: () => clock.now }).cost("ms:1:sub0001", NOW, NOW + 1000)).toBe(30_000n);
    expect(await p.adapter({ now: () => clock.now + 5 * DAY }).cost("ms:1:sub0001", NOW, NOW + 1000)).toBe(0n); // an earlier day is not known
    expect(await m.settleDay(input({ daily_cap: "20000" }), NOW)).toEqual({ amount: 30_000n, overCap: true });
    expect(m.access(1)?.status).toBe("revoked");
    expect(p.subs.get("sub0001")!.status).toBe("deactivated");
    store.close();
  });

  it("TC-BE-085-07 the rent of the next day keeps the sub-account and does not show the key again; a sub-account that is gone gets a new one", async () => {
    const { p, clock, m, store } = setup();
    const first = await m.grantAccess(input());
    m.confirmDelivery(first.access.grantId);
    clock.now += DAY - 1000;
    const second = await m.grantAccess(input());
    expect(p.calls.filter((c) => c.method === "POST" && c.path === "/v1/subaccounts")).toHaveLength(1);
    expect(second.access.handle).toBe(first.access.handle);
    expect(second.delivery).toMatchObject({ key: null });
    p.subs.clear();
    const third = await m.grantAccess(input());
    expect(third.access.handle).not.toBe(first.access.handle);
    expect(typeof third.delivery.key).toBe("string");
    store.close();
  });

  it("TC-BE-085-08 a provider that is down at the end of the day: the access stays revoke_pending and is retried (RETRY_BASE_MS)", async () => {
    const p = messaging();
    let down = true;
    const flaky: FetchLike = async (u, i) => (down && String(u).endsWith("/deactivate") ? new Response("unavailable", { status: 503 }) : p.fetchImpl(u, i));
    const clock = { now: NOW };
    const store = new BrokerStore(":memory:");
    const m = new ProviderAccessManager({ store, now: () => clock.now });
    m.register(p.adapter({ fetch: flaky, now: () => clock.now }));
    await m.grantAccess(input());
    clock.now += DAY + 1;
    const [pending] = await m.sweep();
    expect(pending?.status).toBe("revoke_pending");
    expect(pending?.lastError).not.toContain(TOKEN);
    down = false;
    clock.now += RETRY_BASE_MS + 1;
    const [done] = await m.sweep();
    expect(done?.status).toBe("revoked");
    expect(p.subs.get("sub0001")!.status).toBe("deactivated");
    store.close();
  });

  it("TC-BE-085-09 the options and the references are checked; a bad handle is refused", async () => {
    expect(() => new MessagingSubaccountAdapter({ baseUrl: "http://m.test", token: "t" })).toThrow(/https/);
    expect(() => new MessagingSubaccountAdapter({ baseUrl: "https://m.test", token: "" })).toThrow(/token is required/);
    const a = new MessagingSubaccountAdapter({ baseUrl: "https://m.test", token: "t" });
    expect(await a.verifyGranteeRef("agent-andi")).toEqual({ ok: true });
    expect(await a.verifyGranteeRef("a b!")).toMatchObject({ ok: false });
    await expect(a.revoke("ms:1:../x")).rejects.toThrow(/unknown messaging handle/);
  });
});

describe("X-10 cross review: a sub-account that the provider suspended is not made again", () => {
  it("TC-BE-085-X10 the renewal of a suspended sub-account is refused and nothing new is created; one that is gone is made again", async () => {
    const { p, clock, m } = setup();
    const g = input();
    await m.grantAccess(g);
    m.confirmDelivery(1); // the key of the first day reached the lessee: the next day is a renewal
    expect(p.subs.size).toBe(1);
    clock.now += DAY / 2;
    p.subs.get("sub0001")!.status = "suspended"; // the provider stopped it (abuse, or the limits)
    await expect(m.grantAccess(g)).rejects.toThrow(/suspended; it was not made again/);
    expect(p.subs.size).toBe(1); // no second sub-account, no new key, no new budget
    expect(p.calls.filter((c) => c.method === "POST" && c.path === "/v1/subaccounts")).toHaveLength(1);
    p.subs.delete("sub0001"); // gone at the provider: the renewal makes it again
    const again = await m.grantAccess(g);
    expect(again.access.handle).not.toBe("");
    expect(p.subs.size).toBe(1);
  });
});
