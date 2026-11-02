import {
  AccessGrantError, meterGrant, priceOfGrant, type AccessAssetAdapter, type AccessGrant, type MeterCharge, type PriceQuote, type ProofResult, type Usage,
} from "@x207/core";
import type { Attestor } from "../attest/index.js";
import type { BrokerStore } from "../store.js";

export interface ProxyDelivery {
  /** Where the lessee sends its calls; it never gets the secret. */
  proxyUrl: string;
}

/**
 * Class C adapter (BK-008): the secret of the grantor stays in the broker's environment and the broker forwards the calls of the grantee. `prove`
 * is the attestation check of BK-009: this build has no TEE, so unless an `Attestor` that can verify is given, `prove` says so and never `valid`.
 */
export class ClassCAdapter implements AccessAssetAdapter<ProxyDelivery> {
  readonly assetClass = "C" as const;
  readonly #o: { baseUrl: string; attestor?: Attestor; expectedCodeHash?: string; store: BrokerStore };

  constructor(options: { baseUrl: string; attestor?: Attestor; expectedCodeHash?: string; store: BrokerStore }) {
    this.#o = options;
  }

  price(grant: AccessGrant): PriceQuote {
    return priceOfGrant(grant);
  }

  async prove(): Promise<ProofResult> {
    const { attestor, expectedCodeHash } = this.#o;
    if (attestor === undefined || expectedCodeHash === undefined) return { valid: false, reason: "no_attestation: this broker does not run in a TEE" };
    const quote = await attestor.quote();
    if (quote === null) return { valid: false, reason: "no_attestation: this broker does not run in a TEE" };
    return attestor.verify(quote, expectedCodeHash);
  }

  deliver(grant: AccessGrant): ProxyDelivery {
    return { proxyUrl: `${this.#o.baseUrl.replace(/\/+$/, "")}/grants/${grant.grant_id}/proxy/` };
  }

  /** One call: `unit_price` times 1. */
  meter(grant: AccessGrant, usage: Usage = { quantity: 1 }): MeterCharge {
    if (grant.unit !== "call") throw new AccessGrantError(`class C grants are priced per call, grant ${grant.grant_id} is per ${grant.unit}`);
    return meterGrant(grant, usage);
  }

  /** Nothing to close: the proxy refuses a grant that is no longer `active`. The calls counted are kept. */
  async revoke(): Promise<void> {}
}
