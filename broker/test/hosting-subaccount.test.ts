import { describe, expect, it } from "vitest";
import { HostingSubaccountAdapter, ProviderAccessManager, type FetchLike } from "../src/provider/index.js";
import { BrokerStore } from "../src/store.js";
import { NOW } from "./helpers.js";

const DAY = 86_400_000;
const TOKEN = "reseller-token-do-not-leak-0123456789";
const NS = (ms: number): string => (BigInt(ms) * 1_000_000n).toString();
const input = (over: Record<string, unknown> = {}, id = 1) => ({ grant_id: id, limits: { scope: JSON.stringify({ provider: "hosting-subaccount", grantee_ref: "site-andi", resource: "5120:100", permission: null, ...over }), expires_at: NS(NOW + 10 * DAY) } });

/** A mock reseller API: derived accounts with quotas and an end date; the provider refuses to serve a suspended or expired account or one past its quota. */
function hosting(clock: { now: number }) {
  const accounts = new Map<string, { status: string; disk: number; diskUsed: number; bw: number; bwUsed: number; expires: string }>();
  const calls: Array<{ method: string; path: string; auth: string | null; body: any }> = [];
  let n = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method, path, auth: headers.authorization ?? null, body: init?.body ? JSON.parse(init.body) : null });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (headers.authorization !== `Bearer ${TOKEN}`) return json(401, {});
    if (path === "/r/accounts" && method === "POST") {
      const b = JSON.parse(init!.body!);
      const id = `acc${String(++n).padStart(4, "0")}`;
      accounts.set(id, { status: "active", disk: b.disk_mb, diskUsed: 0, bw: b.bandwidth_gb, bwUsed: 0, expires: b.expires_at });
      return json(201, { id, username: `u_${id}`, password: `pw-${id}-ONCE` });
    }
    const m = /^\/r\/accounts\/(\w+)(\/suspend)?$/.exec(path);
    const a = m ? accounts.get(m[1] as string) : undefined;
    if (!m || !a) return json(404, {});
    if (m[2]) {
      a.status = "suspended";
      return json(200, {});
    }
    if (method === "PUT") {
      a.expires = JSON.parse(init!.body!).expires_at;
      return json(200, {});
    }
    return json(200, { id: m[1], status: a.status, disk_mb: a.disk, disk_used_mb: a.diskUsed, bandwidth_gb: a.bw, bandwidth_used_gb: a.bwUsed, expires_at: a.expires });
  };
  /** What the lessee does with the account: the provider serves it only while it is active, not expired and under its quota. */
  const use = (id: string, diskMb: number): number => {
    const a = accounts.get(id)!;
    if (a.status !== "active") return 403;
    if (Date.parse(a.expires) <= clock.now) return 403;
    if (a.diskUsed + diskMb > a.disk) return 507;
    a.diskUsed += diskMb;
    return 200;
  };
  return { accounts, calls, use, adapter: (extra: Record<string, unknown> = {}) => new HostingSubaccountAdapter({ baseUrl: "https://host.test/r", token: TOKEN, fetch: fetchImpl, now: () => clock.now, ...extra }) };
}
const setup = () => {
  const clock = { now: NOW };
  const p = hosting(clock);
  const store = new BrokerStore(":memory:");
  const m = new ProviderAccessManager({ store, now: () => clock.now });
  m.register(p.adapter());
  return { p, clock, store, m };
};

