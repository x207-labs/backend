// BK-009: the client side of `GET /attestation`. A client that needs the secrets to be safe from the operator of the broker sets `requireTee`; the answer
// `{"mode":"none"}` is then a refusal, and so is a quote that does not verify or a code hash other than the released one. Without `requireTee` the answer is
// only reported: the caller sees `mode: "none"` and decides. The broker's own word `mode: "tee"` counts for nothing until `verify` accepted the quote.
import type { AttestationBody, Attestor } from "./index.js";

export class AttestationError extends Error {
  constructor(readonly code: "tee_required" | "bad_answer" | "code_hash_mismatch" | "quote_invalid" | "no_verifier", message: string) {
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
  fetch?: typeof fetch;
}

export type AttestationResult = { mode: "none"; reason: string } | { mode: "tee"; verified: true; codeHash: string };

function parse(value: unknown): AttestationBody {
  const v = value as Record<string, unknown> | null;
  if (v !== null && typeof v === "object") {
    if (v.mode === "none" && typeof v.reason === "string") return { mode: "none", reason: v.reason };
    if (v.mode === "tee" && typeof v.quote === "string" && typeof v.codeHash === "string") return { mode: "tee", quote: v.quote, codeHash: v.codeHash };
  }
  throw new AttestationError("bad_answer", "GET /attestation did not answer {mode:\"none\",reason} or {mode:\"tee\",quote,codeHash}");
}

export async function fetchAttestation(brokerUrl: string, options: FetchAttestationOptions = {}): Promise<AttestationResult> {
  const response = await (options.fetch ?? fetch)(`${brokerUrl.replace(/\/+$/, "")}/attestation`, { redirect: "error" });
  if (!response.ok) throw new AttestationError("bad_answer", `GET /attestation answered ${response.status}`);
  const body = parse(await response.json().catch(() => null));
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
  const checked = await options.verifier.verify({ quote: body.quote, codeHash: body.codeHash }, options.expectedCodeHash);
  if (!checked.valid) throw new AttestationError("quote_invalid", checked.reason);
  return { mode: "tee", verified: true, codeHash: body.codeHash };
}
