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

describe("BE-012 params_updated", () => {
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

  describe("BE-012 params_updated", () => {
    const init = async (blocks: SourceBlock[]): Promise<void> => {
      const ix = new Indexer({ db, source: new ArrayBlockSource(blocks), circleId: CIRCLE, contractId: CONTRACT, startBlock: 1000, fetchParams: () => Promise.resolve(DEFAULT_PARAMS as never) });
      await ix.bootstrap();
      await ix.drain();
    };

    it("TC-BE-012-01 one field changes", async () => {
      await init([block(1000, { logs: [paramsUpdatedLog()] })]);
      expect(one("SELECT old_value, new_value, effective_epoch FROM params WHERE field = 'payment_window' AND old_value IS NOT NULL")).toEqual({ old_value: "1800", new_value: "2700", effective_epoch: 43n });
    });

    it("TC-BE-012-02 several fields at once", async () => {
      await init([block(1000, { logs: [eventLog("params_updated", { old: DEFAULT_PARAMS, new: { ...DEFAULT_PARAMS, proposal_window: 900, limit_cap: "2000000000" }, changed: ["proposal_window", "limit_cap"], effective_epoch: 43 })] })]);
      const rows = all<{ field: string; receipt_id: string; log_index: bigint; new_value: string }>("SELECT field, receipt_id, log_index, new_value FROM params WHERE receipt_id NOT LIKE 'init:%' ORDER BY field");
      expect(rows.map((r) => r.field)).toEqual(["limit_cap", "proposal_window"]);
      expect(new Set(rows.map((r) => r.receipt_id)).size).toBe(1);
      expect(rows.map((r) => r.new_value)).toEqual(['"2000000000"', "900"]);
    });

    it("TC-BE-012-03 second proposal in the same epoch: params_active follows the latest", async () => {
      await init([block(1000, { logs: [paramsUpdatedLog()] }), block(1001, { logs: [eventLog("params_updated", { old: DEFAULT_PARAMS, new: { ...DEFAULT_PARAMS, payment_window: 2400 }, changed: ["payment_window"], effective_epoch: 43 })] })]);
      expect(one("SELECT COUNT(*) AS n FROM params WHERE field = 'payment_window'")).toEqual({ n: 3n });
      expect(one("SELECT value FROM params_active WHERE field = 'payment_window'")).toEqual({ value: "2400" });
    });

    it("TC-BE-012-04 fees structure", async () => {
      const fees = { clearing_fee_bps: 10, solver_fee_bps: 5 };
      await init([block(1000, { logs: [eventLog("params_updated", { old: DEFAULT_PARAMS, new: { ...DEFAULT_PARAMS, fees }, changed: ["fees"], effective_epoch: 43 })] })]);
      expect(JSON.parse((one("SELECT new_value FROM params WHERE field = 'fees' AND old_value IS NOT NULL") as { new_value: string }).new_value)).toEqual(fees);
    });
  });
});
