import { describe, expect, it } from "vitest";
import { NEAR, runTopup, TOPUP_DEFAULTS, type SweepResult, type TopupDeps } from "../../src/faucet/topup.js";
import { createTxFrom, topupConfigFromEnv } from "../../src/faucet/topup-cli.js";

/** A faucet account whose balance goes up by `gain` per round; `failAt` (1-based) throws at that round. */
function fake(start: bigint, gain = 10n * NEAR, failAt = 0) {
  const state = { balance: start, rounds: 0, calls: 0, lines: [] as string[] };
  const deps: TopupDeps = {
    balance: async () => state.balance,
    sponsorAndSweep: async (): Promise<SweepResult> => {
      state.calls += 1;
      if (state.calls === failAt) throw new Error("faucet service answered 429");
      state.balance += gain;
      state.rounds += 1;
      return { createTx: `create${state.calls}`, deleteTx: `delete${state.calls}` };
    },
    log: (l) => state.lines.push(l),
  };
  return { state, deps };
}

describe("BE-117 faucet top-up", () => {
  it("TC-BE-117-01 defaults: under 3 NEAR refills, up to over 8 NEAR, at most 3 accounts", () => {
    expect(TOPUP_DEFAULTS).toEqual({ lowYocto: 3n * NEAR, highYocto: 8n * NEAR, maxAccounts: 3 });
  });

  it("TC-BE-117-02 at or over the low mark nothing is created", async () => {
    for (const start of [3n * NEAR, 9n * NEAR]) {
      const f = fake(start);
      const s = await runTopup(TOPUP_DEFAULTS, f.deps);
      expect(s).toMatchObject({ rounds: 0, reason: "not_needed", before: start, after: start });
      expect(f.state.calls).toBe(0);
    }
  });

  it("TC-BE-117-03 under the low mark: one round of 10 NEAR is enough, and the run stops once the balance is over the high mark", async () => {
    const f = fake(2n * NEAR);
    const s = await runTopup(TOPUP_DEFAULTS, f.deps);
    expect(s).toMatchObject({ rounds: 1, reason: "reached_high", before: 2n * NEAR, after: 12n * NEAR });
    expect(f.state.lines.some((l) => l.includes("create tx create1") && l.includes("delete tx delete1") && l.includes("2.0000 -> 12.0000"))).toBe(true);
  });

  it("TC-BE-117-04 a small gain repeats up to the cap of 3 accounts and then stops", async () => {
    const f = fake(1n * NEAR, 1n * NEAR);
    const s = await runTopup(TOPUP_DEFAULTS, f.deps);
    expect(s).toMatchObject({ rounds: 3, reason: "max_accounts", after: 4n * NEAR });
    expect(f.state.calls).toBe(3);
  });

  it("TC-BE-117-05 a gain that gets over the high mark in two rounds uses two accounts", async () => {
    const f = fake(1n * NEAR, 4n * NEAR);
    const s = await runTopup(TOPUP_DEFAULTS, f.deps);
    expect(s).toMatchObject({ rounds: 2, reason: "reached_high", after: 9n * NEAR });
  });

  it("TC-BE-117-06 a refusal by the service ends the run at once, with no retry", async () => {
    const f = fake(1n * NEAR, 4n * NEAR, 2);
    const s = await runTopup(TOPUP_DEFAULTS, f.deps);
    expect(s).toMatchObject({ rounds: 1, reason: "refused", after: 5n * NEAR });
    expect(f.state.calls).toBe(2);
    const refused = fake(1n * NEAR, 4n * NEAR, 1);
    expect((await runTopup(TOPUP_DEFAULTS, refused.deps)).reason).toBe("refused");
    expect(refused.state.calls).toBe(1);
  });

  it("TC-BE-117-07 a round that does not raise the balance ends the run", async () => {
    const f = fake(1n * NEAR, 0n);
    const s = await runTopup(TOPUP_DEFAULTS, f.deps);
    expect(s).toMatchObject({ rounds: 1, reason: "no_gain" });
    expect(f.state.calls).toBe(1);
  });

  it("TC-BE-117-08 the log has balances and hashes only (no key text)", async () => {
    const f = fake(2n * NEAR);
    await runTopup(TOPUP_DEFAULTS, f.deps);
    expect(f.state.lines.join("\n")).not.toMatch(/ed25519|secret|private/i);
  });

  it("TC-BE-117-09 env: marks and cap are read, bad values throw; the hash of the creation is read from the service answer", () => {
    expect(topupConfigFromEnv({})).toEqual(TOPUP_DEFAULTS);
    expect(topupConfigFromEnv({ X207_FAUCET_TOPUP_LOW_YOCTO: "100", X207_FAUCET_TOPUP_HIGH_YOCTO: "200", X207_FAUCET_TOPUP_MAX_ACCOUNTS: "1" })).toEqual({ lowYocto: 100n, highYocto: 200n, maxAccounts: 1 });
    expect(() => topupConfigFromEnv({ X207_FAUCET_TOPUP_LOW_YOCTO: "3 NEAR" })).toThrow(/whole number/);
    expect(createTxFrom({ transaction: { hash: "abc" } })).toBe("abc");
    expect(createTxFrom({ transaction_outcome: { id: "def" } })).toBe("def");
    expect(createTxFrom({})).toBeNull();
    expect(createTxFrom(null)).toBeNull();
  });
});
