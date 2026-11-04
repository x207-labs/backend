import { describe, expect, it } from "vitest";
import { ProviderAccessManager, SaasSeatScimAdapter, type FetchLike } from "../src/provider/index.js";
import { BrokerStore } from "../src/store.js";
import { NOW } from "./helpers.js";

const DAY = 86_400_000;
const TOKEN = "scim-token-do-not-leak-0123456789";
const NS = (ms: number): string => (BigInt(ms) * 1_000_000n).toString();
const input = (over: Record<string, unknown> = {}, id = 1) => ({ grant_id: id, limits: { scope: JSON.stringify({ provider: "saas-seat-scim", grantee_ref: "andi@example.org", resource: "grp-team", permission: null, ...over }), expires_at: NS(NOW + 10 * DAY) } });

/** A mock SCIM 2.0 service: Users (with `active`) and Groups (with `members`); userName is unique (409). */
function scim() {
  const users = new Map<string, { userName: string; active: boolean; externalId?: string }>();
  const groups = new Map<string, { displayName: string; members: Array<{ value: string }> }>([["grp-team", { displayName: "Team", members: [{ value: "existing-1" }] }], ["grp-admin", { displayName: "Admins", members: [] }]]);
  users.set("existing-1", { userName: "owner@example.org", active: true });
  const calls: Array<{ method: string; path: string; auth: string | null; body: any }> = [];
  let n = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    const path = new URL(url).pathname.replace(/^\/scim\/v2/, "");
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method, path, auth: headers.authorization ?? null, body: init?.body ? JSON.parse(init.body) : null });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (headers.authorization !== `Bearer ${TOKEN}`) return json(401, {});
    if (path === "/Users" && method === "POST") {
      const b = JSON.parse(init!.body!);
      if ([...users.values()].some((u) => u.userName === b.userName)) return json(409, { detail: "uniqueness" });
      const id = `usr${String(++n).padStart(4, "0")}`;
      users.set(id, { userName: b.userName, active: b.active, externalId: b.externalId });
      return json(201, { id, userName: b.userName, active: b.active });
    }
    const um = /^\/Users\/([\w-]+)$/.exec(path);
    if (um) {
      const u = users.get(um[1] as string);
      if (!u) return json(404, {});
      if (method === "GET") return json(200, { id: um[1], ...u, groups: [...groups].filter(([, g]) => g.members.some((m) => m.value === um[1])).map(([value]) => ({ value })) });
      if (method === "PUT") {
        u.active = JSON.parse(init!.body!).active;
        return json(200, {});
      }
      if (method === "DELETE") {
        users.delete(um[1] as string);
        return new Response(null, { status: 204 });
      }
    }
    const gm = /^\/Groups\/([\w-]+)$/.exec(path);
    if (gm) {
      const g = groups.get(gm[1] as string);
      if (!g) return json(404, {});
      if (method === "GET") return json(200, { id: gm[1], displayName: g.displayName, members: g.members });
      if (method === "PUT") {
        g.members = JSON.parse(init!.body!).members;
        return json(200, {});
      }
    }
    return json(404, {});
  };
  return { users, groups, calls, adapter: (extra: Record<string, unknown> = {}) => new SaasSeatScimAdapter({ baseUrl: "https://saas.test/scim/v2", token: TOKEN, allowedGroups: ["grp-team"], fetch: fetchImpl, ...extra }) };
}
const setup = () => {
  const p = scim();
  const clock = { now: NOW };
  const store = new BrokerStore(":memory:");
  const m = new ProviderAccessManager({ store, now: () => clock.now });
  m.register(p.adapter());
  return { p, clock, store, m };
};

