import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/index.js";
import { Indexer } from "../../src/indexer/indexer.js";
import {
  acct, appliedLog, ArrayBlockSource, block, claimedLog, claimFailedLog, committedLog, CONTRACT, cutoffLog, DEFAULT_PARAMS,
  defaultedLog, eventLog, finalizedLog, fxLog42, joinLog, limitsLog, nsOf, paidLog, paramsUpdatedLog, positions,
  stakeLog, voucherLog, submittedLog,
} from "../helpers/fx-log42.js";
import type { SourceBlock } from "../../src/indexer/block-source.js";

const CIRCLE = "agents-main";

describe("BE-009 epoch_cutoff, clearing_applied, epoch_committed", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDatabase(":memory:");
  });
  afterEach(() => db.close());

  async function ingest(blocks: SourceBlock[]): Promise<void> {
    const ix = new Indexer({ db, source: new ArrayBlockSource(blocks), circleId: CIRCLE, contractId: CONTRACT, startBlock: 1000 });
    await ix.bootstrap();
    await ix.drain();
  }
  const one = <T>(sql: string, ...args: unknown[]): T => db.prepare(sql).safeIntegers(true).get(...args) as T;
  const all = <T>(sql: string, ...args: unknown[]): T[] => db.prepare(sql).safeIntegers(true).all(...args) as T[];
  const upTo = (n: number): SourceBlock[] => fxLog42().slice(0, n);

  describe("BE-009 epoch_cutoff, clearing_applied, epoch_committed", () => {
    it("TC-BE-009-01 snapshot cutoff", async () => {
      await ingest(upTo(5));
      expect(one("SELECT phase, closed_at_ns, proposal_deadline_ns, edge_count, total_obligation FROM epochs WHERE epoch = 42")).toEqual({
        phase: "clearing", closed_at_ns: BigInt(nsOf("2026-11-09T11:19:56Z")), proposal_deadline_ns: BigInt(nsOf("2026-11-09T11:29:56Z")),
        edge_count: 7n, total_obligation: 190_000_000n,
      });
      expect(one("SELECT phase, cutoff_at_ns FROM epochs WHERE epoch = 43")).toEqual({ phase: "open", cutoff_at_ns: BigInt(nsOf("2026-11-09T12:19:56Z")) });
    });

    it("TC-BE-009-02 proposal kandidat tidak masuk read model", async () => {
      await ingest(upTo(7));
      expect(one("SELECT COUNT(*) AS n FROM events_raw WHERE event = 'clearing_submitted' AND handled = 1")).toEqual({ n: 2n });
      expect(one("SELECT COUNT(*) AS n FROM clearing_log")).toEqual({ n: 0n });
      expect(one("SELECT COUNT(*) AS n FROM obligations WHERE cleared IS NOT NULL")).toEqual({ n: 0n });
    });

    it("TC-BE-009-03 proposal diterapkan", async () => {
      await ingest(upTo(8));
      expect(all<{ cleared: bigint }>("SELECT cleared FROM obligations").map((r) => Number(r.cleared)).sort((a, b) => a - b)).toEqual([
        5_000_000, 15_000_000, 15_000_000, 20_000_000, 30_000_000, 30_000_000, 30_000_000,
      ]);
      expect(one("SELECT solver, cleared_total, fee, edge_count FROM clearing_log WHERE epoch = 42")).toEqual({ solver: "solver-b", cleared_total: 145_000_000n, fee: 0n, edge_count: 7n });
      expect(one("SELECT cleared_total FROM epochs WHERE epoch = 42")).toEqual({ cleared_total: 145_000_000n });
    });

    it("TC-BE-009-04 edge yang tidak disebut dianggap 0 (ADR-31)", async () => {
      await ingest([...upTo(5), block(1005, { logs: [appliedLog([1, 2, 3], { cleared_total: "90000000" })] })]);
      expect(all<{ cleared: bigint }>("SELECT cleared FROM obligations").filter((r) => r.cleared === 0n)).toHaveLength(4);
      expect(one("SELECT edge_count FROM clearing_log")).toEqual({ edge_count: 3n });
    });

    it("TC-BE-009-05 tanpa proposal", async () => {
      await ingest([...upTo(5), block(1005, { logs: [appliedLog([], { solver: null, cleared_total: "0" })] })]);
      expect(all<{ cleared: bigint }>("SELECT cleared FROM obligations").every((r) => r.cleared === 0n)).toBe(true);
      expect(one("SELECT solver, cleared_total FROM clearing_log")).toEqual({ solver: "", cleared_total: 0n });
    });

    it("TC-BE-009-06 fee dijumlahkan", async () => {
      await ingest([...upTo(5), block(1005, { logs: [appliedLog(undefined, { clearing_fee: "100", solver_fee: "50" })] })]);
      expect(one("SELECT fee FROM clearing_log")).toEqual({ fee: 150n });
    });

    it("TC-BE-009-07 posisi setelah commit", async () => {
      await ingest(upTo(8));
      const s = (name: string) => one("SELECT role, net, amount, status, cleared, due_at_ns FROM settlements WHERE account_id = ?", acct(name));
      const deadline = BigInt(nsOf("2026-11-09T12:00:00Z"));
      expect(s("scraper")).toEqual({ role: "debtor", net: -35_000_000n, amount: 35_000_000n, status: "due", cleared: 15_000_000n, due_at_ns: deadline });
      expect(s("cleaner")).toMatchObject({ role: "debtor", net: -10_000_000n, status: "due", cleared: 20_000_000n });
      expect(s("gpu")).toMatchObject({ role: "creditor", net: 45_000_000n, amount: 45_000_000n, status: "claimable", cleared: 20_000_000n });
      for (const name of ["translator", "summarizer", "image"]) expect(s(name)).toMatchObject({ role: "none", net: 0n, amount: 0n, status: null, cleared: 30_000_000n });
      expect(one("SELECT COUNT(*) AS n FROM settlements")).toEqual({ n: 6n });
    });

    it("TC-BE-009-08 fase dan waktu commit", async () => {
      await ingest(upTo(8));
      expect(one("SELECT phase, committed_at_ns, payment_deadline_ns FROM epochs WHERE epoch = 42")).toEqual({
        phase: "payment_window", committed_at_ns: BigInt(nsOf("2026-11-09T11:30:00Z")), payment_deadline_ns: BigInt(nsOf("2026-11-09T12:00:00Z")),
      });
    });

    it("TC-BE-009-09 outstanding_debt dari event, bukan hasil hitung", async () => {
      const pos = positions();
      (pos[0] as { outstanding_debt: string }).outstanding_debt = "35000007";
      await ingest([...upTo(7), block(1007, { logs: [appliedLog(), committedLog({ positions: pos })] })]);
      expect(one("SELECT outstanding_debt FROM members WHERE account_id = ?", acct("scraper"))).toEqual({ outstanding_debt: 35_000_007n });
    });

    it("TC-BE-009-10 peserta berposisi nol memakai nilai event", async () => {
      await ingest([...upTo(7), block(1007, { logs: [appliedLog(), committedLog({ positions: positions({ translator: "7" }) })] })]);
      expect(one("SELECT outstanding_debt FROM members WHERE account_id = ?", acct("translator"))).toEqual({ outstanding_debt: 7n });
      expect(one("SELECT outstanding_debt FROM members WHERE account_id = ?", acct("summarizer"))).toEqual({ outstanding_debt: 0n });
    });

    it("TC-BE-009-11 jumlah due sama dengan jumlah claimable", async () => {
      await ingest(upTo(8));
      expect(one("SELECT SUM(amount) AS s FROM settlements WHERE status = 'due'")).toEqual({ s: 45_000_000n });
      expect(one("SELECT SUM(amount) AS s FROM settlements WHERE status = 'claimable'")).toEqual({ s: 45_000_000n });
    });

    it("TC-BE-009-12 fase hanya maju", async () => {
      await ingest([...upTo(8), block(1008, { logs: [cutoffLog()] })]);
      expect(one("SELECT phase FROM epochs WHERE epoch = 42")).toEqual({ phase: "payment_window" });
    });

    it("TC-BE-009-13 epoch_committed berpotongan", async () => {
      const pos = positions();
      await ingest([
        ...upTo(7),
        block(1007, { id: "ra", logs: [appliedLog(), committedLog({ positions: pos.slice(0, 3), chunk: 0, chunks: 2 })] }),
        block(1008, { id: "rb", logs: [committedLog({ positions: pos.slice(3), chunk: 1, chunks: 2 })] }),
      ]);
      expect(one("SELECT COUNT(*) AS n FROM settlements")).toEqual({ n: 6n });
      expect(one("SELECT phase FROM epochs WHERE epoch = 42")).toEqual({ phase: "payment_window" });
    });

    it("clearing_submitted yang berdiri sendiri hanya masuk events_raw", async () => {
      await ingest([block(1000, { logs: [submittedLog("solver-a", "1", 1, null)] })]);
      expect(all("SELECT handled FROM events_raw")).toEqual([{ handled: 1n }]);
    });
  });
});
