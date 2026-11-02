// BK-009 (class C, roadmap): the interface of the attestation of the broker. There is NO attestation in this build: the broker does not run
// in a TEE, `NoAttestation` says so, and nothing may present it as attested.
export interface Quote {
  /** Opaque TEE quote. */
  quote: string;
  /** Hash of the code that runs in the enclave. */
  codeHash: string;
}

export interface Attestor {
  /** The quote of this broker, or `null` when there is none. */
  quote(): Promise<Quote | null>;
  /** The client side: the quote is genuine and its code hash is the released one. */
  verify(quote: Quote, expectedCodeHash: string): Promise<{ valid: true } | { valid: false; reason: string }>;
}

export class NoAttestation implements Attestor {
  async quote(): Promise<null> {
    return null;
  }
  async verify(): Promise<{ valid: false; reason: string }> {
    return { valid: false, reason: "no_attestation: this broker does not run in a TEE" };
  }
}
