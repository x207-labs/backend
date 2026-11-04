// BK-009 (class C, roadmap): the interface of the attestation of the broker. There is NO attestation in this build: the broker does not run
// in a TEE, `NoAttestation` says so, and nothing may present it as attested.
export interface Quote {
  /** Opaque TEE quote. */
  quote: string;
  /** Hash of the code that runs in the enclave. */
  codeHash: string;
}

export interface Attestor {
  /** The quote of this broker, or `null` when there is none. With a `nonce` (hex from the client) the quote must be made over it, so an old quote cannot answer a new request. */
  quote(nonce?: string): Promise<Quote | null>;
  /** The client side: the quote is genuine, made over `nonce` when one was sent, and its code hash is the released one. */
  verify(quote: Quote, expectedCodeHash: string, nonce?: string): Promise<{ valid: true } | { valid: false; reason: string }>;
}

/** Why a broker without a TEE says so: the text of `GET /attestation` and of the refusal of a client that requires a TEE. */
export const NO_TEE_REASON = "this broker does not run in a TEE: whoever operates it can read the secrets it holds";

/** The body of `GET /attestation`: `{mode:"none",reason}` without a TEE, `{mode:"tee",quote,codeHash}` when the `Attestor` has a quote. The client never trusts `mode`: it verifies the quote. */
export type AttestationBody = ({ mode: "none"; reason: string } | { mode: "tee"; quote: string; codeHash: string }) & { nonce?: string };

/** `GET /attestation?nonce=<hex>`: 8 to 64 bytes in hex. The answer repeats the nonce, in both modes. */
export const NONCE = /^(?:[0-9a-f]{2}){8,64}$/i;

export async function attestationBody(attestor: Attestor, nonce?: string): Promise<AttestationBody> {
  const quote = await attestor.quote(nonce);
  const echo = nonce === undefined ? {} : { nonce };
  return quote === null ? { mode: "none", reason: NO_TEE_REASON, ...echo } : { mode: "tee", quote: quote.quote, codeHash: quote.codeHash, ...echo };
}

export class NoAttestation implements Attestor {
  async quote(): Promise<null> {
    return null;
  }
  async verify(): Promise<{ valid: false; reason: string }> {
    return { valid: false, reason: "no_attestation: this broker does not run in a TEE" };
  }
}
