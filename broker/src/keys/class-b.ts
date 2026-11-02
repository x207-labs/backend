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

  /** Adds the key on the first payment; every payment moves `paid_until` forward by `days`, up to `expires_at`. */
  async deliver(grant: AccessGrant, days = 1): Promise<LeaseDelivery> {
    if (grant.delivery_pubkey === null || grant.delivery_pubkey === undefined) throw new AccessGrantError(`grant ${grant.grant_id} has no delivery_pubkey`);
    const scope = parseFunctionCallKeyScope(grant.limits.scope);
    const { store, chain } = this.#o;
    let lease = store.lease(grant.grant_id) ?? { grantId: grant.grant_id, publicKey: grant.delivery_pubkey, paidUntilMs: 0, keyAdded: false, closed: false };
    if (lease.closed) throw new AccessGrantError(`lease of grant ${grant.grant_id} is closed`);
    if (!lease.keyAdded) {
      await chain.addLeaseKey(lease.publicKey, grant.limits.scope);
      lease = { ...lease, keyAdded: true };
    }
    const now = this.#o.now();
    const extended = Math.max(now, lease.paidUntilMs) + days * DAY_MS;
    lease = { ...lease, paidUntilMs: Math.min(extended, nsToMs(grant.limits.expires_at)) };
    store.save(lease);
    return {
      account: chain.leaseAccount, publicKey: lease.publicKey, paidUntil: new Date(lease.paidUntilMs).toISOString(),
      receiverId: scope.receiver_id, methodNames: scope.method_names,
    };
  }

  /** `DeleteKey` and the lease is closed. Safe to call twice. */
  async revoke(grant: AccessGrant, _reason?: RevokeReason): Promise<void> {
    const lease = this.#o.store.lease(grant.grant_id);
    if (lease === undefined || lease.closed) return;
    if (lease.keyAdded) await this.#o.chain.deleteLeaseKey(lease.publicKey);
    this.#o.store.save({ ...lease, closed: true });
  }
}
