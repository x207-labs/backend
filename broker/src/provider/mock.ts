// A generic mock provider (BE-057): the whole P2 flow without any real service. It keeps its access list in memory, can fail on demand, and can have a native expiry and a cost per day.
import type { AccessState, ProviderAccessAdapter, ProviderGrantRequest, ProviderGrantResult } from "./adapter.js";

export interface MockProviderOptions {
  provider?: string;
  /** The mock closes accesses by itself at their expiry (like `expiry-time=`). */
  nativeExpiry?: boolean;
  /** `real: true` lets a test check that hosted mode refuses a provider that looks real. */
  real?: boolean;
  now?: () => number;
  /** The mock asks for a proof of the reference: it must be `own:<ref>`. */
  requireProof?: boolean;
  /** Cost per day in the smallest unit, by handle; default none. */
  costPerDay?: (handle: string) => bigint;
}

interface Entry {
  grantId: number;
  ref: string;
  expiresAtMs: number;
  removed: boolean;
}

export class MockProviderAdapter implements ProviderAccessAdapter {
  readonly provider: string;
  readonly real: boolean;
  readonly nativeExpiry: boolean;
  readonly entries = new Map<string, Entry>();
  /** The next `n` calls of `revoke` fail (the provider is down). */
  failRevoke = 0;
  failGrant = 0;
  revokeCalls = 0;
  readonly #now: () => number;
  readonly #cost: ((handle: string) => bigint) | undefined;

  constructor(options: MockProviderOptions = {}) {
    this.provider = options.provider ?? "mock";
    this.real = options.real ?? false;
    this.nativeExpiry = options.nativeExpiry ?? false;
    this.#now = options.now ?? Date.now;
    this.#cost = options.costPerDay;
    if (options.requireProof) this.proveGranteeRef = async (ref, proof) => proof === `own:${ref}`;
    if (options.costPerDay) this.cost = async (handle, from, to) => (BigInt(Math.max(0, to - from)) * (this.#cost as (h: string) => bigint)(handle)) / 86_400_000n;
  }

  cost?: (handle: string, fromMs: number, toMs: number) => Promise<bigint>;
  proveGranteeRef?: (ref: string, proof: string | null) => Promise<boolean>;

  async verifyGranteeRef(ref: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    return /^[a-z0-9][a-z0-9_-]{1,38}$/.test(ref) ? { ok: true } : { ok: false, reason: "no such user on the mock provider" };
  }

  async grant(request: ProviderGrantRequest): Promise<ProviderGrantResult> {
    if (this.failGrant > 0) {
      this.failGrant -= 1;
      throw new Error("mock provider is down");
    }
    const handle = `mock-${request.grantId}`;
    this.entries.set(handle, { grantId: request.grantId, ref: request.granteeRef, expiresAtMs: request.expiresAtMs, removed: false });
    return { handle, nativeExpiresAtMs: this.nativeExpiry ? request.expiresAtMs : null, delivery: { provider: this.provider, account: request.granteeRef, resource: request.resource } };
  }

  async revoke(handle: string): Promise<void> {
    this.revokeCalls += 1;
    if (this.failRevoke > 0) {
      this.failRevoke -= 1;
      throw new Error("mock provider is down");
    }
    const e = this.entries.get(handle);
    if (e) e.removed = true;
  }

  async status(handle: string): Promise<AccessState> {
    const e = this.entries.get(handle);
    if (!e || e.removed) return "absent";
    return this.nativeExpiry && this.#now() >= e.expiresAtMs ? "expired" : "active";
  }
}
