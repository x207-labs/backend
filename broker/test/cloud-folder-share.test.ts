import { describe, expect, it } from "vitest";
import { CloudFolderShareAdapter, ProviderAccessManager, type FetchLike } from "../src/provider/index.js";
import { BrokerStore } from "../src/store.js";
import { NOW } from "./helpers.js";

const DAY = 86_400_000;
const TOKEN = "storage-admin-token-do-not-leak-0123456789";
const NS = (ms: number): string => (BigInt(ms) * 1_000_000n).toString();
const input = (over: Record<string, unknown> = {}, id = 1) => ({ grant_id: id, limits: { scope: JSON.stringify({ provider: "cloud-folder-share", grantee_ref: "andi@example.org", resource: "projects/alpha/reports", permission: "read", ...over }), expires_at: NS(NOW + 10 * DAY) } });

/** A mock storage API: shares by folder, with the end of each; the provider does not end a share by itself (the clock is the test's). */
function storage(clock: { now: number }) {
  const shares = new Map<string, Array<{ id: string; grantee: string; role: string; expires_at: string }>>();
  const calls: Array<{ method: string; path: string; auth: string | null; body: any }> = [];
  let n = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method, path: u.pathname, auth: headers.authorization ?? null, body: init?.body ? JSON.parse(init.body) : null });
    if (headers.authorization !== `Bearer ${TOKEN}`) return new Response("{}", { status: 401 });
    const m = /^\/api\/folders\/(.+?)\/shares(?:\/([\w-]+))?$/.exec(u.pathname);
    if (!m) return new Response("{}", { status: 404 });
    const folder = decodeURIComponent(m[1] as string).split("%2F").join("/");
    const list = shares.get(folder) ?? [];
    if (method === "POST") {
      const b = JSON.parse(init!.body!);
      const s = { id: `sh${String(++n).padStart(4, "0")}`, grantee: b.grantee, role: b.role, expires_at: b.expires_at };
      shares.set(folder, [...list, s]);
      return new Response(JSON.stringify({ id: s.id, expires_at: s.expires_at }), { status: 201 });
    }
    if (method === "GET") return new Response(JSON.stringify({ shares: list }), { status: 200 });
    const s = list.find((x) => x.id === m[2]);
    if (!s) return new Response("{}", { status: 404 });
    if (method === "PUT") {
      const b = JSON.parse(init!.body!);
      Object.assign(s, { role: b.role, expires_at: b.expires_at });
      return new Response("{}", { status: 200 });
    }
    if (method === "DELETE") {
      shares.set(folder, list.filter((x) => x.id !== m[2]));
      return new Response(null, { status: 204 });
    }
    return new Response("{}", { status: 405 });
  };
  const adapter = (extra: Record<string, unknown> = {}) =>
    new CloudFolderShareAdapter({ baseUrl: "https://storage.test/api", token: TOKEN, allowedFolders: ["projects/alpha", "shared"], fetch: fetchImpl, now: () => clock.now, ...extra });
  return { shares, calls, adapter };
}
const setup = () => {
  const clock = { now: NOW };
  const s = storage(clock);
  const store = new BrokerStore(":memory:");
  const m = new ProviderAccessManager({ store, now: () => clock.now });
  m.register(s.adapter());
  return { clock, s, store, m };
};