describe("BE-086: hosting-subaccount adapter (ADR-47 group C, catalog #65), mock reseller provider", () => {
  it("TC-BE-086-01 a grant makes a derived account with the quotas and the end of the paid day; the lessee gets the login once, never the reseller token", async () => {
    const { p, m, store } = setup();
    const { access, delivery } = await m.grantAccess(input());
    const post = p.calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ name: "x207-1-site-andi", disk_mb: 5120, bandwidth_gb: 100, expires_at: new Date(NOW + DAY).toISOString() });
    expect(post.auth).toBe(`Bearer ${TOKEN}`);
    expect(delivery).toMatchObject({ provider: "hosting-subaccount", username: "u_acc0001", key: "pw-acc0001-ONCE", diskMb: 5120, bandwidthGb: 100 });
    expect(access).toMatchObject({ status: "active", proof: "not_applicable", handle: "hs:1:acc0001", nativeExpiresMs: NOW + DAY });
    expect(JSON.stringify([delivery, access, store.db.prepare("SELECT * FROM provider_access").all()])).not.toContain(TOKEN);
    expect(JSON.stringify(access)).not.toContain("ONCE");
    store.close();
  });

  it("TC-BE-086-02 a quota above the caps of the operator or a malformed one is refused before any call", async () => {
    const { p, m, store } = setup();
    await expect(m.grantAccess(input({ resource: "999999:100" }))).rejects.toThrow(/exceeds this broker's maxDiskMb/);
    await expect(m.grantAccess(input({ resource: "5120:5000" }))).rejects.toThrow(/exceeds this broker's maxBandwidthGb/);
    for (const resource of ["5120", "0:10", "5120:0", "a:b", "5120:100:1", "-1:5", null]) await expect(m.grantAccess(input({ resource }))).rejects.toThrow(/resource must be <disk MB>:<bandwidth GB>/);
    expect(p.calls).toEqual([]);
    store.close();
  });

  it("TC-BE-086-03 the provider keeps the quota: past the disk quota the account is refused", async () => {
    const { p, m, store } = setup();
    await m.grantAccess(input({ resource: "100:5" }));
    expect([p.use("acc0001", 60), p.use("acc0001", 60)]).toEqual([200, 507]);
    expect(await p.adapter().usage("hs:1:acc0001")).toMatchObject({ active: true, diskMb: 100, diskUsedMb: 60, bandwidthGb: 5 });
    store.close();
  });

  it("TC-BE-086-04 status reads the account: active, expired once its end has passed, absent when suspended or gone", async () => {
    const { p, clock, m, store } = setup();
    const { access } = await m.grantAccess(input());
    const a = p.adapter();
    expect(await a.status(access.handle)).toBe("active");
    clock.now += DAY + 1;
    expect(await a.status(access.handle)).toBe("expired");
    clock.now = NOW;
    p.accounts.get("acc0001")!.status = "suspended";
    expect(await a.status(access.handle)).toBe("absent");
    p.accounts.delete("acc0001");
    expect(await a.status(access.handle)).toBe("absent");
    store.close();
  });

  it("TC-BE-086-05 revoke suspends the account at the end of the paid day (it is not deleted); the next use is refused; revoking again is a success", async () => {
    const { p, clock, m, store } = setup();
    const { access } = await m.grantAccess(input());
    expect(p.use("acc0001", 1)).toBe(200);
    clock.now += DAY + 1;
    const [done] = await m.sweep();
    expect(done?.status).toBe("revoked");
    expect(p.accounts.get("acc0001")!.status).toBe("suspended");
    expect(p.use("acc0001", 1)).toBe(403);
    await expect(p.adapter().revoke(access.handle)).resolves.toBeUndefined();
    store.close();
  });

  it("TC-BE-086-06 the rent of the next day moves the end of the same account and does not show the password again; an account that is gone gets a new one", async () => {
    const { p, clock, m, store } = setup();
    const first = await m.grantAccess(input());
    m.confirmDelivery(first.access.grantId);
    clock.now += DAY - 1000;
    const second = await m.grantAccess(input());
    expect(second.access.handle).toBe(first.access.handle);
    expect(second.delivery).toMatchObject({ key: null });
    expect(p.calls.filter((c) => c.method === "POST" && c.path === "/r/accounts")).toHaveLength(1);
    expect(p.accounts.get("acc0001")!.expires).toBe(new Date(NOW + 2 * DAY).toISOString());
    p.accounts.clear();
    const third = await m.grantAccess(input());
    expect(third.access.handle).not.toBe(first.access.handle);
    expect(typeof third.delivery.key).toBe("string");
    store.close();
  });

  it("TC-BE-086-07 the options, the references and the handle are checked; a failing provider never puts the token in the error", async () => {
    expect(() => new HostingSubaccountAdapter({ baseUrl: "http://h.test", token: "t" })).toThrow(/https/);
    expect(() => new HostingSubaccountAdapter({ baseUrl: "https://h.test", token: "" })).toThrow(/token is required/);
    const a = new HostingSubaccountAdapter({ baseUrl: "https://h.test", token: "t" });
    expect(await a.verifyGranteeRef("site-andi")).toEqual({ ok: true });
    expect(await a.verifyGranteeRef("a b!")).toMatchObject({ ok: false });
    await expect(a.revoke("hs:1:../x")).rejects.toThrow(/unknown hosting handle/);
    const down: FetchLike = async () => new Response("unavailable", { status: 503 });
    const b = new HostingSubaccountAdapter({ baseUrl: "https://h.test/r", token: TOKEN, fetch: down });
    const error = await b.grant({ grantId: 1, granteeRef: "x", resource: "10:1", permission: null, expiresAtMs: NOW + DAY }).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/HTTP 503/);
    expect((error as Error).message).not.toContain(TOKEN);
  });
});
