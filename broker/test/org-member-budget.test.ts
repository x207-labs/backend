import { describe, expect, it } from "vitest";
import { OrgMemberBudgetAdapter, ProviderAccessManager, RETRY_BASE_MS, type FetchLike } from "../src/provider/index.js";
import { BrokerStore } from "../src/store.js";
import { NOW } from "./helpers.js";

const DAY = 86_400_000;
const TOKEN = "org-admin-token-opaque-0123456789abcdef";
const NS = (ms: number): string => (BigInt(ms) * 1_000_000n).toString();
const input = (over: Record<string, unknown> = {}, id = 1) => ({ grant_id: id, limits: { scope: JSON.stringify({ provider: "org-member-budget", grantee_ref: "andi@example.org", resource: "20", permission: "member", ...over }), expires_at: NS(NOW + 10 * DAY) } });

/** A mock organisation: members with a role and a daily budget; `spend` plays the member buying something, which the organisation refuses past the budget. */
function org() {
  const members = new Map<string, { email: string; role: string; status: string; budget: number; spent: number }>();
  members.set("existing-1", { email: "owner@example.org", role: "admin", status: "active", budget: 0, spent: 0 });
  const calls: Array<{ method: string; path: string; auth: string | null; body: any }> = [];
  let n = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method, path, auth: headers.authorization ?? null, body: init?.body ? JSON.parse(init.body) : null });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (headers.authorization !== `Bearer ${TOKEN}`) return json(401, {});
    if (path === "/org/members" && method === "POST") {
      const b = JSON.parse(init!.body!);
      if ([...members.values()].some((m) => m.email.toLowerCase() === String(b.email).toLowerCase() && m.status !== "removed")) return json(409, { error: "exists" });
      const id = `mem${String(++n).padStart(4, "0")}`;
      members.set(id, { email: b.email, role: b.role, status: "invited", budget: b.daily_budget, spent: 0 });
      return json(201, { id, status: "invited" });
    }
    const m = /^\/org\/members\/([\w-]+)$/.exec(path);
    const x = m ? members.get(m[1] as string) : undefined;
    if (!m || !x || x.status === "removed") return json(404, {});
    if (method === "GET") return json(200, { id: m[1], email: x.email, role: x.role, status: x.status, daily_budget: x.budget, spent_today: x.spent });
    if (method === "PUT") {
      const b = JSON.parse(init!.body!);
      x.role = b.role;
      x.budget = b.daily_budget;
      return json(200, {});
    }
    if (method === "DELETE") {
      x.status = "removed";
      return new Response(null, { status: 204 });
    }
    return json(405, {});
  };
  /** The member spends `usd` today: refused past the daily budget and for a member that is not active. */
  const spend = (id: string, usd: number): number => {
    const x = members.get(id)!;
    if (x.status !== "active") return 403;
    if (x.spent + usd > x.budget) return 402;
    x.spent += usd;
    return 200;
  };
  return { members, calls, spend, fetchImpl, adapter: (extra: Record<string, unknown> = {}) => new OrgMemberBudgetAdapter({ baseUrl: "https://org.test/org", token: TOKEN, allowedRoles: ["member", "viewer"], fetch: fetchImpl, now: () => NOW, ...extra }) };
}
const setup = () => {
  const p = org();
  const clock = { now: NOW };
  const store = new BrokerStore(":memory:");
  const m = new ProviderAccessManager({ store, now: () => clock.now });
  m.register(p.adapter({ now: () => clock.now }));
  return { p, clock, store, m };
};