describe("BE-084: cloud-folder-share adapter (ADR-47 group B, catalog #81), mock storage provider", () => {
  it("TC-BE-084-01 a grant shares exactly the folder of the scope with the role and the end of the paid day; the admin token never reaches the lessee or the record", async () => {
    const { s, m, store } = setup();
    const { access, delivery } = await m.grantAccess(input());
    const post = s.calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe("/api/folders/projects/alpha/reports/shares");
    expect(post.body).toEqual({ grantee: "andi@example.org", role: "reader", expires_at: new Date(NOW + DAY).toISOString() });
    expect(post.auth).toBe(`Bearer ${TOKEN}`);
    expect(delivery).toMatchObject({ provider: "cloud-folder-share", folder: "projects/alpha/reports", role: "reader", grantee: "andi@example.org" });
    expect(access).toMatchObject({ status: "active", proof: "not_applicable", paidUntilMs: NOW + DAY, nativeExpiresMs: NOW + DAY });
    expect(JSON.stringify([delivery, access, store.db.prepare("SELECT * FROM provider_access").all()])).not.toContain(TOKEN);
    store.close();
  });

  it("TC-BE-084-02 write permission asks for a writer; any other permission is refused", async () => {
    const { s, m, store } = setup();
    await m.grantAccess(input({ permission: "write" }));
    expect(s.calls.find((c) => c.method === "POST")!.body.role).toBe("writer");
    await expect(m.grantAccess(input({ permission: "admin", resource: "shared/x", grantee_ref: "b@example.org" }, 2))).rejects.toThrow(/permission must be read or write/);
    store.close();
  });

  it("TC-BE-084-03 a folder outside the allowed folders, a sibling with the same prefix and a path with .. are refused before any call", async () => {
    const { s, m, store } = setup();
    for (const resource of ["projects/beta", "projects/alphabet", "projects", "projects/alpha/../beta", "/projects/alpha", "projects//alpha", "", null]) {
      await expect(m.grantAccess(input({ resource }, 9))).rejects.toThrow(/outside the folders|resource must be a folder path/);
    }
    expect(s.calls).toEqual([]);
    store.close();
  });

  it("TC-BE-084-04 status reads the list of shares: active, expired when its end has passed, absent when the share was removed at the provider", async () => {
    const { s, clock, m, store } = setup();
    const { access } = await m.grantAccess(input());
    const a = s.adapter();
    expect(await a.status(access.handle)).toBe("active");
    expect(s.calls.at(-1)).toMatchObject({ method: "GET", path: "/api/folders/projects/alpha/reports/shares" });
    clock.now += DAY + 1;
    expect(await a.status(access.handle)).toBe("expired");
    clock.now = NOW;
    s.shares.set("projects/alpha/reports", []);
    expect(await a.status(access.handle)).toBe("absent");
    store.close();
  });

  it("TC-BE-084-05 revoke removes the share at the end of the paid day; revoking again is a success", async () => {
    const { s, clock, m, store } = setup();
    const { access } = await m.grantAccess(input());
    clock.now += DAY + 1;
    const [done] = await m.sweep();
    expect(done?.status).toBe("revoked");
    expect(s.shares.get("projects/alpha/reports")).toEqual([]);
    await expect(s.adapter().revoke(access.handle)).resolves.toBeUndefined();
    store.close();
  });

  it("TC-BE-084-06 the rent of the next day moves the end of the same share (PUT); a share that is gone gets a new one", async () => {
    const { s, clock, m, store } = setup();
    const first = await m.grantAccess(input());
    clock.now += DAY - 1000;
    const second = await m.grantAccess(input());
    expect(second.access.handle).toBe(first.access.handle);
    expect(s.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(s.shares.get("projects/alpha/reports")![0]!.expires_at).toBe(new Date(NOW + 2 * DAY).toISOString());
    s.shares.set("projects/alpha/reports", []);
    clock.now += DAY - 1000;
    const third = await m.grantAccess(input());
    expect(third.access.handle).not.toBe(first.access.handle);
    expect(s.calls.filter((c) => c.method === "POST")).toHaveLength(2);
    store.close();
  });

  it("TC-BE-084-07 a second live grant for the same folder and person is refused, so the end of the first does not take the share of the second (B4-F2)", async () => {
    const { m, store } = setup();
    await m.grantAccess(input());
    await expect(m.grantAccess(input({}, 2))).rejects.toThrow(/already opened the same access/);
    store.close();
  });

  it("TC-BE-084-08 the options and the references are checked", async () => {
    const base = { baseUrl: "https://s.test/api", token: "t", allowedFolders: ["a"] };
    expect(() => new CloudFolderShareAdapter({ ...base, baseUrl: "http://s.test" })).toThrow(/https/);
    expect(() => new CloudFolderShareAdapter({ ...base, token: "" })).toThrow(/token is required/);
    expect(() => new CloudFolderShareAdapter({ ...base, allowedFolders: [] })).toThrow(/allowedFolders is empty/);
    expect(() => new CloudFolderShareAdapter({ ...base, allowedFolders: ["a/../b"] })).toThrow(/not a safe folder path/);
    const a = new CloudFolderShareAdapter(base);
    expect(await a.verifyGranteeRef("andi@example.org")).toEqual({ ok: true });
    expect(await a.verifyGranteeRef("a b")).toMatchObject({ ok: false });
    await expect(a.revoke("cf:1:not-a-handle")).rejects.toThrow(/unknown cloud folder handle/);
  });

  it("TC-BE-084-09 a failing provider never puts the token in the error", async () => {
    const down: FetchLike = async () => new Response("unavailable", { status: 503 });
    const a = new CloudFolderShareAdapter({ baseUrl: "https://s.test/api", token: TOKEN, allowedFolders: ["a"], fetch: down });
    const error = await a.grant({ grantId: 1, granteeRef: "x", resource: "a/b", permission: null, expiresAtMs: NOW + DAY }).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/HTTP 503/);
    expect((error as Error).message).not.toContain(TOKEN);
  });
});
