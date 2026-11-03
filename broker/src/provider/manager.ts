// The manager of P2 accesses (BE-057, ADR-47). It sits between the grants of the contract and the adapters of the providers:
//   - `grantAccess` checks the grantee (`verifyGranteeRef`), opens the access for the paid day, and keeps `paid_until`; the next day's rent moves it;
//   - `sweep` closes what the clock closes; a revoke that fails is not forgotten: the access becomes `revoke_pending` and is tried again with growing waits, until it works;
//   - `settleDay` asks the provider for the REAL cost of a day of a costly access, writes it down for the bill, and closes the access when a day went over the cap of the grantor.
// Mode: `self-hosted` (the default) is the broker that the grantor runs; the administrator credential of a provider lives on that machine only. `hosted` is the broker that x207 runs
// for a demo: it refuses every adapter that talks to a real service, because it would need the credential of somebody else.
import { randomBytes } from "node:crypto";
import { GranteeProofError, granteeChallenge } from "@x207/core";
import type { BrokerStore } from "../store.js";
import {
  ProviderAccessError, parseProviderScope, type ProviderAccessAdapter, type ProviderGrantResult, type ProviderScope,
} from "./adapter.js";

export type BrokerMode = "self-hosted" | "hosted";
export type AccessStatus = "active" | "revoke_pending" | "revoked";
const DAY_MS = 86_400_000;
export const RETRY_BASE_MS = 30_000;
export const RETRY_MAX_MS = 3_600_000;
/** How long a challenge of a grant lasts. */
export const CHALLENGE_MS = 900_000;

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
  /** `verified`, or the warning when the provider could not prove the reference (`unproven: …`). */
  proof: string | null;
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
  proof: string | null;
}

const toAccess = (r: Row): ProviderAccess => ({
  grantId: r.grant_id, provider: r.provider, granteeRef: r.grantee_ref, handle: r.handle, status: r.status as AccessStatus, paidUntilMs: r.paid_until_ms,
  nativeExpiresMs: r.native_expires_ms, attempts: r.attempts, nextRetryMs: r.next_retry_ms, lastError: r.last_error, reason: r.reason, proof: r.proof,
});

/** The part of a grant that the manager needs. */
export interface ProviderGrantInput {
  grant_id: number;
  /** The NEAR account of the lessee (`grantee` of the grant). Needed by adapters that tie the reference to it. */
  grantee?: string | null;
  limits: { scope: string; expires_at: string };
}

export interface ManagerOptions {
  store: BrokerStore;
  /** Account of the circle contract: the `circle` of the challenges and of the notices. */
  circle?: string;
  /** Voucher public key of an account, from the read API (for the proofs that are signed with it). */
  voucherKeyOf?: (account: string) => Promise<string | null>;
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
  readonly #circle: string;
  readonly #voucherKeyOf: ((account: string) => Promise<string | null>) | undefined;
  /** Grants whose proof is being checked right now. */
  readonly #proving = new Set<number>();

