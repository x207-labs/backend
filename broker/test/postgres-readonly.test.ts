import { describe, expect, it } from "vitest";
import { PostgresReadonlyAdapter, ProviderAccessManager, type SqlClient } from "../src/provider/index.js";
import { BrokerStore } from "../src/store.js";
import { NOW } from "./helpers.js";

const DAY = 86_400_000;
const NS = (ms: number): string => (BigInt(ms) * 1_000_000n).toString();
const ADMIN_PASSWORD = "admin-password-do-not-leak";
const input = (over: Record<string, unknown> = {}, id = 1) => ({ grant_id: id, limits: { scope: JSON.stringify({ provider: "postgres-readonly", grantee_ref: "agent-andi", resource: "public,analytics.events", permission: "read", ...over }), expires_at: NS(NOW + 10 * DAY) } });

/** A PostgreSQL in memory, as far as the adapter looks at it: roles with a valid-until, the statements it was sent. Parses nothing it does not know and fails on a statement it did not expect. */
function database(opts: { failOn?: RegExp } = {}) {
  const roles = new Map<string, { until: string; canLogin: boolean; grants: string[]; password: string }>();
  const statements: string[] = [];
  const client: SqlClient = {
    async query(text, params = []) {
      statements.push(text);
      if (opts.failOn?.test(text)) throw new Error(`boom ${text}`);
      if (/^SELECT 1 AS x FROM pg_roles/.test(text)) return { rows: roles.has(String(params[0])) ? [{ x: 1 }] : [] };
      if (/^SELECT rolcanlogin, rolvaliduntil FROM pg_roles/.test(text)) {
        const r = roles.get(String(params[0]));
        return { rows: r === undefined ? [] : [{ rolcanlogin: r.canLogin, rolvaliduntil: r.until }] };
      }
      let m = /^CREATE ROLE "(\w+)" LOGIN PASSWORD '([A-Za-z0-9_-]+)' VALID UNTIL '([^']+)' CONNECTION LIMIT (\d+) NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT$/.exec(text);
      if (m) { roles.set(m[1]!, { until: m[3]!, canLogin: true, grants: [], password: m[2]! }); return { rows: [] }; }
      m = /^ALTER ROLE "(\w+)" VALID UNTIL '([^']+)'$/.exec(text);
      if (m) { roles.get(m[1]!)!.until = m[2]!; return { rows: [] }; }
      if (/^ALTER ROLE "\w+" SET default_transaction_read_only = on$/.test(text)) return { rows: [] };
      m = /^GRANT (CONNECT ON DATABASE "[\w.-]+"|USAGE ON SCHEMA "\w+"|SELECT ON ALL TABLES IN SCHEMA "\w+"|SELECT ON TABLE "\w+"\."\w+") TO "(\w+)"$/.exec(text);
      if (m) { const g = roles.get(m[2]!)!.grants; if (!g.includes(m[1]!)) g.push(m[1]!); return { rows: [] }; }
      if (/^SELECT pg_terminate_backend/.test(text) || /^REVOKE CONNECT ON DATABASE "[\w.-]+" FROM "\w+"$/.test(text)) return { rows: [] };
      m = /^ALTER ROLE "(\w+)" NOLOGIN$/.exec(text);
      if (m) { roles.get(m[1]!)!.canLogin = false; return { rows: [] }; }
      m = /^DROP OWNED BY "(\w+)"$/.exec(text);
      if (m) { roles.get(m[1]!)!.grants = []; return { rows: [] }; }
      m = /^DROP ROLE IF EXISTS "(\w+)"$/.exec(text);
      if (m) { roles.delete(m[1]!); return { rows: [] }; }
      throw new Error(`the mock does not know: ${text}`);
    },
  };
  return { roles, statements, client };
}
const adapterOf = (db: ReturnType<typeof database>, extra: Record<string, unknown> = {}) =>
  new PostgresReadonlyAdapter({ client: db.client, host: "db.example.com", database: "shop", allowedSchemas: ["public", "analytics", "billing"], now: () => NOW, ...extra });

