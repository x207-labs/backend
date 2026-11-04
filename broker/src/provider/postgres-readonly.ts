// Read-only user database adapter (BE-082, ADR-47 group B, #23): a lessee reads a database of the grantor through a role that the grantor's broker makes for the paid days and drops after them.
// The administrator credential of the grantor stays on the machine of the broker, inside the `SqlClient` it hands to this adapter; the lessee only gets the role and its password.
//   grant   CREATE ROLE "x207_g<id>" LOGIN PASSWORD '…' VALID UNTIL '…' (no superuser, no create, not a replication role, few connections), `default_transaction_read_only = on`,
//           GRANT CONNECT on the database, then GRANT USAGE on each schema and GRANT SELECT on the tables of the scope, nothing else
//   revoke  NOLOGIN, end the sessions of the role, REVOKE CONNECT, DROP OWNED BY (this takes back every grant of the role), DROP ROLE
//   status  pg_roles: no row = absent, VALID UNTIL in the past = expired, else active
// Scope of the grant: `resource` is a comma separated list of `schema` or `schema.table` that the operator allowed (`allowedSchemas`); `permission` is empty or `read`. Anything else is refused before a
// statement is sent. `grantee_ref` is only the name of the access (the lessee has no account on the database, so there is nothing to prove: the manager marks the access `not_applicable`).
// Limits, said plainly: `VALID UNTIL` stops a NEW login after the end of the paid day, and a session that is already open stays open until the broker revokes (it ends the sessions, with the retry of the
// manager); `GRANT SELECT ON ALL TABLES` covers the tables that exist at the grant, so a table made later is not readable until the next day's renewal grants it again; a role can read what `PUBLIC`
// can read (the operator should not grant `PUBLIC` anything it does not want to share); row level security and column privileges are the operator's own choice and are not touched here.
// The statements carry the password of the role and are never logged by this adapter; an error from the client is replaced by a text without the statement (the client of the operator may log what it likes).
import { randomBytes } from "node:crypto";
import type { AccessState, ProviderAccessAdapter, ProviderGrantRequest, ProviderGrantResult } from "./adapter.js";

/** The one thing the adapter needs from a database driver (`pg`'s `client.query`): a text and its parameters, the rows back. The tests give a mock; the operator gives a client that is logged in as an administrator. */
export interface SqlClient {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface PostgresReadonlyOptions {
  client: SqlClient;
  /** Where the lessee connects (the name or address the lessee can reach, not the one of the broker if they differ). */
  host: string;
  port?: number;
  /** The database the role may connect to. */
  database: string;
  /** Schemas that a grant may name, or whose tables it may name as `schema.table`. Empty = nothing can be granted. The system schemas are refused whatever is listed. */
  allowedSchemas: readonly string[];
  /** Concurrent connections of the role; default 2. */
  connectionLimit?: number;
  sslmode?: "require" | "verify-full";
  /** Clock for `status` (tests); default `Date.now`. */
  now?: () => number;
}

const NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/;
const SYSTEM = (schema: string): boolean => schema === "information_schema" || schema.startsWith("pg_");
const quote = (id: string): string => `"${id.replace(/"/g, '""')}"`;

/** `pg:<grant id>:<role>`: all that `revoke` and `status` need; the role is derived from the grant id, never from what the lessee wrote, and there is no secret in it. */
const roleOf = (grantId: number): string => `x207_g${grantId}`;
const handleOf = (grantId: number): string => `pg:${grantId}:${roleOf(grantId)}`;
const roleOfHandle = (handle: string): string => {
  const m = /^pg:(\d+):(x207_g\d+)$/.exec(handle);
  if (!m || m[2] !== roleOf(Number(m[1]))) throw new Error("unknown PostgreSQL handle");
  return m[2] as string;
};

/** A `timestamptz` literal for VALID UNTIL: UTC, seconds. */
const untilOf = (ms: number): string => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "+00");

export interface Scope { schemas: string[]; tables: Array<{ schema: string; table: string }> }

export class PostgresReadonlyAdapter implements ProviderAccessAdapter {
  readonly provider = "postgres-readonly";
  readonly real = true;
  /** VALID UNTIL is a native expiry for logins (see the limits above). */
  readonly nativeExpiry = true;
  /** The password of the role is shown once, in `delivery.key`. */
  readonly oneTimeKey = true;
  readonly #o: PostgresReadonlyOptions;

  constructor(options: PostgresReadonlyOptions) {
    if (!/^[A-Za-z0-9_.-]{1,63}$/.test(options.database)) throw new Error("database: 1 to 63 characters [A-Za-z0-9_.-]");
    for (const s of options.allowedSchemas) if (!NAME.test(s) || SYSTEM(s)) throw new Error(`allowedSchemas: ${JSON.stringify(s)} is not a schema name that can be shared`);
    this.#o = options;
  }

  async verifyGranteeRef(ref: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    return REF.test(ref) ? { ok: true } : { ok: false, reason: "grantee_ref is the name of the access: 1 to 64 characters [A-Za-z0-9._:@-]" };
  }

