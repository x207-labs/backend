import { existsSync, readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/index.js";
import { bondLockedOf, computeCharges, feesForEpoch, proRataFee, verifyMembers } from "../../src/indexer/fee-charges.js";
import { epochHandlers } from "../../src/indexer/handlers/epochs.js";
import type { HandlerContext } from "../../src/indexer/handlers/index.js";
import { edgesHash } from "@x207/core";
import { prefetchClearingEdges } from "../../src/indexer/clearing-edges.js";
import { block, eventLog, CONTRACT } from "../helpers/fx-log42.js";

// BE-081: the fee that `commit_epoch` takes from the stake of the debtors, repeated by the indexer because no event says how much each member paid.
const CIRCLE = "agents-main";
const acct = (n: string): string => `${n}.test.near`;

describe("BE-081 the rule of pro_rata_fee and the charge", () => {
  it("TC-BE-081-01 floor shares, then the leftover one unit at a time in account order; a share of 0 is dropped", () => {
    const edges = [
      { debtor: "c.near", cleared: 10n }, { debtor: "a.near", cleared: 10n }, { debtor: "b.near", cleared: 10n }, { debtor: "a.near", cleared: 5n },
    ];
    // 100 over 35 cleared: a 25 (floor 71) ... a = 15, b = 10, c = 10 -> floors 42, 28, 28 = 98, leftover 2 go to a and b (order of the names)
    expect(proRataFee(edges, 35n, 100n).map((s) => [s.account, s.share])).toEqual([["a.near", 43n], ["b.near", 29n], ["c.near", 28n]]);
    expect(proRataFee(edges, 35n, 0n)).toEqual([]);
    expect(proRataFee(edges, 0n, 100n)).toEqual([]);
    // a debtor whose floor share is 0 and gets no leftover is not in the list
    const small = [{ debtor: "a.near", cleared: 1n }, { debtor: "b.near", cleared: 1n }, { debtor: "c.near", cleared: 1_000_000n }];
    expect(proRataFee(small, 1_000_002n, 5n).map((s) => [s.account, s.share])).toEqual([["a.near", 1n], ["c.near", 4n]]); // b: floor 0 and the one leftover unit went to a
  });

  it("TC-BE-081-02 the epoch 2 of x207-v013.testnet: 15 debtors, 210 edges of 1 credit, fees 10 and 5 bps: 21000 each, 99979000 left, limit 80000000 stays", () => {
    const members = new Map<string, { stake: bigint; limit: bigint }>();
    const edges: Array<{ debtor: string; cleared: bigint }> = [];
    for (let i = 0; i < 15; i++) {
      members.set(acct(`m${i}`), { stake: 100_000_000n, limit: 80_000_000n });
      for (let k = 0; k < 14; k++) edges.push({ debtor: acct(`m${i}`), cleared: 1_000_000n });
    }
    const out = computeCharges({ edges, clearedTotal: 210_000_000n, clearingBps: 10n, solverBps: 5n, members, bondLocked: () => 0n })!;
    expect(out.charges.map((c) => [c.take, c.stake, c.limit])).toEqual(Array.from({ length: 15 }, () => [21_000n, 99_979_000n, 80_000_000n]));
    expect([out.toReserve, out.toSolver]).toEqual([210_000n, 105_000n]); // the totals of the event clearing_applied
  });

  it("TC-BE-081-03 a stake that cannot cover its share pays what it has, the limit follows the stake minus the locked bond, and the totals shrink", () => {
    const members = new Map([[acct("a"), { stake: 1_000n, limit: 900n }], [acct("b"), { stake: 50_000n, limit: 40_000n }]]);
    const edges = [{ debtor: acct("a"), cleared: 500_000n }, { debtor: acct("b"), cleared: 500_000n }];
    // fee 10 + 5 bps of 1,000,000 = 1000 + 500 = 1500: 750 each; a pays 750 of 1000 (250 left, limit 250 less a bond of 100 = 150); b pays 750
    const out = computeCharges({ edges, clearedTotal: 1_000_000n, clearingBps: 10n, solverBps: 5n, members, bondLocked: (a) => (a === acct("a") ? 100n : 0n) })!;
    expect(out.charges).toEqual([{ account: acct("a"), take: 750n, stake: 250n, limit: 150n }, { account: acct("b"), take: 750n, stake: 49_250n, limit: 40_000n }]);
    const poor = computeCharges({ edges, clearedTotal: 1_000_000n, clearingBps: 10n, solverBps: 5n, members: new Map([[acct("a"), { stake: 100n, limit: 90n }], [acct("b"), { stake: 50_000n, limit: 40_000n }]]), bondLocked: () => 0n })!;
    expect(poor.charges[0]).toMatchObject({ take: 100n, stake: 0n, limit: 0n });
    expect([poor.toReserve, poor.toSolver]).toEqual([850n, 0n]); // 100 + 750 collected: the reserve first, nothing left for the solver
    expect(computeCharges({ edges, clearedTotal: 1_000_000n, clearingBps: 0n, solverBps: 0n, members, bondLocked: () => 0n })!.charges).toEqual([]);
    expect(computeCharges({ edges, clearedTotal: 1_000_000n, clearingBps: 10n, solverBps: 5n, members: new Map(), bondLocked: () => 0n })).toBeNull(); // a debtor the read model does not know
  });
});

describe("BE-081 the handler of clearing_applied charges the fee", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDatabase(":memory:");
    db.prepare("INSERT INTO circles (circle_id, contract_id, network) VALUES (?, ?, ?)").run(CIRCLE, CONTRACT, "x207:agents-main");
    db.prepare("INSERT INTO epochs (circle_id, epoch, phase) VALUES (?, 2, 'clearing')").run(CIRCLE);
    db.prepare("INSERT INTO params (circle_id, field, old_value, new_value, effective_epoch, block_height, receipt_id, log_index) VALUES (?, 'fees', NULL, ?, 0, 1, 'init:1', 0)").run(CIRCLE, JSON.stringify({ clearing_fee_bps: 10, solver_fee_bps: 5 }));
    for (let i = 0; i < 15; i++) {
      db.prepare("INSERT INTO members (circle_id, account_id, pubkey_voucher, terms_hash, stake, credit_limit, status, admitted, joined_at_ns, updated_block) VALUES (?, ?, 'ed25519:k', 'h', 100000000, 80000000, 'active', 1, 1, 1)").run(CIRCLE, acct(`m${i}`));
      for (let k = 1; k <= 14; k++) {
        db.prepare("INSERT INTO obligations (circle_id, epoch, debtor, creditor, seq, cumulative_amount, cleared, registration_mode, registered_block, receipt_id) VALUES (?, 2, ?, ?, 1, 1000000, NULL, 'cumulative', 1, 'r')").run(CIRCLE, acct(`m${i}`), acct(`m${(i + k) % 15}`));
      }
    }
  });
  afterEach(() => db.close());
  const ctx = (): HandlerContext => ({ db, circleId: CIRCLE, receiptId: "r-9", logIndex: 0, txHash: "tx-9", block: { height: 900, hash: "h900", timestampNs: 900n } });
  const edgesOfEpoch = (): Array<{ debtor: string; creditor: string; cleared: string }> =>
    (db.prepare("SELECT debtor, creditor FROM obligations WHERE epoch = 2").all() as Array<{ debtor: string; creditor: string }>).map((o) => ({ ...o, cleared: "1000000" }));
  const summary = (over: Record<string, unknown> = {}) => ({ epoch: 2, solver: "x207-v013.testnet", cleared_total: "210000000", edge_count: 210, edges_hash: edgesHash(edgesOfEpoch()), clearing_fee: "210000", solver_fee: "105000", ...over });
  const stakes = (): bigint[] => (db.prepare("SELECT stake FROM members ORDER BY account_id").safeIntegers(true).all() as Array<{ stake: bigint }>).map((r) => r.stake);
  const read = async (): Promise<void> => {
    await prefetchClearingEdges(db, CIRCLE, CONTRACT, block(900, { logs: [eventLog("clearing_applied", summary())] }), async () => edgesOfEpoch(), { attempts: 1, delayMs: 0, sleep: async () => undefined });
  };

  it("TC-BE-081-04 the testnet case through the handler: every stake 99979000, the limit 80000000, nothing stale", async () => {
    await read();
    epochHandlers.clearing_applied!(ctx(), summary() as never);
    expect(stakes()).toEqual(Array.from({ length: 15 }, () => 99_979_000n));
    expect(db.prepare("SELECT MAX(credit_limit) AS a, MIN(credit_limit) AS b, SUM(stale) AS s FROM members").get()).toEqual({ a: 80_000_000, b: 80_000_000, s: 0 });
  });

  it("TC-BE-081-05 totals that the charge does not add up to are not applied and the debtors are marked stale; so is an epoch whose pairs are gone", async () => {
    await read();
    epochHandlers.clearing_applied!(ctx(), summary({ clearing_fee: "210001" }) as never); // the event says 1 more than the rule gives
    expect(stakes()).toEqual(Array.from({ length: 15 }, () => 100_000_000n));
    expect(db.prepare("SELECT SUM(stale) AS s, SUM(fee_mismatches) AS m FROM members").get()).toEqual({ s: 15, m: 15 });
    // a pruned epoch: no set of edges, the debtors are marked
    db.prepare("UPDATE members SET stale = 0, fee_mismatches = 0").run();
    db.prepare("DELETE FROM clearing_edges").run();
    await prefetchClearingEdges(db, CIRCLE, CONTRACT, block(900, { logs: [eventLog("clearing_applied", summary())] }), async () => [], { attempts: 1, delayMs: 0, sleep: async () => undefined });
    epochHandlers.clearing_applied!(ctx(), summary() as never);
    expect(db.prepare("SELECT edges_unavailable FROM epochs WHERE epoch = 2").get()).toEqual({ edges_unavailable: 1 });
    expect(db.prepare("SELECT SUM(stale) AS s FROM members").get()).toEqual({ s: 15 });
  });

  it("TC-BE-081-06 no solver, no fee; fees of 0 bps, no fee; the fees in force are the last change that took effect by the epoch; a locked bond counts", async () => {
    await read();
    epochHandlers.clearing_applied!(ctx(), summary({ solver: null, clearing_fee: "0", solver_fee: "0" }) as never);
    expect(stakes()[0]).toBe(100_000_000n);
    db.prepare("INSERT INTO params (circle_id, field, old_value, new_value, effective_epoch, block_height, receipt_id, log_index) VALUES (?, 'fees', NULL, ?, 5, 2, 'r', 0)").run(CIRCLE, JSON.stringify({ clearing_fee_bps: 100, solver_fee_bps: 0 }));
    expect(feesForEpoch(db, CIRCLE, 2)).toEqual({ clearingBps: 10n, solverBps: 5n });
    expect(feesForEpoch(db, CIRCLE, 6)).toEqual({ clearingBps: 100n, solverBps: 0n });
    db.prepare("INSERT INTO deals (circle_id, bundle_id, party_a, party_b, bond_each, locked_a, locked_b, state, opened_block) VALUES (?, 1, ?, ?, 7, 1, 0, 'open', 1)").run(CIRCLE, acct("m0"), acct("m1"));
    expect(bondLockedOf(db, CIRCLE, acct("m0"))).toBe(7n);
    expect(bondLockedOf(db, CIRCLE, acct("m1"))).toBe(0n); // the bond of the second party is not locked yet
  });

  it("TC-BE-081-07 the watch: a member that differs from the view is taken from the view and marked stale (counted); an equal one stops being stale; the metrics say so", async () => {
    const view = Array.from({ length: 15 }, (_, i) => ({ account_id: acct(`m${i}`), stake: "100000000", limit: "80000000" }));
    view[3] = { account_id: acct("m3"), stake: "99979000", limit: "80000000" }; // the contract charged this one and the indexer did not
    expect(verifyMembers(db, CIRCLE, view, 901)).toEqual([acct("m3")]);
    expect(db.prepare("SELECT stake, stale, fee_mismatches FROM members WHERE account_id = ?").get(acct("m3"))).toEqual({ stake: 99_979_000, stale: 1, fee_mismatches: 1 });
    const { renderMetrics, Telemetry } = await import("../../src/api/telemetry.js");
    const text = renderMetrics(new Telemetry(1), db, 2);
    expect(text).toContain("x207_members_stale 1");
    expect(text).toContain("x207_indexer_fee_mismatches_total 1");
    expect(verifyMembers(db, CIRCLE, view.map((v) => (v.account_id === acct("m3") ? { ...v, stake: "99979000" } : v)), 902)).toEqual([]);
    expect(db.prepare("SELECT stale, fee_mismatches FROM members WHERE account_id = ?").get(acct("m3"))).toEqual({ stale: 0, fee_mismatches: 1 }); // the count stays
  });
});