describe("BE-082 postgres-readonly adapter (ADR-47 group B, #23), mock SQL client", () => {
  it("TC-BE-082-01 a grant makes a login role with VALID UNTIL and read-only defaults, grants SELECT only on the scope, and shows the password once", async () => {
    const db = database();
    const store = new BrokerStore(":memory:");
    const m = new ProviderAccessManager({ store, now: () => NOW });
    m.register(adapterOf(db));
    const { access, delivery, warnings } = await m.grantAccess(input());
    const role = db.roles.get("x207_g1")!;
    expect(role.until).toMatch(/^2026-11-0\d \d\d:\d\d:\d\d\+00$/);
    expect(role.grants).toEqual(['CONNECT ON DATABASE "shop"', 'USAGE ON SCHEMA "public"', 'SELECT ON ALL TABLES IN SCHEMA "public"', 'USAGE ON SCHEMA "analytics"', 'SELECT ON TABLE "analytics"."events"']);
    expect(db.statements.some((s) => /SET default_transaction_read_only = on/.test(s))).toBe(true);
    expect(db.statements.filter((s) => /^GRANT/.test(s) && !/SELECT|USAGE|CONNECT/.test(s))).toEqual([]); // nothing but SELECT, USAGE and CONNECT
    expect(delivery).toMatchObject({ provider: "postgres-readonly", host: "db.example.com", port: 5432, database: "shop", user: "x207_g1", readOnly: true, schemas: ["public"], tables: ["analytics.events"] });
    expect(delivery.key).toBe(role.password);
    expect(role.password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(access).toMatchObject({ status: "active", proof: "not_applicable", handle: "pg:1:x207_g1" });
    expect(warnings).toEqual(["grantee_unproven"]);
    // the record keeps the handle, never the password or the administrator
    expect(JSON.stringify([access, store.db.prepare("SELECT * FROM provider_access").all()])).not.toContain(role.password);
    expect(JSON.stringify([delivery, access])).not.toContain(ADMIN_PASSWORD);
    store.close();
  });

  it("TC-BE-082-02 a scope outside the schemas the operator allowed, a system schema, a bad name or a write permission is refused before any statement", async () => {
    const db = database();
    const a = adapterOf(db);
    for (const resource of ["secret", "pg_catalog", "information_schema.tables", "public;DROP TABLE x", 'public."x"', "Public", "public.a.b", "", "public,,billing"]) {
      await expect(a.grant({ grantId: 2, granteeRef: "x", resource, permission: "read", expiresAtMs: NOW + DAY })).rejects.toThrow();
    }
    await expect(a.grant({ grantId: 2, granteeRef: "x", resource: "public", permission: "write", expiresAtMs: NOW + DAY })).rejects.toThrow(/read-only/);
    await expect(a.grant({ grantId: 2, granteeRef: "x", resource: null, permission: null, expiresAtMs: NOW + DAY })).rejects.toThrow();
    expect(db.statements).toEqual([]);
    expect(() => adapterOf(db, { allowedSchemas: ["pg_catalog"] })).toThrow(/not a schema name that can be shared/);
    expect(() => adapterOf(db, { allowedSchemas: ["pub lic"] })).toThrow();
    expect((await a.verifyGranteeRef("agent-andi")).ok).toBe(true);
    expect((await a.verifyGranteeRef("a b")).ok).toBe(false);
    // a table of a schema that is granted whole is not repeated
    expect(a.scopeOf({ resource: "public, public.users ,analytics.events", permission: null })).toEqual({ schemas: ["public"], tables: [{ schema: "analytics", table: "events" }] });
  });

  it("TC-BE-082-03 the default expiry is recorded: the role is valid until the end of the paid day and the access carries it as native expiry", async () => {
    const db = database();
    const store = new BrokerStore(":memory:");
    const m = new ProviderAccessManager({ store, now: () => NOW });
    const a = adapterOf(db);
    m.register(a);
    const { access } = await m.grantAccess(input());
    expect(access.nativeExpiresMs).toBe(access.paidUntilMs);
    expect(Date.parse(db.roles.get("x207_g1")!.until.replace(" ", "T").replace("+00", "Z"))).toBe(access.paidUntilMs);
    expect(a.nativeExpiry).toBe(true);
    // the role stops being valid with the clock, and status says so
    const clock = { now: NOW };
    const timed = adapterOf(db, { now: () => clock.now });
    expect(await timed.status(access.handle)).toBe("active");
    clock.now = access.paidUntilMs! + 1000;
    expect(await timed.status(access.handle)).toBe("expired");
    store.close();
  });

  it("TC-BE-082-04 the rent of the next day moves VALID UNTIL, keeps the role and the password, and does not show the password again; a role that is gone gets a new one", async () => {
    const db = database();
    const store = new BrokerStore(":memory:");
    const clock = { now: NOW };
    const m = new ProviderAccessManager({ store, now: () => clock.now });
    m.register(adapterOf(db));
    const first = await m.grantAccess(input());
    m.confirmDelivery(first.access.grantId);
    const before = db.roles.get("x207_g1")!.until;
    clock.now += DAY - 1000;
    const second = await m.grantAccess(input());
    expect(db.statements.filter((s) => /^CREATE ROLE/.test(s))).toHaveLength(1);
    expect(second.access.handle).toBe(first.access.handle);
    expect(second.delivery.key).toBeNull();
    expect(db.roles.get("x207_g1")!.until).not.toBe(before);
    expect(JSON.stringify(second.delivery)).not.toContain(db.roles.get("x207_g1")!.password);
    // dropped by hand at the database: the next day makes another role with another password
    const oldPassword = db.roles.get("x207_g1")!.password;
    db.roles.clear();
    const third = await m.grantAccess(input());
    expect(db.statements.filter((s) => /^CREATE ROLE/.test(s))).toHaveLength(2);
    expect(third.delivery.key).toBe(db.roles.get("x207_g1")!.password);
    expect(third.delivery.key).not.toBe(oldPassword);
    store.close();
  });

  it("TC-BE-082-05 revoke ends the sessions, takes back the grants and drops the role; it is idempotent and status says absent", async () => {
    const db = database();
    const store = new BrokerStore(":memory:");
    const m = new ProviderAccessManager({ store, now: () => NOW });
    const a = adapterOf(db);
    m.register(a);
    const { access } = await m.grantAccess(input());
    db.statements.length = 0;
    await a.revoke(access.handle);
    expect(db.statements).toEqual([
      "SELECT 1 AS x FROM pg_roles WHERE rolname = $1",
      'ALTER ROLE "x207_g1" NOLOGIN', // first, so a lessee that reconnects in a loop cannot get back in before the role is dropped
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'x207_g1'",
      'REVOKE CONNECT ON DATABASE "shop" FROM "x207_g1"',
      'DROP OWNED BY "x207_g1"',
      'DROP ROLE IF EXISTS "x207_g1"',
    ]);
    expect(db.roles.size).toBe(0);
    expect(await a.status(access.handle)).toBe("absent");
    await a.revoke(access.handle); // already gone: a success
    await expect(a.revoke("pg:1:postgres")).rejects.toThrow(/unknown PostgreSQL handle/); // a handle cannot name another role
    await expect(a.status("pg:1:x207_g2")).rejects.toThrow();
    store.close();
  });

  it("TC-BE-082-06 an error of the client never carries the statement (it holds the password); a grant that fails half way leaves no role", async () => {
    const db = database({ failOn: /^GRANT USAGE ON SCHEMA "analytics"/ });
    const store = new BrokerStore(":memory:");
    const m = new ProviderAccessManager({ store, now: () => NOW });
    m.register(adapterOf(db));
    let message = "";
    try {
      await m.grantAccess(input());
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("grant failed");
    const created = db.statements.find((s) => /^CREATE ROLE/.test(s))!;
    const password = /PASSWORD '([^']+)'/.exec(created)![1]!;
    expect(message).not.toContain(password);
    expect(message).not.toContain("boom");
    expect(db.roles.size).toBe(0); // dropped again
    store.close();
  });

  it("TC-BE-082-07 a second grant gets its own role; a role name cannot be chosen by the lessee", async () => {
    const db = database();
    const store = new BrokerStore(":memory:");
    const m = new ProviderAccessManager({ store, now: () => NOW });
    m.register(adapterOf(db));
    await m.grantAccess(input({}, 1));
    await m.grantAccess(input({ grantee_ref: "postgres" }, 2));
    expect([...db.roles.keys()].sort()).toEqual(["x207_g1", "x207_g2"]);
    expect(db.statements.some((s) => s.includes('"postgres"'))).toBe(false);
    store.close();
  });
});
