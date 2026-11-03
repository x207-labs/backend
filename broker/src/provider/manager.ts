// The manager of P2 accesses (BE-057, ADR-47). It sits between the grants of the contract and the adapters of the providers:
//   - `grantAccess` checks the grantee (`verifyGranteeRef`), opens the access for the paid day, and keeps `paid_until`; the next day's rent moves it;
//   - `sweep` closes what the clock closes; a revoke that fails is not forgotten: the access becomes `revoke_pending` and is tried again with growing waits, until it works;
//   - `settleDay` asks the provider for the REAL cost of a day of a costly access, writes it down for the bill, and closes the access when a day went over the cap of the grantor.
// Mode: `self-hosted` (the default) is the broker that the grantor runs; the administrator credential of a provider lives on that machine only. `hosted` is the broker that x207 runs
// for a demo: it refuses every adapter that talks to a real service, because it would need the credential of somebody else.
import type { BrokerStore } from "../store.js";
import {
  ProviderAccessError, parseProviderScope, type ProviderAccessAdapter, type ProviderGrantResult, type ProviderScope,
} from "./adapter.js";

export type BrokerMode = "self-hosted" | "hosted";
export type AccessStatus = "active" | "revoke_pending" | "revoked";
const DAY_MS = 86_400_000;
export const RETRY_BASE_MS = 30_000;
export const RETRY_MAX_MS = 3_600_000;

export interface ProviderAccess {
  grantId: number;
  provider: string;
  granteeRef: string;
  handle: string;
  status: AccessStatus;
  paidUntilMs: number;
  nativeExpiresMs: number | null;
  /** Failed attempts to revoke, and when the next one is due. */
  attempts: number;
  nextRetryMs: number | null;
  lastError: string | null;
  reason: string | null;
}

interface Row {
  grant_id: number;
  provider: string;
  grantee_ref: string;
  handle: string;
  status: string;
  paid_until_ms: number;
  native_expires_ms: number | null;
  attempts: number;
  next_retry_ms: number | null;
  last_error: string | null;
  reason: string | null;
}

const toAccess = (r: Row): ProviderAccess => ({
  grantId: r.grant_id, provider: r.provider, granteeRef: r.grantee_ref, handle: r.handle, status: r.status as AccessStatus, paidUntilMs: r.paid_until_ms,
  nativeExpiresMs: r.native_expires_ms, attempts: r.attempts, nextRetryMs: r.next_retry_ms, lastError: r.last_error, reason: r.reason,
});

/** The part of a grant that the manager needs. */
export interface ProviderGrantInput {
  grant_id: number;
  limits: { scope: string; expires_at: string };
}

export interface ManagerOptions {
  store: BrokerStore;
  mode?: BrokerMode;
  now?: () => number;
  log?: (line: string) => void;
}

const nsToMs = (ns: string): number => Number(BigInt(ns) / 1_000_000n);

export class ProviderAccessManager {
  readonly mode: BrokerMode;
  readonly #store: BrokerStore;
  readonly #now: () => number;
  readonly #log: ((line: string) => void) | undefined;
  readonly #adapters = new Map<string, ProviderAccessAdapter>();

