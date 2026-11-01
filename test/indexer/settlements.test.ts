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

describe("BE-010 residual_paid, residual_claimed, residual_claim_failed", () => {
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

  describe("BE-010 residual_paid, residual_claimed, residual_claim_failed", () => {
    it("TC-BE-010-01 debtor membayar", async () => {
      await ingest(upTo(9));
      expect(one("SELECT status, paid_amount FROM settlements WHERE account_id = ?", acct("cleaner"))).toEqual({ status: "paid", paid_amount: 10_000_000n });
      expect(one("SELECT tx_hash FROM settlements WHERE account_id = ?", acct("cleaner"))).not.toEqual({ tx_hash: null });
      expect(one("SELECT outstanding_debt, settled_history FROM members WHERE account_id = ?", acct("cleaner"))).toEqual({ outstanding_debt: 0n, settled_history: 10_000_000n });
    });

    it("TC-BE-010-03 klaim sukses", async () => {
      await ingest(fxLog42());
      expect(one("SELECT status, destination FROM settlements WHERE account_id = ?", acct("gpu"))).toEqual({ status: "claimed", destination: "intents" });
      expect(one("SELECT tx_hash FROM settlements WHERE account_id = ?", acct("gpu"))).not.toEqual({ tx_hash: null });
    });

    it("TC-BE-010-04 klaim dari status bukan claimable", async () => {
      await ingest([...upTo(9), block(1009, { logs: [claimedLog().replace(acct("gpu"), acct("scraper"))] })]);
      expect(one("SELECT status FROM settlements WHERE account_id = ?", acct("scraper"))).toEqual({ status: "due" });
    });

    it("TC-BE-010-05 klaim gagal penuh", async () => {
      await ingest([...upTo(10), block(1010, { logs: [claimFailedLog("45000000")] })]);
      expect(one("SELECT status, amount FROM settlements WHERE account_id = ?", acct("gpu"))).toEqual({ status: "claimable", amount: 45_000_000n });
      expect(one("SELECT COUNT(*) AS n FROM events_raw WHERE event = 'residual_claimed'")).toEqual({ n: 0n });
    });

    it("TC-BE-010-06 klaim sebagian (ADR-24)", async () => {
      await ingest([...upTo(10), block(1010, { logs: [claimedLog("30000000"), claimFailedLog("15000000")] })]);
      expect(one("SELECT status, amount FROM settlements WHERE account_id = ?", acct("gpu"))).toEqual({ status: "claimable", amount: 15_000_000n });
    });
  });
});
