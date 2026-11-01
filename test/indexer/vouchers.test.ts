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

describe("BE-008 voucher_registered", () => {
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

  describe("BE-008 voucher_registered", () => {
    it("TC-BE-008-01 pasangan baru", async () => {
      await ingest(upTo(3));
      expect(one("SELECT seq, cumulative_amount, cleared, registration_mode FROM obligations WHERE debtor = ?", acct("translator"))).toEqual({
        seq: 12n, cumulative_amount: 30_000_000n, cleared: null, registration_mode: "cumulative",
      });
      expect(one("SELECT outstanding_debt FROM members WHERE account_id = ?", acct("translator"))).toEqual({ outstanding_debt: 30_000_000n });
      expect(one("SELECT phase FROM epochs WHERE epoch = 42")).toEqual({ phase: "open" });
    });

    it("TC-BE-008-02 seq naik", async () => {
      await ingest([...upTo(2), block(1002, { logs: [voucherLog(0, { seq: 11, cumulative_amount: "28000000", obligation: "28000000" })] }), block(1003, { logs: [voucherLog(0)] })]);
      expect(one("SELECT seq, cumulative_amount FROM obligations")).toEqual({ seq: 12n, cumulative_amount: 30_000_000n });
    });

    it("TC-BE-008-03 seq lama tiba belakangan, tetap tersimpan di events_raw", async () => {
      await ingest([...upTo(2), block(1002, { logs: [voucherLog(0)] }), block(1003, { logs: [voucherLog(0, { seq: 11, cumulative_amount: "28000000", obligation: "28000000", outstanding_debt: "28000000" })] })]);
      expect(one("SELECT seq, cumulative_amount FROM obligations")).toEqual({ seq: 12n, cumulative_amount: 30_000_000n });
      expect(one("SELECT outstanding_debt FROM members WHERE account_id = ?", acct("translator"))).toEqual({ outstanding_debt: 30_000_000n });
      expect(one("SELECT COUNT(*) AS n FROM events_raw WHERE event = 'voucher_registered'")).toEqual({ n: 2n });
    });

    it("TC-BE-008-04 seq sama dari receipt lain tidak mengubah baris", async () => {
      await ingest([...upTo(2), block(1002, { logs: [voucherLog(0)] }), block(1003, { logs: [voucherLog(0, { cumulative_amount: "99999999" })] })]);
      expect(one("SELECT cumulative_amount FROM obligations")).toEqual({ cumulative_amount: 30_000_000n });
    });

    it("TC-BE-008-05 mode demo", async () => {
      await ingest([...upTo(2), block(1002, { logs: [voucherLog(0, { mode: "per_request" })] })]);
      expect(one("SELECT registration_mode FROM obligations")).toEqual({ registration_mode: "per_request" });
    });

    it("TC-BE-008-06 epoch berbeda tidak bercampur", async () => {
      await ingest([...upTo(2), block(1002, { logs: [voucherLog(0), voucherLog(0, { epoch: 43 })] })]);
      expect(all("SELECT epoch FROM obligations ORDER BY epoch")).toEqual([{ epoch: 42n }, { epoch: 43n }]);
    });
  });
});