  constructor(options: ManagerOptions) {
    this.#store = options.store;
    this.mode = options.mode ?? "self-hosted";
    this.#now = options.now ?? Date.now;
    this.#log = options.log;
    this.#store.db.exec(`
      CREATE TABLE IF NOT EXISTS provider_access (
        grant_id          INTEGER PRIMARY KEY,
        provider          TEXT    NOT NULL,
        grantee_ref       TEXT    NOT NULL,
        handle            TEXT    NOT NULL,
        status            TEXT    NOT NULL CHECK (status IN ('active','revoke_pending','revoked')),
        paid_until_ms     INTEGER NOT NULL,
        native_expires_ms INTEGER,
        attempts          INTEGER NOT NULL DEFAULT 0,
        next_retry_ms     INTEGER,
        last_error        TEXT,
        reason            TEXT
      );
      CREATE TABLE IF NOT EXISTS provider_charges (
        grant_id INTEGER NOT NULL,
        day      INTEGER NOT NULL,
        amount   TEXT    NOT NULL,
        over_cap INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (grant_id, day)
      );
    `);
  }

  /** In `hosted` mode an adapter for a real service is refused here, before any grant can reach it. */
  register(adapter: ProviderAccessAdapter): void {
    if (this.mode === "hosted" && adapter.real) {
      throw new ProviderAccessError("hosted_mode_real_provider", `penyedia ${adapter.provider} nyata tidak boleh dipasang di broker hosted: token admin harus di mesin pemberi (self-hosted)`);
    }
    this.#adapters.set(adapter.provider, adapter);
  }

  #adapter(provider: string): ProviderAccessAdapter {
    const a = this.#adapters.get(provider);
    if (!a) throw new ProviderAccessError("provider_unknown", `tidak ada adapter untuk penyedia ${provider}`);
    return a;
  }

  access(grantId: number): ProviderAccess | undefined {
    const r = this.#store.db.prepare("SELECT * FROM provider_access WHERE grant_id = ?").get(grantId) as Row | undefined;
    return r && toAccess(r);
  }

  list(status?: AccessStatus): ProviderAccess[] {
    const sql = status ? "SELECT * FROM provider_access WHERE status = ? ORDER BY grant_id" : "SELECT * FROM provider_access ORDER BY grant_id";
    return (this.#store.db.prepare(sql).all(...(status ? [status] : [])) as Row[]).map(toAccess);
  }

  #save(a: ProviderAccess): void {
    this.#store.db
      .prepare(
        `INSERT INTO provider_access (grant_id, provider, grantee_ref, handle, status, paid_until_ms, native_expires_ms, attempts, next_retry_ms, last_error, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (grant_id) DO UPDATE SET provider = excluded.provider, grantee_ref = excluded.grantee_ref, handle = excluded.handle, status = excluded.status,
           paid_until_ms = excluded.paid_until_ms, native_expires_ms = excluded.native_expires_ms, attempts = excluded.attempts, next_retry_ms = excluded.next_retry_ms,
           last_error = excluded.last_error, reason = excluded.reason`,
      )
      .run(a.grantId, a.provider, a.granteeRef, a.handle, a.status, a.paidUntilMs, a.nativeExpiresMs, a.attempts, a.nextRetryMs, a.lastError, a.reason);
  }

  /**
   * Open the access for `days` of rent (the first payment) or move the end of it (the next ones). The grantee is verified first on every call. The access never goes past `expires_at`
   * of the grant. A provider with native expiry must report the instant at which it closes the access, and it must not be later than the paid end: otherwise the grant is undone
   * and the call fails (`native_expiry_required`), because an access that the provider would keep open past the rent is not safe.
   */
  async grantAccess(grant: ProviderGrantInput, days = 1): Promise<{ access: ProviderAccess; delivery: Record<string, unknown> }> {
    const scope: ProviderScope = parseProviderScope(grant.limits.scope);
    const adapter = this.#adapter(scope.provider);
    const check = await adapter.verifyGranteeRef(scope.grantee_ref);
    if (!check.ok) throw new ProviderAccessError("grantee_ref_unverified", `${scope.grantee_ref}: ${check.reason}`);
    const existing = this.access(grant.grant_id);
    if (existing && existing.status !== "active") throw new ProviderAccessError("grant_failed", `akses grant ${grant.grant_id} sudah ${existing.status}`);
    const now = this.#now();
    const paidUntil = Math.min(Math.max(now, existing?.paidUntilMs ?? 0) + days * DAY_MS, nsToMs(grant.limits.expires_at));
    let result: ProviderGrantResult;
    try {
      result = await adapter.grant({ grantId: grant.grant_id, granteeRef: scope.grantee_ref, resource: scope.resource, permission: scope.permission, expiresAtMs: paidUntil });
    } catch (error) {
      throw new ProviderAccessError("grant_failed", (error as Error).message);
    }
    if (adapter.nativeExpiry && (result.nativeExpiresAtMs === null || result.nativeExpiresAtMs > paidUntil)) {
      // do not leave an access that outlives the rent
      await adapter.revoke(result.handle).catch(() => undefined);
      throw new ProviderAccessError("native_expiry_required", `penyedia ${scope.provider} punya kedaluwarsa bawaan tetapi tidak memasangnya sampai ${new Date(paidUntil).toISOString()}`);
    }
    const access: ProviderAccess = {
      grantId: grant.grant_id, provider: scope.provider, granteeRef: scope.grantee_ref, handle: result.handle, status: "active", paidUntilMs: paidUntil,
      nativeExpiresMs: result.nativeExpiresAtMs, attempts: 0, nextRetryMs: null, lastError: null, reason: null,
    };
    this.#save(access);
    this.#log?.(`provider access grant=${grant.grant_id} provider=${scope.provider} ref=${scope.grantee_ref} until=${new Date(paidUntil).toISOString()}`);
    return { access, delivery: result.delivery };
  }

  /** Close the access of a grant now (the contract revoked it, the lessee defaulted, the cap was passed). A provider that fails leaves it `revoke_pending`. */
  async revokeAccess(grantId: number, reason: string): Promise<ProviderAccess> {
    const a = this.access(grantId);
    if (!a) throw new ProviderAccessError("access_not_found", `grant ${grantId} tidak punya akses`);
    if (a.status === "revoked") return a;
    return this.#tryRevoke(a, reason);
  }

  async #tryRevoke(a: ProviderAccess, reason: string): Promise<ProviderAccess> {
    const now = this.#now();
    try {
      await this.#adapter(a.provider).revoke(a.handle);
      const done: ProviderAccess = { ...a, status: "revoked", nextRetryMs: null, lastError: null, reason: a.reason ?? reason };
      this.#save(done);
      this.#log?.(`provider access revoked grant=${a.grantId} reason=${reason} after ${a.attempts} failed attempts`);
      return done;
    } catch (error) {
      const attempts = a.attempts + 1;
      const wait = Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
      const pending: ProviderAccess = { ...a, status: "revoke_pending", attempts, nextRetryMs: now + wait, lastError: (error as Error).message, reason: a.reason ?? reason };
      this.#save(pending);
      this.#log?.(`provider access revoke_pending grant=${a.grantId} attempt=${attempts} retry in ${wait} ms: ${(error as Error).message}`);
      return pending;
    }
  }

  /** The clock: close what is past `paid_until`, and try again what is `revoke_pending` and due. Returns the accesses it touched. */
  async sweep(): Promise<ProviderAccess[]> {
    const now = this.#now();
    const touched: ProviderAccess[] = [];
    for (const a of this.list()) {
      if (a.status === "active" && now >= a.paidUntilMs) touched.push(await this.#tryRevoke(a, "paid_until"));
      else if (a.status === "revoke_pending" && (a.nextRetryMs ?? 0) <= now) touched.push(await this.#tryRevoke(a, a.reason ?? "retry"));
    }
    return touched;
  }

  /**
   * The bill of a day of a costly access: the real cost the provider reports for `[dayStart, dayStart + 1 day)`. It is written down (once per day) and returned for the rent of the next
   * day. A day over the cap of the grantor (`daily_cap` of the scope) is marked and the access is closed (`cap_exceeded`).
   */
  async settleDay(grant: ProviderGrantInput, dayStartMs: number): Promise<{ amount: bigint; overCap: boolean }> {
    const a = this.access(grant.grant_id);
    if (!a) throw new ProviderAccessError("access_not_found", `grant ${grant.grant_id} tidak punya akses`);
    const scope = parseProviderScope(grant.limits.scope);
    const adapter = this.#adapter(a.provider);
    const day = Math.floor(dayStartMs / DAY_MS);
    const known = this.#store.db.prepare("SELECT amount, over_cap FROM provider_charges WHERE grant_id = ? AND day = ?").get(grant.grant_id, day) as { amount: string; over_cap: number } | undefined;
    if (known) return { amount: BigInt(known.amount), overCap: known.over_cap === 1 };
    const amount = adapter.cost ? await adapter.cost(a.handle, day * DAY_MS, (day + 1) * DAY_MS) : 0n;
    const overCap = scope.daily_cap !== null && amount > BigInt(scope.daily_cap);
    this.#store.db.prepare("INSERT INTO provider_charges (grant_id, day, amount, over_cap) VALUES (?, ?, ?, ?)").run(grant.grant_id, day, amount.toString(), overCap ? 1 : 0);
    if (overCap && a.status === "active") await this.#tryRevoke(a, "cap_exceeded");
    return { amount, overCap };
  }

  /** The days that were billed, for the report of a grant. */
  charges(grantId: number): Array<{ day: number; amount: bigint; overCap: boolean }> {
    return (this.#store.db.prepare("SELECT day, amount, over_cap FROM provider_charges WHERE grant_id = ? ORDER BY day").all(grantId) as Array<{ day: number; amount: string; over_cap: number }>).map((r) => ({
      day: r.day, amount: BigInt(r.amount), overCap: r.over_cap === 1,
    }));
  }
}
