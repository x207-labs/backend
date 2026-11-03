# BK-012: the interface of a zkTLS `prove`, with a mock verifier

Code: `broker/src/proof/zktls.ts`. Tests: `broker/test/zktls.test.ts` (6 pass, no network). **There is no real prover.** Nothing here checks a TLS session, a notary signature or a zero knowledge proof; the item stays partial.

## What exists
- The claim: `AccountClaim` = provider, account at the provider, plan, days left, time of the session (Unix ms). Example: plan `pro`, 12 days left at `api.example.com`.
- The raw proof: `ZkTlsEnvelope` = `{ format: "x207-zktls/1", scheme: "reclaim" | "tlsnotary" | "opacity" | "mock", claim, proof }`, where `proof` is the opaque base64 bytes of the scheme. It stays off chain, with the grantor and the broker.
- The hash: `proof_hash` = sha256 (64 hex) of the **canonical** JSON of the envelope (keys sorted, no spaces). D11 gets only `proof_hash` and `proof_kind` `"zktls"` (`grantProofFields`), which are the two fields `offer_grant` already takes (CT-072).
- `proveClaim(grant, envelope, verifier, requirements)` returns the `ProofResult` of `@x207/core`: valid only if the grant is of kind `zktls`, the envelope hashes to the `proof_hash` of the grant, the verifier accepts it, and the claim meets provider, plan, minimum days left and maximum age of the session. Each refusal has a reason.
- `ZkTlsVerifier` is the interface a real verifier implements (one class per scheme). `MockZkTlsVerifier` is the test double: it accepts a `mock` envelope whose proof is `mock:<sha256 of the claim>` and **refuses every real scheme** (`no_real_prover`). `proveClaim` also refuses a verifier with `real: false` unless the caller passes `allowMock: true`, so a mock result cannot be mistaken for evidence.

## What is missing, so that the item cannot be closed
1. A prover and a verifier for Reclaim, TLSNotary or Opacity: none was chosen, none was tried, no library is installed.
2. Whether the provider pages worth proving give a claim of this form (plan and days left) and whether the scheme can read it.
3. One real sample proof that verifies, with its format and hash recorded in a grant (the criterion of the item).
4. Where the broker keeps the raw proof, and how a lessee or a judge fetches it; today the caller passes the envelope in.
5. Trust in the notary or the attestation key of the scheme.
