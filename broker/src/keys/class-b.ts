import {
  AccessGrantError, meterGrant, parseFunctionCallKeyScope, priceOfGrant, verifyFunctionCallKey,
  type AccessAssetAdapter, type AccessGrant, type MeterCharge, type PriceQuote, type ProofResult, type RevokeReason, type Usage, type ViewAccessKeyFn,
} from "@x207/core";
import type { BrokerChain } from "../chain.js";
import type { BrokerStore } from "../store.js";

export const DAY_MS = 86_400_000;

/** What the lessee gets: the key it named at `accept_grant` now lives on the lease sub-account. Never a secret. */
export interface LeaseDelivery {
  account: string;
  publicKey: string;
  paidUntil: string;
  receiverId: string;
  methodNames: string[];
}

export interface ClassBOptions {
  chain: BrokerChain;
  store: BrokerStore;
  viewAccessKey: ViewAccessKeyFn;
  /** BE-100 (M1): reads at `final` finality; `revoke` closes a lease only when this view no longer shows the key. Without it `viewAccessKey` is used with no waiting. */
  viewFinalAccessKey?: ViewAccessKeyFn;
  /** How long `revoke` waits for the final head to show the deletion (default 20 s). */
  finalWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now: () => number;
}

const nsToMs = (ns: string): number => Number(BigInt(ns) / 1_000_000n);

/**
 * Class B adapter (BK-006): the grantor leases a NEAR function-call key. `deliver` adds the key that the lessee named in
 * `accept_grant` (`delivery_pubkey`) to the lease sub-account with the receiver, methods and allowance of the grant scope, and
 * keeps `paid_until`. Rent is one day per payment, never past `expires_at`. The secret of the lease sub-account stays in the
 * broker; the lessee only ever sees its own public key.
 */
export class ClassBAdapter implements AccessAssetAdapter<LeaseDelivery> {
  readonly assetClass = "B" as const;
  readonly #o: ClassBOptions;

  constructor(options: ClassBOptions) {
    this.#o = options;
  }

  price(grant: AccessGrant): PriceQuote {
    return priceOfGrant(grant);
  }

  meter(grant: AccessGrant, usage: Usage): MeterCharge {
    return meterGrant(grant, usage);
  }

  /** `verifyFunctionCallKey` of the SDK against the key as the node reports it. */
  async prove(grant: AccessGrant): Promise<ProofResult> {
    if (grant.delivery_pubkey === null || grant.delivery_pubkey === undefined) return { valid: false, reason: "no_delivery_pubkey" };
    return verifyFunctionCallKey(this.#o.chain.leaseAccount, grant.delivery_pubkey, grant, this.#o.viewAccessKey);
  }

  readonly #queues = new Map<number, Promise<unknown>>();

  /** Payments of one grant run one after the other: two parallel payments must add the key once and each move `paid_until` (security review 2). */
  deliver(grant: AccessGrant, days = 1): Promise<LeaseDelivery> {
    const run = (this.#queues.get(grant.grant_id) ?? Promise.resolve()).then(() => this.#deliver(grant, days));
    const tail = run.catch(() => undefined);
    this.#queues.set(grant.grant_id, tail);
    void tail.then(() => {
      if (this.#queues.get(grant.grant_id) === tail) this.#queues.delete(grant.grant_id);
    });
    return run;
  }

  /** Adds the key on the first payment; every payment moves `paid_until` forward by `days`, up to `expires_at`. */
  async #deliver(grant: AccessGrant, days: number): Promise<LeaseDelivery> {
    if (grant.delivery_pubkey === null || grant.delivery_pubkey === undefined) throw new AccessGrantError(`grant ${grant.grant_id} has no delivery_pubkey`);
    const scope = parseFunctionCallKeyScope(grant.limits.scope);
    const { store, chain } = this.#o;
    const previous = store.lease(grant.grant_id) ?? { grantId: grant.grant_id, publicKey: grant.delivery_pubkey, paidUntilMs: 0, keyAdded: false, closed: false };
    if (previous.closed) throw new AccessGrantError(`lease of grant ${grant.grant_id} is closed`);
    const now = this.#o.now();
    const extended = Math.max(now, previous.paidUntilMs) + days * DAY_MS;
    const lease = { ...previous, keyAdded: true, paidUntilMs: Math.min(extended, nsToMs(grant.limits.expires_at)) };
    if (!previous.keyAdded) {
      // BE-100 (M2): the intent is stored BEFORE `AddKey`. A key that lands on the chain while the call throws or the process dies has a row, so the sweep can delete it.
      store.save(lease);
      try {
        await chain.addLeaseKey(lease.publicKey, grant.limits.scope);
      } catch (error) {
        let onChain = false;
        try {
          onChain = (await this.#o.viewAccessKey(chain.leaseAccount, lease.publicKey)) !== null;
        } catch {
          onChain = true; // cannot tell: keep the row, the sweep deletes a key that is not there without harm
        }
        if (!onChain) {
          store.save(previous); // the key was never added: back to the state before this payment
          throw error;
        }
        // the transaction was executed although the call threw: the key is on the account, carry on
      }
    } else store.save(lease);
    return {
      account: chain.leaseAccount, publicKey: lease.publicKey, paidUntil: new Date(lease.paidUntilMs).toISOString(),
      receiverId: scope.receiver_id, methodNames: scope.method_names,
    };
  }

  /** `DeleteKey` and the lease is closed. Safe to call twice. BE-100 (L3): it runs in the queue of the grant, after a payment that is still adding the key. */
  revoke(grant: AccessGrant, _reason?: RevokeReason): Promise<void> {
    const run = (this.#queues.get(grant.grant_id) ?? Promise.resolve()).then(() => this.#revoke(grant));
    const tail = run.catch(() => undefined);
    this.#queues.set(grant.grant_id, tail);
    void tail.then(() => {
      if (this.#queues.get(grant.grant_id) === tail) this.#queues.delete(grant.grant_id);
    });
    return run;
  }

  async #revoke(grant: AccessGrant): Promise<void> {
    const lease = this.#o.store.lease(grant.grant_id);
    if (lease === undefined || lease.closed) return;
    if (lease.keyAdded) {
      await this.#o.chain.deleteLeaseKey(lease.publicKey);
      // BE-099/BE-100 (M1): close the lease only when the node no longer shows the key at FINAL finality (an optimistic block can be dropped and bring the key back);
      // the final head follows the optimistic one by a few blocks, so the check waits for it up to `finalWaitMs`. Otherwise the lease stays open and the next sweep deletes again.
      const view = this.#o.viewFinalAccessKey ?? this.#o.viewAccessKey;
      const waitMs = this.#o.viewFinalAccessKey === undefined ? 0 : (this.#o.finalWaitMs ?? 20_000);
      const sleep = this.#o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      let waited = 0;
      for (;;) {
        if ((await view(this.#o.chain.leaseAccount, lease.publicKey)) === null) break;
        if (waited >= waitMs) throw new Error(`key ${lease.publicKey} is still on ${this.#o.chain.leaseAccount} after DeleteKey`);
        await sleep(500);
        waited += 500;
      }
    }
    this.#o.store.save({ ...lease, closed: true });
  }
}