  constructor(options: ManagerOptions) {
    this.#store = options.store;
    this.mode = options.mode ?? "self-hosted";
    this.#now = options.now ?? Date.now;
    this.#log = options.log;
    this.#circle = options.circle ?? "";
    this.#voucherKeyOf = options.voucherKeyOf;
    this.#store.db.exec(`
      CREATE TABLE IF NOT EXISTS grantee_challenges (
        grant_id      INTEGER PRIMARY KEY,
        nonce         TEXT    NOT NULL,
        expires_at_ms INTEGER NOT NULL
      );
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
        reason            TEXT,
        proof             TEXT
      );
      CREATE TABLE IF NOT EXISTS provider_shared_keys (
        grant_id INTEGER PRIMARY KEY,
        key      TEXT    NOT NULL
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
      throw new ProviderAccessError("hosted_mode_real_provider", `real provider ${adapter.provider} must not be installed on a hosted broker: the admin token must stay on the grantor's machine (self-hosted)`);
    }
    this.#adapters.set(adapter.provider, adapter);
  }

  #adapter(provider: string): ProviderAccessAdapter {
    const a = this.#adapters.get(provider);
    if (!a) throw new ProviderAccessError("provider_unknown", `no adapter for provider ${provider}`);
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
        `INSERT INTO provider_access (grant_id, provider, grantee_ref, handle, status, paid_until_ms, native_expires_ms, attempts, next_retry_ms, last_error, reason, proof)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (grant_id) DO UPDATE SET provider = excluded.provider, grantee_ref = excluded.grantee_ref, handle = excluded.handle, status = excluded.status,
           paid_until_ms = excluded.paid_until_ms, native_expires_ms = excluded.native_expires_ms, attempts = excluded.attempts, next_retry_ms = excluded.next_retry_ms,
           last_error = excluded.last_error, reason = excluded.reason, proof = excluded.proof`,
      )
      .run(a.grantId, a.provider, a.granteeRef, a.handle, a.status, a.paidUntilMs, a.nativeExpiresMs, a.attempts, a.nextRetryMs, a.lastError, a.reason, a.proof);
  }

  /**
   * Open the access for `days` of rent (the first payment) or move the end of it (the next ones). The grantee is verified first on every call. The access never goes past `expires_at`
   * of the grant. A provider with native expiry must report the instant at which it closes the access, and it must not be later than the paid end: otherwise the grant is undone
   * and the call fails (`native_expiry_required`), because an access that the provider would keep open past the rent is not safe.
   */
  async grantAccess(grant: ProviderGrantInput, days = 1, proof: string | null = null): Promise<{ access: ProviderAccess; delivery: Record<string, unknown>; warnings: string[] }> {
    const scope: ProviderScope = parseProviderScope(grant.limits.scope);
    const adapter = this.#adapter(scope.provider);
    const check = await adapter.verifyGranteeRef(scope.grantee_ref);
    if (!check.ok) throw new ProviderAccessError("grantee_ref_unverified", `${scope.grantee_ref}: ${check.reason}`);
    const existing = this.access(grant.grant_id);
    const warnings: string[] = [];
    let proven: string | null = existing?.proof ?? null;
    // the proof is asked once, when the access is opened; the rent of the next days needs none
    if (!existing && adapter.proveGranteeRef) {
      // one proof at a time per grant, and the challenge is used up only by a verdict: a GitHub error, a rate limit or a timeout leaves it for another try (B4-F6)
      if (this.#proving.has(grant.grant_id)) throw new ProviderAccessError("grantee_ref_unverified", "proof for this grant is being checked; wait for the result");
      this.#proving.add(grant.grant_id);
      try {
        const challenge = adapter.needsChallenge ? this.#peekChallenge(grant.grant_id, scope.grantee_ref) : null;
        const voucherPublicKey = grant.grantee && this.#voucherKeyOf ? await this.#voucherKeyOf(grant.grantee) : null;
        let verdict: boolean | { unproven: string };
        try {
          verdict = await adapter.proveGranteeRef({ ref: scope.grantee_ref, proof, challenge, granteeAccount: grant.grantee ?? null, voucherPublicKey });
        } catch (error) {
          // only a failure to look (the gist could not be fetched, or any other error) keeps the challenge; a bad proof uses it up
          if (challenge !== null && error instanceof GranteeProofError && error.code !== "grantee_proof_unverifiable") this.#useUpChallenge(grant.grant_id);
          throw new ProviderAccessError("grantee_ref_unverified", `${scope.grantee_ref}: ${(error as Error).message}`);
        }
        if (challenge !== null) this.#useUpChallenge(grant.grant_id);
        if (verdict === false) throw new ProviderAccessError("grantee_ref_unverified", `${scope.grantee_ref}: ownership proof failed`);
        if (verdict !== true) {
          warnings.push("grantee_unproven");
          proven = `unproven: ${verdict.unproven}`;
        } else proven = "verified";
      } finally {
        this.#proving.delete(grant.grant_id);
      }
    }
    // an adapter with no proof at all (S3, AWS) says so, instead of leaving `null` that the page reads as "no information" (B4-F7); anything but `verified` carries the warning, also on a renewal
    if (proven === null && !adapter.proveGranteeRef) proven = "not_applicable";
    if (proven !== "verified" && !warnings.includes("grantee_unproven")) warnings.push("grantee_unproven");
    if (existing && existing.status !== "active") throw new ProviderAccessError("grant_failed", `access for grant ${grant.grant_id} is already ${existing.status}`);
    const now = this.#now();
    const paidUntil = Math.min(Math.max(now, existing?.paidUntilMs ?? 0) + days * DAY_MS, nsToMs(grant.limits.expires_at));
    // two live grants for one thing: the end of the first would take away what the second still pays for (B4-F2)
    const key = adapter.sharedKey?.({ granteeRef: scope.grantee_ref, resource: scope.resource }) ?? null;
    if (key !== null) {
      const other = this.#store.db.prepare(
        `SELECT k.grant_id FROM provider_shared_keys k JOIN provider_access a ON a.grant_id = k.grant_id WHERE k.key = ? AND k.grant_id <> ? AND a.status IN ('active','revoke_pending') LIMIT 1`,
      ).get(key, grant.grant_id) as { grant_id: number } | undefined;
      if (other) throw new ProviderAccessError("grant_failed", `grant ${other.grant_id} already opened the same access (${scope.provider}, ${scope.grantee_ref}); wait until it ends`);
    }
    let result: ProviderGrantResult;
    try {
      result = await adapter.grant({ grantId: grant.grant_id, granteeRef: scope.grantee_ref, resource: scope.resource, permission: scope.permission, expiresAtMs: paidUntil, existingHandle: existing?.handle ?? null });
    } catch (error) {
      // a refusal that the adapter names itself (a vote kind that is not for rent) keeps its code
      if (error instanceof ProviderAccessError) throw error;
      throw new ProviderAccessError("grant_failed", (error as Error).message);
    }
    if (adapter.nativeExpiry && (result.nativeExpiresAtMs === null || result.nativeExpiresAtMs > paidUntil)) {
      // do not leave an access that outlives the rent
      await adapter.revoke(result.handle).catch(() => undefined);
      throw new ProviderAccessError("native_expiry_required", `provider ${scope.provider} has a native expiry but does not set it up to ${new Date(paidUntil).toISOString()}`);
    }
    const access: ProviderAccess = {
      grantId: grant.grant_id, provider: scope.provider, granteeRef: scope.grantee_ref, handle: result.handle, status: "active", paidUntilMs: paidUntil,
      nativeExpiresMs: result.nativeExpiresAtMs, attempts: 0, nextRetryMs: null, lastError: null, reason: null, proof: proven,
    };
    this.#save(access);
    if (key !== null) this.#store.db.prepare("INSERT INTO provider_shared_keys (grant_id, key) VALUES (?, ?) ON CONFLICT (grant_id) DO UPDATE SET key = excluded.key").run(grant.grant_id, key);
    this.#log?.(`provider access grant=${grant.grant_id} provider=${scope.provider} ref=${scope.grantee_ref} until=${new Date(paidUntil).toISOString()}`);
    return { access, delivery: result.delivery, warnings };
  }

  /**
   * The challenge of a grant: a fixed text (`granteeChallenge` of the SDK) that binds the circle, the grant, the reference and a nonce of the broker. One live challenge per grant;
   * it lasts 15 minutes and is used up by the first proof that is checked (a proof cannot be tried again, nor replayed). Returns `null` when the provider needs none.
   */
  issueChallenge(grant: ProviderGrantInput): { text: string; nonce: string; expiresAtMs: number; circle: string; granteeRef: string } | null {
    const scope = parseProviderScope(grant.limits.scope);
    const adapter = this.#adapter(scope.provider);
    if (!adapter.needsChallenge) return null;
    const now = this.#now();
    const live = this.#store.db.prepare("SELECT nonce, expires_at_ms FROM grantee_challenges WHERE grant_id = ?").get(grant.grant_id) as { nonce: string; expires_at_ms: number } | undefined;
    const nonce = live && live.expires_at_ms > now ? live.nonce : randomBytes(16).toString("hex");
    const expiresAtMs = live && live.expires_at_ms > now ? live.expires_at_ms : now + CHALLENGE_MS;
    if (!live || live.nonce !== nonce) this.#store.db.prepare("INSERT INTO grantee_challenges (grant_id, nonce, expires_at_ms) VALUES (?, ?, ?) ON CONFLICT (grant_id) DO UPDATE SET nonce = excluded.nonce, expires_at_ms = excluded.expires_at_ms").run(grant.grant_id, nonce, expiresAtMs);
    return { text: granteeChallenge({ circle: this.#circle, grantId: grant.grant_id, granteeRef: scope.grantee_ref, nonce }), nonce, expiresAtMs, circle: this.#circle, granteeRef: scope.grantee_ref };
  }

  /** The live challenge of a grant, NOT used up: it is used up by `#useUpChallenge` once the proof was checked (B4-F6). */
  #peekChallenge(grantId: number, granteeRef: string): { circle: string; grantId: number; granteeRef: string; nonce: string } {
    const row = this.#store.db.prepare("SELECT nonce, expires_at_ms FROM grantee_challenges WHERE grant_id = ?").get(grantId) as { nonce: string; expires_at_ms: number } | undefined;
    if (!row) throw new ProviderAccessError("grantee_ref_unverified", "no challenge: request GET …/access/challenge first");
    if (row.expires_at_ms <= this.#now()) {
      this.#useUpChallenge(grantId);
      throw new ProviderAccessError("grantee_ref_unverified", "challenge has expired: request a new one");
    }
    return { circle: this.#circle, grantId, granteeRef, nonce: row.nonce };
  }

  #useUpChallenge(grantId: number): void {
    this.#store.db.prepare("DELETE FROM grantee_challenges WHERE grant_id = ?").run(grantId);
  }

  /** Close the access of a grant now (the contract revoked it, the lessee defaulted, the cap was passed). A provider that fails leaves it `revoke_pending`. */
  async revokeAccess(grantId: number, reason: string): Promise<ProviderAccess> {
    const a = this.access(grantId);
    if (!a) throw new ProviderAccessError("access_not_found", `grant ${grantId} has no access`);
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
    if (!a) throw new ProviderAccessError("access_not_found", `grant ${grant.grant_id} has no access`);
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

  /** The real cost since the start of today, not written down (the bill of the day is written by `settleDay` once the day is over). `null` for an access that costs nothing. */
  async costSoFar(grantId: number): Promise<bigint | null> {
    const a = this.access(grantId);
    if (!a) return null;
    const adapter = this.#adapter(a.provider);
    if (!adapter.cost) return null;
    const now = this.#now();
    return adapter.cost(a.handle, Math.floor(now / DAY_MS) * DAY_MS, now);
  }

  /** The days that were billed, for the report of a grant. */
  charges(grantId: number): Array<{ day: number; amount: bigint; overCap: boolean }> {
    return (this.#store.db.prepare("SELECT day, amount, over_cap FROM provider_charges WHERE grant_id = ? ORDER BY day").all(grantId) as Array<{ day: number; amount: string; over_cap: number }>).map((r) => ({
      day: r.day, amount: BigInt(r.amount), overCap: r.over_cap === 1,
    }));
  }
}