describe("BE-087: saas-seat-scim adapter (ADR-47 group B, catalog #17), mock SCIM 2.0 service", () => {
  it("TC-BE-087-01 a grant makes the user with the userName of the grant and puts it into the group of the scope; the SCIM token reaches nobody", async () => {
    const { p, m, store } = setup();
    const { access, delivery } = await m.grantAccess(input());
    const post = p.calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: "andi@example.org", externalId: "x207-1", active: true });
    expect(post.auth).toBe(`Bearer ${TOKEN}`);
    expect(p.groups.get("grp-team")!.members).toEqual([{ value: "existing-1" }, { value: "usr0001" }]); // the member that was there stays
    expect(delivery).toMatchObject({ provider: "saas-seat-scim", userName: "andi@example.org", group: "grp-team" });
    expect(access).toMatchObject({ status: "active", handle: "sc:1:usr0001:grp-team", proof: "not_applicable" });
    expect(JSON.stringify([delivery, access, store.db.prepare("SELECT * FROM provider_access").all()])).not.toContain(TOKEN);
    store.close();
  });

  it("TC-BE-087-02 a group outside the scope list and a malformed group are refused before any call", async () => {
    const { p, m, store } = setup();
    await expect(m.grantAccess(input({ resource: "grp-admin" }))).rejects.toThrow(/not one of the groups this broker may use/);
    await expect(m.grantAccess(input({ resource: "../x" }))).rejects.toThrow(/id of a SCIM group/);
    await expect(m.grantAccess(input({ resource: null }))).rejects.toThrow(/id of a SCIM group/);
    expect(p.calls).toEqual([]);
    store.close();
  });

  it("TC-BE-087-03 a user that already exists is not ours: the grant is refused and the user is left as it was", async () => {
    const { p, m, store } = setup();
    await expect(m.grantAccess(input({ grantee_ref: "owner@example.org" }))).rejects.toThrow(/already exists at the provider and is not a seat of this broker/);
    expect(p.users.get("existing-1")).toEqual({ userName: "owner@example.org", active: true });
    expect(p.groups.get("grp-team")!.members).toEqual([{ value: "existing-1" }]);
    store.close();
  });

  it("TC-BE-087-04 status reads the user: active in the group, absent when deactivated, out of the group or gone", async () => {
    const { p, m, store } = setup();
    const { access } = await m.grantAccess(input());
    const a = p.adapter();
    expect(await a.status(access.handle)).toBe("active");
    p.groups.get("grp-team")!.members = [{ value: "existing-1" }];
    expect(await a.status(access.handle)).toBe("absent");
    p.groups.get("grp-team")!.members.push({ value: "usr0001" });
    p.users.get("usr0001")!.active = false;
    expect(await a.status(access.handle)).toBe("absent");
    p.users.delete("usr0001");
    expect(await a.status(access.handle)).toBe("absent");
    store.close();
  });

  it("TC-BE-087-05 revoke: active false first, then out of the group, then delete; the other members stay; revoking again is a success", async () => {
    const { p, clock, m, store } = setup();
    const { access } = await m.grantAccess(input());
    p.calls.length = 0;
    clock.now += DAY + 1;
    const [done] = await m.sweep();
    expect(done?.status).toBe("revoked");
    const writes = p.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`);
    expect(writes).toEqual(["PUT /Users/usr0001", "PUT /Groups/grp-team", "DELETE /Users/usr0001"]);
    expect(p.calls.find((c) => c.method === "PUT" && c.path === "/Users/usr0001")!.body.active).toBe(false);
    expect(p.users.has("usr0001")).toBe(false);
    expect(p.groups.get("grp-team")!.members).toEqual([{ value: "existing-1" }]);
    await expect(p.adapter().revoke(access.handle)).resolves.toBeUndefined();
    store.close();
  });

  it("TC-BE-087-06 the rent of the next day keeps the same user; a seat that is gone gets a new one", async () => {
    const { p, clock, m, store } = setup();
    const first = await m.grantAccess(input());
    clock.now += DAY - 1000;
    const second = await m.grantAccess(input());
    expect(second.access.handle).toBe(first.access.handle);
    expect(p.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    p.users.delete("usr0001");
    p.groups.get("grp-team")!.members = [{ value: "existing-1" }];
    const third = await m.grantAccess(input());
    expect(third.access.handle).toBe("sc:1:usr0002:grp-team");
    store.close();
  });

  it("TC-BE-087-07 a group that does not exist leaves no user behind; a second live grant for the same seat is refused (B4-F2)", async () => {
    const p = scim();
    const store = new BrokerStore(":memory:");
    const m = new ProviderAccessManager({ store, now: () => NOW });
    m.register(p.adapter({ allowedGroups: ["grp-team", "grp-missing"] }));
    await expect(m.grantAccess(input({ resource: "grp-missing" }))).rejects.toThrow(/does not exist at the provider/);
    expect([...p.users.keys()]).toEqual(["existing-1"]);
    await m.grantAccess(input());
    await expect(m.grantAccess(input({}, 2))).rejects.toThrow(/already opened the same access/);
    store.close();
  });

  it("TC-BE-087-08 the options, the references and the handle are checked; a failing provider never puts the token in the error", async () => {
    const base = { baseUrl: "https://s.test/scim", token: "t", allowedGroups: ["g1"] };
    expect(() => new SaasSeatScimAdapter({ ...base, baseUrl: "http://s.test" })).toThrow(/https/);
    expect(() => new SaasSeatScimAdapter({ ...base, token: "" })).toThrow(/token is required/);
    expect(() => new SaasSeatScimAdapter({ ...base, allowedGroups: [] })).toThrow(/allowedGroups is empty/);
    expect(() => new SaasSeatScimAdapter({ ...base, allowedGroups: ["a b"] })).toThrow(/not a SCIM group id/);
    const a = new SaasSeatScimAdapter(base);
    expect(await a.verifyGranteeRef("andi@example.org")).toEqual({ ok: true });
    expect(await a.verifyGranteeRef("a b")).toMatchObject({ ok: false });
    await expect(a.revoke("sc:1:../x:g1")).rejects.toThrow(/unknown SCIM handle/);
    const down: FetchLike = async () => new Response("unavailable", { status: 503 });
    const b = new SaasSeatScimAdapter({ ...base, token: TOKEN, fetch: down });
    const error = await b.grant({ grantId: 1, granteeRef: "x@y.z", resource: "g1", permission: null, expiresAtMs: NOW + DAY }).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/HTTP 503/);
    expect((error as Error).message).not.toContain(TOKEN);
  });
});
