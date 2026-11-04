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

/** Why a broker without a TEE says so: the text of `GET /attestation` and of the refusal of a client that requires a TEE. */
export const NO_TEE_REASON = "this broker does not run in a TEE: whoever operates it can read the secrets it holds";

/** The body of `GET /attestation`: `{mode:"none",reason}` without a TEE, `{mode:"tee",quote,codeHash}` when the `Attestor` has a quote. The client never trusts `mode`: it verifies the quote. */
export type AttestationBody = { mode: "none"; reason: string } | { mode: "tee"; quote: string; codeHash: string };

export async function attestationBody(attestor: Attestor): Promise<AttestationBody> {
  const quote = await attestor.quote();
  return quote === null ? { mode: "none", reason: NO_TEE_REASON } : { mode: "tee", quote: quote.quote, codeHash: quote.codeHash };
}

export class NoAttestation implements Attestor {
  async quote(): Promise<null> {
    return null;
  }
  async verify(): Promise<{ valid: false; reason: string }> {
    return { valid: false, reason: "no_attestation: this broker does not run in a TEE" };
  }
}
