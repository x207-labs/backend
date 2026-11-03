import type { AccessGrant, AccountId, RevokeReason } from "@x207/core";
import type { BrokerChain } from "./chain.js";
import type { ClassBAdapter } from "./keys/class-b.js";
import type { BrokerStore } from "./store.js";
import type { WatchedEvent } from "./watcher/index.js";

export interface RevokerOptions {
  chain: BrokerChain;
  store: BrokerStore;
  classB: ClassBAdapter;
  /** Ids of the open grants that `account` rents, from the read API (`activeGrantIdsOf`). */
  activeGrantIdsOf: (account: AccountId) => Promise<number[]>;
  /** Wall clock in ms, the clock of `paid_until`. */
  now: () => number;
  log?: (line: string) => void;
}

export interface RevokeReport {
  /** Grants whose key was deleted by this call, with the reason that was sent to `revoke_grant`. */
  closed: Array<{ grantId: number; reason: RevokeReason | "already_final"; keyDeleted: boolean; revoked: boolean; error?: string }>;
}

const nsToMs = (ns: string): number => Number(BigInt(ns) / 1_000_000n);

/**
 * BK-007: closes class B leases. The key is deleted first (`DeleteKey`), because that is what stops the access; then `revoke_grant` puts
 * the status on chain. A failed `revoke_grant` is reported, never retried silently, and does not undo the `DeleteKey`.
 *  - `paid_until` passed: `DeleteKey` and `revoke_grant(operator)`.
 *  - `expires_at` reached: `DeleteKey` and `revoke_grant(expired)`.
 *  - the lessee defaulted (`member_defaulted`): for each active grant that the read API lists for the lessee and `get_grant` confirms, `DeleteKey` and `revoke_grant(defaulted)`.
 *  - somebody else revoked the grant (`grant_revoked`): only `DeleteKey`.
 */
export class Revoker {
  readonly #o: RevokerOptions;

  constructor(options: RevokerOptions) {
    this.#o = options;
  }

  #log(line: string): void {
    this.#o.log?.(`${new Date(this.#o.now()).toISOString()} ${line}`);
  }

  async #close(grant: AccessGrant, reason: RevokeReason, report: RevokeReport): Promise<void> {
    const entry: RevokeReport["closed"][number] = { grantId: grant.grant_id, reason, keyDeleted: false, revoked: false };
    const lease = this.#o.store.lease(grant.grant_id);
    try {
      if (lease?.keyAdded === true && !lease.closed) {
        await this.#o.classB.revoke(grant, reason);
        entry.keyDeleted = true;
        this.#log(`DeleteKey grant=${grant.grant_id} key=${lease.publicKey} reason=${reason}`);
      }
    } catch (error) {
      entry.error = `DeleteKey: ${(error as Error).message}`;
      report.closed.push(entry);
      return; // do not tell the contract that the access is gone while the key is still there
    }
    if (grant.status === "active" || grant.status === "offered") {
      const result = await this.#o.chain.revokeGrant(grant.grant_id, reason);
      entry.revoked = result.ok;
      if (!result.ok) entry.error = `revoke_grant: ${result.error}`;
      this.#log(`revoke_grant grant=${grant.grant_id} reason=${reason} ${result.ok ? `tx=${result.txHash}` : `failed ${result.error}`}`);
    }
    report.closed.push(entry);
  }

  /** The clock side: leases past `paid_until` or `expires_at`, and leases whose grant somebody else already revoked. */
  async sweep(): Promise<RevokeReport> {
    const report: RevokeReport = { closed: [] };
    const now = this.#o.now();
    const chainNow = await this.#o.chain.nowMs();
    for (const lease of this.#o.store.openLeases()) {
      const grant = await this.#o.chain.getGrant(lease.grantId);
      if (grant === null) continue;
      if (grant.status === "revoked" || grant.status === "expired") {
        await this.#close(grant, grant.status === "expired" ? "expired" : "operator", report);
        report.closed[report.closed.length - 1]!.reason = "already_final";
      } else if (chainNow >= nsToMs(grant.limits.expires_at)) {
        await this.#close(grant, "expired", report);
      } else if (now >= lease.paidUntilMs) {
        await this.#close(grant, "operator", report);
      }
    }
    return report;
  }

  /** `member_defaulted`: every active grant that `account` rents loses its key. */
  async onDefault(account: AccountId): Promise<RevokeReport> {
    const report: RevokeReport = { closed: [] };
    this.#log(`member_defaulted account=${account}`);
    for (const id of await this.#o.activeGrantIdsOf(account)) {
      const grant = await this.#o.chain.getGrant(id);
      if (grant !== null && grant.status === "active" && grant.grantee === account) await this.#close(grant, "defaulted", report);
    }
    return report;
  }

  /** Event handler for the watcher. */
  async handle(event: WatchedEvent): Promise<void> {
    if (event.event === "member_defaulted") {
      await this.onDefault(String(event.data.account_id));
    } else if (event.event === "grant_revoked") {
      const grant = await this.#o.chain.getGrant(Number(event.data.grant_id));
      const lease = grant === null ? undefined : this.#o.store.lease(grant.grant_id);
      if (grant !== null && lease?.keyAdded === true && !lease.closed) {
        await this.#o.classB.revoke(grant, event.data.reason as RevokeReason);
        this.#log(`DeleteKey grant=${grant.grant_id} (revoked by ${String(event.data.reason)})`);
      }
    }
  }
}