// the golden vector of A2 (CT-101): `contracts/tests/vectors/fee_charges.json`, written by `scripts/fee_charges.py` from the rule of `commit.rs`
const VECTOR = new URL("../../../contracts/tests/vectors/fee_charges.json", import.meta.url).pathname;
interface VectorCase {
  name: string;
  solver: string | null;
  fees: { clearing_fee_bps: number; solver_fee_bps: number };
  edges: Array<{ debtor: string; creditor: string; cleared: string }>;
  members: Array<{ account: string; stake: string; limit: string; bond_locked: string }>;
  expected: { cleared_total: string; charges: Array<{ account: string; stake_cut: string; stake_after: string; limit_after: string }>; clearing_fee_charged: string; solver_fee_charged: string };
}
describe.skipIf(!existsSync(VECTOR))("BE-081 the golden vector of the fee charges", () => {
  const cases = (): VectorCase[] => (JSON.parse(readFileSync(VECTOR, "utf8")) as { cases: VectorCase[] }).cases;

  it("TC-BE-081-08 computeCharges gives the cuts, the stakes, the limits and the two totals of every case of the vector", () => {
    expect(cases().length).toBeGreaterThanOrEqual(8);
    for (const c of cases()) {
      const edges = c.edges.map((e) => ({ debtor: e.debtor, cleared: BigInt(e.cleared) }));
      const clearedTotal = edges.reduce((n, e) => n + e.cleared, 0n);
      expect([c.name, String(clearedTotal)]).toEqual([c.name, c.expected.cleared_total]);
      const members = new Map(c.members.map((m) => [m.account, { stake: BigInt(m.stake), limit: BigInt(m.limit) }]));
      const bonds = new Map(c.members.map((m) => [m.account, BigInt(m.bond_locked)]));
      const out = computeCharges({
        solver: c.solver, edges, clearedTotal, clearingBps: BigInt(c.fees.clearing_fee_bps), solverBps: BigInt(c.fees.solver_fee_bps), members, bondLocked: (a) => bonds.get(a) ?? 0n,
      })!;
      if (out.charges.length === 0) {
        // nothing is charged (no solver, nothing cleared, fees of 0): the vector lists every member unchanged, with a cut of 0
        expect(c.expected.charges.length, c.name).toBeGreaterThan(0);
        for (const x of c.expected.charges) {
          const m = c.members.find((y) => y.account === x.account)!;
          expect([c.name, x.stake_cut, x.stake_after, x.limit_after]).toEqual([c.name, "0", m.stake, m.limit]);
        }
      } else {
        expect([c.name, out.charges.map((x) => ({ account: x.account, stake_cut: String(x.take), stake_after: String(x.stake), limit_after: String(x.limit) }))]).toEqual([c.name, c.expected.charges]);
      }
      expect([c.name, String(out.toReserve), String(out.toSolver)]).toEqual([c.name, c.expected.clearing_fee_charged, c.expected.solver_fee_charged]);
    }
  });
});
