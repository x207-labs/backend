import type { AccessAssetAdapter, AccessGrant } from "@x207/core";
import type { BrokerChain } from "./chain.js";

/** Refusal codes of the broker: the four of Spec Binding x402 section 9 plus `grant_not_found` and `class_not_supported`. */
export type DispatchCode = "grant_not_found" | "grant_not_active" | "grant_revoked" | "grant_scope_denied" | "grant_quota_exceeded" | "class_not_supported";

export const DISPATCH_STATUS: Record<DispatchCode, number> = {
  grant_not_found: 404,
  grant_not_active: 403,
  grant_revoked: 403,
  grant_scope_denied: 403,
  grant_quota_exceeded: 429,
  class_not_supported: 501,
};

export class DispatchError extends Error {
  constructor(readonly code: DispatchCode, message: string = code) {
    super(message);
    this.name = "DispatchError";
  }
  get status(): number {
    return DISPATCH_STATUS[this.code];
  }
}

export interface DispatcherOptions {
  chain: BrokerChain;
  /** Adapter per class; a class without one is `class_not_supported` (A is handled by the contract, C and D are roadmap here). */
  adapters: Partial<Record<AccessGrant["class"], AccessAssetAdapter<unknown>>>;
}

const nsToMs = (ns: string): number => Number(BigInt(ns) / 1_000_000n);

/**
 * BK-004: reads the grant (`get_grant`) before any access leaves the broker. A grant that is not `active`, or is past
 * `expires_at`, never reaches an adapter: `offered` is `grant_not_active`, `revoked` and `expired` are `grant_revoked`.
 */
export class Dispatcher {
  readonly #o: DispatcherOptions;

  constructor(options: DispatcherOptions) {
    this.#o = options;
  }

  /** The grant if it may be served now; throws `DispatchError` otherwise. */
  async open(grantId: number): Promise<AccessGrant> {
    const grant = await this.#o.chain.getGrant(grantId);
    if (grant === null) throw new DispatchError("grant_not_found", `grant ${grantId} does not exist`);
    if (grant.status === "revoked" || grant.status === "expired") throw new DispatchError("grant_revoked", `grant ${grantId} is ${grant.status}`);
    if (grant.status !== "active") throw new DispatchError("grant_not_active", `grant ${grantId} is ${grant.status}`);
    if ((await this.#o.chain.nowMs()) >= nsToMs(grant.limits.expires_at)) throw new DispatchError("grant_revoked", `grant ${grantId} is past expires_at`);
    return grant;
  }

  adapterFor(grant: AccessGrant): AccessAssetAdapter<unknown> {
    const adapter = this.#o.adapters[grant.class];
    if (adapter === undefined) throw new DispatchError("class_not_supported", `class ${grant.class} is not served by this broker`);
    return adapter;
  }

  /** `open` then the `deliver` of the adapter of the class. */
  async deliver(grantId: number, days = 1): Promise<{ grant: AccessGrant; delivery: unknown }> {
    const grant = await this.open(grantId);
    const adapter = this.adapterFor(grant);
    return { grant, delivery: await (adapter as AccessAssetAdapter<unknown> & { deliver(grant: AccessGrant, days?: number): unknown }).deliver(grant, days) };
  }
}
