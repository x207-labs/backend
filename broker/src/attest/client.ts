// BK-009: the client side of `GET /attestation`. A client that needs the secrets to be safe from the operator of the broker sets `requireTee`; the answer
// `{"mode":"none"}` is then a refusal, and so is a quote that does not verify or a code hash other than the released one. Without `requireTee` the answer is
// only reported: the caller sees `mode: "none"` and decides. The broker's own word `mode: "tee"` counts for nothing until `verify` accepted the quote.
import { randomBytes } from "node:crypto";
import { NONCE, type AttestationBody, type Attestor } from "./index.js";

export class AttestationError extends Error {
  constructor(readonly code: "tee_required" | "nonce_mismatch" | "bad_answer" | "code_hash_mismatch" | "quote_invalid" | "no_verifier", message: string) {
    super(message);
    this.name = "AttestationError";
  }
}

export interface FetchAttestationOptions {
  /** Refuse a broker that is not attested. */
  requireTee?: boolean;
  /** The code hash of the released broker (needed with `requireTee`). */
  expectedCodeHash?: string;
  /** Checks a quote (`verify` of an `Attestor`); needed with `requireTee`. */
  verifier?: Pick<Attestor, "verify">;
  /** The nonce to send (hex, 8 to 64 bytes); default: 16 random bytes, new for each call. The answer must repeat it. */
  nonce?: string;
  fetch?: typeof fetch;
}

export type AttestationResult = { mode: "none"; reason: string } | { mode: "tee"; verified: true; codeHash: string };

function parse(value: unknown): AttestationBody {
  const v = value as Record<string, unknown> | null;
  if (v !== null && typeof v === "object") {
    const nonce = typeof v.nonce === "string" ? { nonce: v.nonce } : {};
    if (v.mode === "none" && typeof v.reason === "string") return { mode: "none", reason: v.reason, ...nonce };
    if (v.mode === "tee" && typeof v.quote === "string" && typeof v.codeHash === "string") return { mode: "tee", quote: v.quote, codeHash: v.codeHash, ...nonce };
  }
  throw new AttestationError("bad_answer", "GET /attestation did not answer {mode:\"none\",reason} or {mode:\"tee\",quote,codeHash}");
}

export async function fetchAttestation(brokerUrl: string, options: FetchAttestationOptions = {}): Promise<AttestationResult> {
  const nonce = options.nonce ?? randomBytes(16).toString("hex");
  if (!NONCE.test(nonce)) throw new AttestationError("bad_answer", "nonce: 8 to 64 bytes in hex");
  const response = await (options.fetch ?? fetch)(`${brokerUrl.replace(/\/+$/, "")}/attestation?nonce=${nonce}`, { redirect: "error" });
  if (!response.ok) throw new AttestationError("bad_answer", `GET /attestation answered ${response.status}`);
  const body = parse(await response.json().catch(() => null));
  // an old answer, or one made for another request, repeats another nonce or none: refused whatever its mode
  if (body.nonce?.toLowerCase() !== nonce.toLowerCase()) throw new AttestationError("nonce_mismatch", "the answer does not repeat the nonce of this request: it may be an old answer");
  if (body.mode === "none") {
    if (options.requireTee) throw new AttestationError("tee_required", `a TEE is required and this broker has none: ${body.reason}`);
    return body;
  }
  // a broker that says "tee" is checked even when the caller does not require one: a false claim is worse than none
  if (options.verifier === undefined || options.expectedCodeHash === undefined) {
    if (options.requireTee) throw new AttestationError("no_verifier", "requireTee needs a verifier and the code hash of the released broker");
    throw new AttestationError("no_verifier", "the broker claims a TEE and this client has no verifier or released code hash to check it");
  }
  if (body.codeHash !== options.expectedCodeHash) throw new AttestationError("code_hash_mismatch", `the broker runs code ${body.codeHash}, the release is ${options.expectedCodeHash}`);
  const checked = await options.verifier.verify({ quote: body.quote, codeHash: body.codeHash }, options.expectedCodeHash, nonce);
  if (!checked.valid) throw new AttestationError("quote_invalid", checked.reason);
  return { mode: "tee", verified: true, codeHash: body.codeHash };
}
