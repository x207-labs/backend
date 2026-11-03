import { createHash } from "node:crypto";
import type { AccessGrant, ProofResult } from "@x207/core";

/**
 * BK-012 (research): the interface of a zkTLS `prove` for an account claim ("plan X, N days left") and a **mock** verifier. There is no real prover here:
 * nothing in this file checks a TLS session, a notary signature or a zero knowledge proof. A real verifier (Reclaim, TLSNotary or Opacity) is one
 * class that implements `ZkTlsVerifier`; until then `proveClaim` refuses the mock unless the caller says `allowMock`, so a test double cannot be mistaken for evidence.
 *
 * The raw proof stays off chain. D11 holds only `proof_hash` (sha256 of the canonical envelope, hex) and `proof_kind` `zktls`.
 */
export const ZKTLS_KIND = "zktls";
export const ZKTLS_FORMAT = "x207-zktls/1";

/** What the grantor proves about its account at a provider. */
export interface AccountClaim {
  /** Host or name of the provider whose page or API was read, such as `api.example.com`. */
  provider: string;
  /** The account at the provider (not the NEAR account). */
  account: string;
  /** The plan, such as `pro`. */
  plan: string;
  daysLeft: number;
  /** When the session was recorded, Unix ms. */
  observedAtMs: number;
}

export type ZkTlsScheme = "reclaim" | "tlsnotary" | "opacity" | "mock";

/** The raw proof as the grantor hands it over; `proof` is opaque to this module (base64 of the bytes of the scheme). */
export interface ZkTlsEnvelope {
  format: typeof ZKTLS_FORMAT;
  scheme: ZkTlsScheme;
  claim: AccountClaim;
  proof: string;
}

export type VerifyOutcome = { ok: true } | { ok: false; reason: string };

export interface ZkTlsVerifier {
  /** `false` for a double that checks nothing cryptographic. */
  readonly real: boolean;
  verify(envelope: ZkTlsEnvelope): Promise<VerifyOutcome> | VerifyOutcome;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value as object).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, sortKeys(v)]));
  return value;
}

/** Canonical JSON: keys sorted, no spaces. The hash is over these bytes, so it does not depend on the order in which a client wrote the keys. */
export function canonicalEnvelope(envelope: ZkTlsEnvelope): string {
  return JSON.stringify(sortKeys(envelope));
}

/** `proof_hash` of the grant: sha256 of the canonical envelope, 64 hex characters. */
export function proofHash(envelope: ZkTlsEnvelope): string {
  return createHash("sha256").update(canonicalEnvelope(envelope), "utf8").digest("hex");
}

/** The two fields that go into `offer_grant` (`proof_hash`, `proof_kind`); the envelope itself is kept by the grantor and the broker. */
export function grantProofFields(envelope: ZkTlsEnvelope): { proof_hash: string; proof_kind: typeof ZKTLS_KIND } {
  return { proof_hash: proofHash(envelope), proof_kind: ZKTLS_KIND };
}

const claimDigest = (claim: AccountClaim): string => createHash("sha256").update(JSON.stringify(sortKeys(claim)), "utf8").digest("hex");

/** An envelope that only the mock verifier accepts: `proof` is `mock:` plus the digest of the claim. It proves nothing about any provider. */
export function mockEnvelope(claim: AccountClaim): ZkTlsEnvelope {
  return { format: ZKTLS_FORMAT, scheme: "mock", claim, proof: `mock:${claimDigest(claim)}` };
}

/** Test double. It accepts a `mock` envelope whose proof matches its claim, and refuses every real scheme because it cannot check one. */
export class MockZkTlsVerifier implements ZkTlsVerifier {
  readonly real = false;
  verify(envelope: ZkTlsEnvelope): VerifyOutcome {
    if (envelope.scheme !== "mock") return { ok: false, reason: `no_real_prover: this verifier cannot check a ${envelope.scheme} proof` };
    return envelope.proof === `mock:${claimDigest(envelope.claim)}` ? { ok: true } : { ok: false, reason: "mock_proof_does_not_match_claim" };
  }
}

export interface ZkTlsRequirements {
  provider: string;
  /** Accepted plans; empty or absent: any. */
  plans?: readonly string[];
  minDaysLeft: number;
  /** A session older than this is refused. */
  maxAgeMs: number;
  /** Unix ms now. */
  now: number;
  /** Accept the mock verifier. Default `false`: a mock is not evidence. */
  allowMock?: boolean;
}

const invalid = (reason: string): ProofResult => ({ valid: false, reason });

/**
 * `prove` of a grant of kind `zktls`: the envelope must be the one named by the grant (`proof_hash`), the verifier must accept it, and the claim must
 * meet the requirements (provider, plan, days left, age of the session). Every refusal says why. Raw proofs never go into a log or a response.
 */
export async function proveClaim(grant: AccessGrant, envelope: ZkTlsEnvelope, verifier: ZkTlsVerifier, requirements: ZkTlsRequirements): Promise<ProofResult> {
  if (grant.proof_kind !== ZKTLS_KIND) return invalid(`not_zktls: the grant has proof_kind ${String(grant.proof_kind)}`);
  if (grant.proof_hash === null || grant.proof_hash === undefined) return invalid("no_proof_hash");
  if (envelope.format !== ZKTLS_FORMAT) return invalid(`unknown_format: ${String(envelope.format)}`);
  if (proofHash(envelope) !== grant.proof_hash) return invalid("proof_hash_mismatch: the envelope is not the one recorded in the grant");
  if (!verifier.real && requirements.allowMock !== true) return invalid("mock_verifier: there is no real prover, a mock result is not evidence");
  const outcome = await verifier.verify(envelope);
  if (!outcome.ok) return invalid(outcome.reason);
  const { claim } = envelope;
  if (claim.provider !== requirements.provider) return invalid(`wrong_provider: ${claim.provider}`);
  if (requirements.plans !== undefined && requirements.plans.length > 0 && !requirements.plans.includes(claim.plan)) return invalid(`plan_not_accepted: ${claim.plan}`);
  if (!Number.isFinite(claim.daysLeft) || claim.daysLeft < requirements.minDaysLeft) return invalid(`too_few_days_left: ${claim.daysLeft} < ${requirements.minDaysLeft}`);
  if (!Number.isFinite(claim.observedAtMs) || claim.observedAtMs > requirements.now + 60_000) return invalid("observed_in_the_future");
  if (requirements.now - claim.observedAtMs > requirements.maxAgeMs) return invalid("session_too_old");
  return { valid: true };
}
