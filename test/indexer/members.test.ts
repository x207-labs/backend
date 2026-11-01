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

describe("BE-007 member_joined, stake_added, member_admitted", () => {
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

  describe("BE-007 member_joined, stake_added, member_admitted", () => {
    it("TC-BE-007-01 anggota baru", async () => {
      await ingest([block(1000, { logs: [joinLog("translator")] })]);
      expect(one("SELECT * FROM members")).toMatchObject({
        account_id: acct("translator"), status: "pending", stake: 0n, credit_limit: 0n, outstanding_debt: 0n, admitted: 0n,
        pubkey_voucher: "ed25519:translator", terms_hash: "terms-translator",
        joined_at_ns: BigInt(nsOf("2026-11-09T08:00:00Z")), exit_requested_epoch: null,
      });
    });

    it("TC-BE-007-02 join ganda dari receipt lain diabaikan", async () => {
      await ingest([block(1000, { logs: [joinLog("translator")] }), block(1001, { logs: [joinLog("translator").replace("terms-translator", "terms-lain")] })]);
      expect(all("SELECT terms_hash FROM members")).toEqual([{ terms_hash: "terms-translator" }]);
    });

    it("TC-BE-007-03 stake masuk", async () => {
      await ingest(upTo(2));
      expect(one("SELECT stake, credit_limit, status FROM members WHERE account_id = ?", acct("translator"))).toEqual({ stake: 100_000_000n, credit_limit: 80_000_000n, status: "active" });
      expect(all("SELECT reason, epoch, old_limit, new_limit FROM member_limits WHERE account_id = ?", acct("translator"))).toEqual([
        { reason: "stake", epoch: null, old_limit: 0n, new_limit: 80_000_000n },
      ]);
    });

    it("TC-BE-007-04 stake tambahan", async () => {
      await ingest([...upTo(2), block(1002, { logs: [stakeLog("translator", "20000000", "120000000", "96000000")] })]);
      expect(one("SELECT stake, credit_limit FROM members WHERE account_id = ?", acct("translator"))).toEqual({ stake: 120_000_000n, credit_limit: 96_000_000n });
      expect(all("SELECT old_limit, new_limit FROM member_limits WHERE account_id = ? ORDER BY id", acct("translator"))).toEqual([
        { old_limit: 0n, new_limit: 80_000_000n }, { old_limit: 80_000_000n, new_limit: 96_000_000n },
      ]);
    });

    it("TC-BE-007-06 admission DAO", async () => {
      await ingest([block(1000, { logs: [joinLog("translator")] }), block(1001, { logs: [eventLog("member_admitted", { account_id: acct("translator"), status: "pending" })] })]);
      expect(one("SELECT admitted, status FROM members")).toEqual({ admitted: 1n, status: "pending" });
    });
  });
});
