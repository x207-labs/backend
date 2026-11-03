import { describe, expect, it } from "vitest";
import { canonicalEnvelope, grantProofFields, MockZkTlsVerifier, mockEnvelope, proofHash, proveClaim, ZKTLS_FORMAT, type AccountClaim, type ZkTlsEnvelope } from "../src/proof/zktls.js";
import { grant } from "./helpers.js";

const NOW = Date.parse("2026-11-05T10:00:00Z");
const CLAIM: AccountClaim = { provider: "api.example.com", account: "acct-42", plan: "pro", daysLeft: 12, observedAtMs: NOW - 60_000 };
const REQ = { provider: "api.example.com", plans: ["pro", "team"], minDaysLeft: 7, maxAgeMs: 3_600_000, now: NOW, allowMock: true };
const verifier = new MockZkTlsVerifier();
const withProof = (envelope: ZkTlsEnvelope) => grant({ ...grantProofFields(envelope) } as never);

describe("BK-012 zkTLS interface with a mock verifier (no real prover)", () => {
  it("TC-BK-012-01 the hash is over the canonical envelope: the order of the keys does not change it, any field does", () => {
    const envelope = mockEnvelope(CLAIM);
    const shuffled = JSON.parse(JSON.stringify({ proof: envelope.proof, claim: { observedAtMs: CLAIM.observedAtMs, daysLeft: 12, plan: "pro", account: "acct-42", provider: CLAIM.provider }, scheme: "mock", format: ZKTLS_FORMAT })) as ZkTlsEnvelope;
    expect(canonicalEnvelope(shuffled)).toBe(canonicalEnvelope(envelope));
    expect(proofHash(shuffled)).toBe(proofHash(envelope));
    expect(proofHash(envelope)).toMatch(/^[0-9a-f]{64}$/);
    expect(proofHash(mockEnvelope({ ...CLAIM, daysLeft: 13 }))).not.toBe(proofHash(envelope));
  });

  it("TC-BK-012-02 D11 gets the hash and the kind only; the raw proof is not among the fields", () => {
    const fields = grantProofFields(mockEnvelope(CLAIM));
    expect(Object.keys(fields).sort()).toEqual(["proof_hash", "proof_kind"]);
    expect(fields.proof_kind).toBe("zktls");
    expect(JSON.stringify(fields)).not.toContain("mock:");
  });

  it("TC-BK-012-03 a mock proof for the recorded envelope is valid only when the caller allows the mock", async () => {
    const envelope = mockEnvelope(CLAIM);
    expect(await proveClaim(withProof(envelope), envelope, verifier, REQ)).toEqual({ valid: true });
    const refused = await proveClaim(withProof(envelope), envelope, verifier, { ...REQ, allowMock: false });
    expect(refused).toMatchObject({ valid: false, reason: expect.stringContaining("mock_verifier") });
    expect(await proveClaim(withProof(envelope), envelope, verifier, { ...REQ, allowMock: undefined })).toMatchObject({ valid: false });
  });

  it("TC-BK-012-04 refusals: another envelope than the recorded hash, a grant of another kind, no hash", async () => {
    const envelope = mockEnvelope(CLAIM);
    const other = mockEnvelope({ ...CLAIM, daysLeft: 99 });
    expect(await proveClaim(withProof(envelope), other, verifier, REQ)).toMatchObject({ valid: false, reason: expect.stringContaining("proof_hash_mismatch") });
    expect(await proveClaim(grant({ proof_kind: "rpc_access_key", proof_hash: proofHash(envelope) } as never), envelope, verifier, REQ)).toMatchObject({ reason: expect.stringContaining("not_zktls") });
    expect(await proveClaim(grant({ proof_kind: "zktls", proof_hash: null } as never), envelope, verifier, REQ)).toMatchObject({ reason: "no_proof_hash" });
    const unknown = { ...envelope, format: "x207-zktls/9" } as unknown as ZkTlsEnvelope;
    expect(await proveClaim(withProof(envelope), unknown, verifier, REQ)).toMatchObject({ reason: expect.stringContaining("unknown_format") });
  });

  it("TC-BK-012-05 the mock cannot check a real scheme, and a mock proof that does not fit its claim is refused", async () => {
    for (const scheme of ["reclaim", "tlsnotary", "opacity"] as const) {
      const envelope: ZkTlsEnvelope = { format: ZKTLS_FORMAT, scheme, claim: CLAIM, proof: "AAEC" };
      expect(await proveClaim(withProof(envelope), envelope, verifier, REQ)).toMatchObject({ valid: false, reason: expect.stringContaining("no_real_prover") });
    }
    const forged: ZkTlsEnvelope = { ...mockEnvelope(CLAIM), proof: "mock:00" };
    expect(await proveClaim(withProof(forged), forged, verifier, REQ)).toMatchObject({ reason: "mock_proof_does_not_match_claim" });
  });

  it("TC-BK-012-06 the claim must meet the requirements: provider, plan, days left, age and the clock", async () => {
    const check = async (patch: Partial<AccountClaim>, req = REQ) => {
      const envelope = mockEnvelope({ ...CLAIM, ...patch });
      return proveClaim(withProof(envelope), envelope, verifier, req);
    };
    expect(await check({ provider: "evil.example.com" })).toMatchObject({ reason: expect.stringContaining("wrong_provider") });
    expect(await check({ plan: "free" })).toMatchObject({ reason: expect.stringContaining("plan_not_accepted") });
    expect(await check({ daysLeft: 6 })).toMatchObject({ reason: expect.stringContaining("too_few_days_left") });
    expect(await check({ daysLeft: Number.NaN })).toMatchObject({ valid: false });
    expect(await check({ observedAtMs: NOW - 7_200_000 })).toMatchObject({ reason: "session_too_old" });
    expect(await check({ observedAtMs: NOW + 600_000 })).toMatchObject({ reason: "observed_in_the_future" });
    expect(await check({ daysLeft: 7 })).toEqual({ valid: true });
    expect(await check({ plan: "anything" }, { ...REQ, plans: [] })).toEqual({ valid: true });
  });
});
