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

describe("BE-011 member_defaulted, limits_updated, epoch_finalized", () => {
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

  describe("BE-011 member_defaulted, limits_updated, epoch_finalized", () => {
    it("TC-BE-011-01 debtor default", async () => {
      await ingest(upTo(10));
      expect(one("SELECT status, stake_slashed, reserve_used, shortfall FROM settlements WHERE account_id = ?", acct("scraper"))).toEqual({
        status: "defaulted", stake_slashed: 35_000_000n, reserve_used: 0n, shortfall: 0n,
      });
      expect(one("SELECT status, credit_limit, stake, outstanding_debt FROM members WHERE account_id = ?", acct("scraper"))).toEqual({
        status: "suspended", credit_limit: 0n, stake: 65_000_000n, outstanding_debt: 0n,
      });
      expect(one("SELECT reason, epoch, old_limit, new_limit FROM member_limits WHERE account_id = ? AND reason = 'default'", acct("scraper"))).toEqual({
        reason: "default", epoch: 42n, old_limit: 80_000_000n, new_limit: 0n,
      });
    });

    it("TC-BE-010-02 payment from a status that is not due", async () => {
      await ingest([...upTo(8), block(1008, { logs: [defaultedLog()] }), block(1009, { logs: [paidLog().replaceAll(acct("cleaner"), acct("scraper"))] })]);
      expect(one("SELECT status FROM settlements WHERE account_id = ?", acct("scraper"))).toEqual({ status: "defaulted" });
    });

    it("TC-BE-011-02 default from a status that is not due", async () => {
      await ingest([...upTo(9), block(1009, { logs: [defaultedLog("cleaner")] })]);
      expect(one("SELECT status FROM settlements WHERE account_id = ?", acct("cleaner"))).toEqual({ status: "paid" });
      expect(one("SELECT status, credit_limit FROM members WHERE account_id = ?", acct("cleaner"))).toEqual({ status: "active", credit_limit: 80_000_000n });
    });

    it("TC-BE-011-03 limit updated", async () => {
      await ingest(upTo(10));
      expect(one("SELECT credit_limit FROM members WHERE account_id = ?", acct("cleaner"))).toEqual({ credit_limit: 81_000_000n });
      expect(one("SELECT reason, epoch, old_limit, new_limit FROM member_limits WHERE account_id = ? AND reason = 'finalize'", acct("cleaner"))).toEqual({
        reason: "finalize", epoch: 42n, old_limit: 80_000_000n, new_limit: 81_000_000n,
      });
    });

    it("TC-BE-011-04 limits_updated in chunks: 60 history rows", async () => {
      const accounts = Array.from({ length: 60 }, (_, i) => `m${i}.x207-circle.near`);
      const joins = block(1000, ...accounts.map((a) => ({ logs: [eventLog("member_joined", { account_id: a, pubkey_voucher: "k", terms_hash: "t", status: "pending", joined_at: "1" })] })));
      const change = (a: string) => ({ account_id: a, old_limit: "1", new_limit: "2", status: "active" });
      await ingest([
        joins,
        block(1001, { id: "ra", logs: [eventLog("limits_updated", { epoch: 42, changes: accounts.slice(0, 30).map(change), chunk: 0, chunks: 2 })] }),
        block(1002, { id: "rb", logs: [eventLog("limits_updated", { epoch: 42, changes: accounts.slice(30).map(change), chunk: 1, chunks: 2 })] }),
      ]);
      expect(one("SELECT COUNT(*) AS n FROM member_limits")).toEqual({ n: 60n });
    });

    it("TC-BE-007-05 stake for a suspended member: status stays suspended", async () => {
      await ingest([...fxLog42(), block(1011, { logs: [stakeLog("scraper", "10000000", "75000000", "0", "suspended")] })]);
      expect(one("SELECT stake, status FROM members WHERE account_id = ?", acct("scraper"))).toEqual({ stake: 75_000_000n, status: "suspended" });
    });

    it("TC-BE-011-05 finalization", async () => {
      await ingest(upTo(10));
      expect(one("SELECT phase, finalized_at_ns FROM epochs WHERE epoch = 42")).toEqual({ phase: "finalized", finalized_at_ns: BigInt(nsOf("2026-11-09T12:00:30Z")) });
    });
  });
});