describe("UM-113: org-member-budget adapter (ADR-47 group C, catalog #25), mock organisation", () => {
  it("TC-UM-113-A01 a grant invites the e-mail with the role and the daily budget of the scope; the lessee gets the address and the budget, never the admin token", async () => {
    const { p, m, store } = setup();
    const { access, delivery, warnings } = await m.grantAccess(input());
    const post = p.calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ email: "andi@example.org", role: "member", daily_budget: 20 });
    expect(post.auth).toBe(`Bearer ${TOKEN}`);
    expect(delivery).toMatchObject({ provider: "org-member-budget", email: "andi@example.org", role: "member", dailyBudgetUsd: 20 });
    expect(access).toMatchObject({ status: "active", proof: "not_applicable", handle: "om:1:mem0001" });
    expect(warnings).toEqual(["grantee_unproven"]);
    expect(JSON.stringify([delivery, access, store.db.prepare("SELECT * FROM provider_access").all()])).not.toContain(TOKEN);
    store.close();
  });

  it("TC-UM-113-A02 a budget above the cap, a malformed budget and a role that is not on the list are refused before any call", async () => {
    const { p, m, store } = setup();
    await expect(m.grantAccess(input({ resource: "500" }))).rejects.toThrow(/exceeds this broker's maxDailyBudgetUsd/);
    for (const resource of ["0", "-5", "ten", "", null]) await expect(m.grantAccess(input({ resource }))).rejects.toThrow(/daily budget in USD/);
    await expect(m.grantAccess(input({ permission: "owner" }))).rejects.toThrow(/role "owner" is not one of the roles/);
    expect(p.calls).toEqual([]);
    store.close();
  });

  it("TC-UM-113-A03 the organisation keeps the budget: the member spends up to it and the next spend is refused there", async () => {
    const { p, m, store } = setup();
    const { access } = await m.grantAccess(input({ resource: "5" }));
    p.members.get("mem0001")!.status = "active"; // the person accepted the invitation
    expect([p.spend("mem0001", 3), p.spend("mem0001", 2), p.spend("mem0001", 0.5)]).toEqual([200, 200, 402]);
    expect(await p.adapter().usage(access.handle)).toEqual({ status: "active", dailyBudgetUsd: 5, spentTodayUsd: 5 });
    store.close();
  });

  it("TC-UM-113-A04 status reads the member: an invited or active member is active, a removed or missing one is absent", async () => {
    const { p, m, store } = setup();
    const { access } = await m.grantAccess(input());
    const a = p.adapter();
    expect(await a.status(access.handle)).toBe("active"); // invited
    p.members.get("mem0001")!.status = "active";
    expect(await a.status(access.handle)).toBe("active");
    p.members.get("mem0001")!.status = "removed";
    expect(await a.status(access.handle)).toBe("absent");
    p.members.delete("mem0001");
    expect(await a.status(access.handle)).toBe("absent");
    store.close();
  });

  it("TC-UM-113-A05 revoke at the end of the paid day takes the member out of the organisation: the next spend is refused; revoking again is a success", async () => {
    const { p, clock, m, store } = setup();
    const { access } = await m.grantAccess(input());
    p.members.get("mem0001")!.status = "active";
    expect(p.spend("mem0001", 1)).toBe(200);
    clock.now += DAY + 1;
    const [done] = await m.sweep();
    expect(done?.status).toBe("revoked");
    expect(p.members.get("mem0001")!.status).toBe("removed");
    expect(p.spend("mem0001", 1)).toBe(403);
    await expect(p.adapter().revoke(access.handle)).resolves.toBeUndefined();
    store.close();
  });

  it("TC-UM-113-A06 the rent of the next day keeps the same member and sets its budget and role again; a member that is gone gets a new invitation", async () => {
    const { p, clock, m, store } = setup();
    const first = await m.grantAccess(input());
    clock.now += DAY - 1000;
    const second = await m.grantAccess(input({ resource: "30", permission: "viewer" }));
    expect(second.access.handle).toBe(first.access.handle);
    expect(p.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(p.members.get("mem0001")).toMatchObject({ budget: 30, role: "viewer" });
    p.members.get("mem0001")!.status = "removed";
    const third = await m.grantAccess(input());
    expect(third.access.handle).toBe("om:1:mem0002");
    store.close();
  });

  it("TC-UM-113-A07 an e-mail that is a member already is not taken over: the grant is refused and the member is left as it was", async () => {
    const { p, m, store } = setup();
    await expect(m.grantAccess(input({ grantee_ref: "Owner@Example.org" }))).rejects.toThrow(/already a member of the organisation and is not a member of this broker/);
    expect(p.members.get("existing-1")).toEqual({ email: "owner@example.org", role: "admin", status: "active", budget: 0, spent: 0 });
    await m.grantAccess(input());
    await expect(m.grantAccess(input({}, 2))).rejects.toThrow(/already opened the same access/); // one live membership per e-mail (B4-F2)
    store.close();
  });

  it("TC-UM-113-A08 the real spend of the day (BE-059) is billed in credit units and a day over the cap of the grantor closes the access", async () => {
    const { p, clock, m, store } = setup();
    await m.grantAccess(input({ resource: "10", daily_cap: "4000000" })); // the grantor accepts 4 credit a day
    p.members.get("mem0001")!.status = "active";
    p.spend("mem0001", 3.5);
    expect(await m.costSoFar(1)).toBe(3_500_000n);
    expect(await p.adapter({ now: () => clock.now + 5 * DAY }).cost("om:1:mem0001", NOW, NOW + 1000)).toBe(0n); // an earlier day is not known
    p.spend("mem0001", 1);
    expect(await m.settleDay(input({ resource: "10", daily_cap: "4000000" }), NOW)).toEqual({ amount: 4_500_000n, overCap: true });
    expect(m.access(1)?.status).toBe("revoked");
    expect(p.members.get("mem0001")!.status).toBe("removed");
    store.close();
  });

  it("TC-UM-113-A09 a provider that is down at the end of the day: the access stays revoke_pending and the token is not in the stored error", async () => {
    const p = org();
    let down = true;
    const flaky: FetchLike = async (u, i) => (down && i?.method === "DELETE" ? new Response(`unavailable: ${(i.headers as Record<string, string>).authorization}`, { status: 503 }) : p.fetchImpl(u, i));
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
    expect((await m.sweep())[0]?.status).toBe("revoked");
    store.close();
  });

  it("TC-UM-113-A10 the options, the references and the handle are checked", async () => {
    const base = { baseUrl: "https://o.test/org", token: "t" };
    expect(() => new OrgMemberBudgetAdapter({ ...base, baseUrl: "http://o.test" })).toThrow(/https/);
    expect(() => new OrgMemberBudgetAdapter({ ...base, token: "" })).toThrow(/token is required/);
    expect(() => new OrgMemberBudgetAdapter({ ...base, allowedRoles: [] })).toThrow(/allowedRoles is empty/);
    expect(() => new OrgMemberBudgetAdapter({ ...base, allowedRoles: ["Bad Role"] })).toThrow(/not a role name/);
    const a = new OrgMemberBudgetAdapter(base);
    expect(await a.verifyGranteeRef("andi@example.org")).toEqual({ ok: true });
    expect(await a.verifyGranteeRef("not an email")).toMatchObject({ ok: false });
    await expect(a.revoke("om:1:../x")).rejects.toThrow(/unknown organisation member handle/);
  });
});