  /** The scope of a grant, checked against what the operator allowed. */
  scopeOf(request: Pick<ProviderGrantRequest, "resource" | "permission">): Scope {
    if (request.permission !== null && request.permission !== "" && request.permission !== "read") throw new Error("permission must be empty or read: this access is read-only");
    const parts = (request.resource ?? "").split(",").map((p) => p.trim());
    if (parts.length === 0 || parts.length > 32 || parts.some((p) => p === "")) throw new Error("resource must list 1 to 32 entries: schema or schema.table, separated by commas");
    const schemas = new Set<string>();
    const tables: Scope["tables"] = [];
    for (const part of parts) {
      const [schema, table, extra] = part.split(".");
      if (extra !== undefined || schema === undefined || !NAME.test(schema) || (table !== undefined && !NAME.test(table))) throw new Error(`resource entry ${JSON.stringify(part)} is not schema or schema.table (lower case letters, digits and _)`);
      if (SYSTEM(schema) || !this.#o.allowedSchemas.includes(schema)) throw new Error(`schema ${schema} is not shared by this broker`);
      if (table === undefined) schemas.add(schema);
      else tables.push({ schema, table });
    }
    // a table of a schema that is granted whole needs no line of its own
    return { schemas: [...schemas], tables: tables.filter((t) => !schemas.has(t.schema)) };
  }

  async #exists(role: string): Promise<boolean> {
    return (await this.#o.client.query("SELECT 1 AS x FROM pg_roles WHERE rolname = $1", [role])).rows.length > 0;
  }

  /** Runs statements in order; an error never carries the statement (it holds the password). */
  async #run(statements: readonly string[], what: string): Promise<void> {
    for (const text of statements) {
      try {
        await this.#o.client.query(text);
      } catch {
        throw new Error(`PostgreSQL: ${what} failed`);
      }
    }
  }

  #grants(role: string, scope: Scope): string[] {
    const out = [`GRANT CONNECT ON DATABASE ${quote(this.#o.database)} TO ${quote(role)}`];
    for (const schema of scope.schemas) out.push(`GRANT USAGE ON SCHEMA ${quote(schema)} TO ${quote(role)}`, `GRANT SELECT ON ALL TABLES IN SCHEMA ${quote(schema)} TO ${quote(role)}`);
    for (const t of scope.tables) out.push(`GRANT USAGE ON SCHEMA ${quote(t.schema)} TO ${quote(role)}`, `GRANT SELECT ON TABLE ${quote(t.schema)}.${quote(t.table)} TO ${quote(role)}`);
    return out;
  }

  async grant(request: ProviderGrantRequest): Promise<ProviderGrantResult> {
    const scope = this.scopeOf(request);
    const role = roleOf(request.grantId);
    const until = untilOf(request.expiresAtMs);
    const delivery = (key: string | null): Record<string, unknown> => ({
      provider: "postgres-readonly", host: this.#o.host, port: this.#o.port ?? 5432, database: this.#o.database, user: role, key, sslmode: this.#o.sslmode ?? "require",
      schemas: scope.schemas, tables: scope.tables.map((t) => `${t.schema}.${t.table}`), readOnly: true, validUntil: new Date(Math.floor(request.expiresAtMs / 1000) * 1000).toISOString(),
      ...(key === null ? { note: "the password was shown on the first day; ask the grantor for a new access if it was lost" } : {}),
    });
    // the rent of the next day: the role is there, the day moves and the scope is granted again (it also covers a table made since)
    if (request.existingHandle && (await this.#exists(roleOfHandle(request.existingHandle)))) {
      await this.#run([`ALTER ROLE ${quote(role)} VALID UNTIL '${until}'`, ...this.#grants(role, scope)], "renewal");
      return { handle: request.existingHandle, nativeExpiresAtMs: request.expiresAtMs, delivery: delivery(null) };
    }
    // a role of this grant that is left from a call that failed half way is dropped first, so that the password the lessee gets is the one that is set
    if (await this.#exists(role)) await this.revoke(handleOf(request.grantId));
    const password = randomBytes(24).toString("base64url"); // [A-Za-z0-9_-]: nothing to escape in the literal
    await this.#run([
      `CREATE ROLE ${quote(role)} LOGIN PASSWORD '${password}' VALID UNTIL '${until}' CONNECTION LIMIT ${Math.max(1, Math.floor(this.#o.connectionLimit ?? 2))} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
      `ALTER ROLE ${quote(role)} SET default_transaction_read_only = on`,
      ...this.#grants(role, scope),
    ], "grant").catch(async (error) => {
      await this.revoke(handleOf(request.grantId)).catch(() => undefined); // do not leave a half made role with a password nobody saw
      throw error;
    });
    return { handle: handleOf(request.grantId), nativeExpiresAtMs: request.expiresAtMs, delivery: delivery(password) };
  }

  async revoke(handle: string): Promise<void> {
    const role = roleOfHandle(handle);
    if (!(await this.#exists(role))) return; // already gone: success
    // NOLOGIN first: PUBLIC has CONNECT on a database by default, so ending the sessions alone lets a lessee that reconnects in a loop log in again before the role is dropped (BE-082 review)
    await this.#run([
      `ALTER ROLE ${quote(role)} NOLOGIN`,
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '${role}'`,
      `REVOKE CONNECT ON DATABASE ${quote(this.#o.database)} FROM ${quote(role)}`,
      `DROP OWNED BY ${quote(role)}`,
      `DROP ROLE IF EXISTS ${quote(role)}`,
    ], "revoke");
  }

  async status(handle: string): Promise<AccessState> {
    const role = roleOfHandle(handle);
    const rows = (await this.#o.client.query("SELECT rolcanlogin, rolvaliduntil FROM pg_roles WHERE rolname = $1", [role])).rows;
    const row = rows[0];
    if (row === undefined) return "absent";
    const until = row.rolvaliduntil;
    const untilMs = until instanceof Date ? until.getTime() : typeof until === "string" ? Date.parse(until) : Number.NaN;
    if (row.rolcanlogin === false) return "absent";
    return Number.isFinite(untilMs) && untilMs <= (this.#o.now ?? Date.now)() ? "expired" : "active";
  }
}
