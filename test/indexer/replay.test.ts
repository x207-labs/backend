import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../src/db/index.js";
import { IndexerHaltError } from "../../src/indexer/errors.js";
import { Indexer, type IndexerOptions } from "../../src/indexer/indexer.js";
import { rebuildReadModel } from "../../src/indexer/rebuild.js";
import type { HandlerMap } from "../../src/indexer/handlers/index.js";
import {
  acct, appliedLog, ArrayBlockSource, block, committedLog, cutoffLog, DEFAULT_PARAMS, eventLog, fxLog42, claimFailedLog,
  claimedLog, paidLog, voucherLog, CONTRACT,
} from "../helpers/fx-log42.js";

const CIRCLE = "agents-main";
const TABLES = ["events_raw", "members", "member_limits", "epochs", "obligations", "clearing_log", "settlements", "params"];

describe("BE-006 replay dan rebuild", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });
  afterEach(() => db.close());

  function indexer(source: ArrayBlockSource, extra: Partial<IndexerOptions> = {}): Indexer {
    return new Indexer({ db, source, circleId: CIRCLE, contractId: CONTRACT, startBlock: 1000, ...extra });
  }
  const count = (table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const cursor = (): Record<string, number | string> => db.prepare("SELECT * FROM indexer_cursor").get() as Record<string, number | string>;
  const snapshot = (): Record<string, unknown[]> =>
    Object.fromEntries(TABLES.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2, 3`).safeIntegers(true).all()]));

  async function run(source: ArrayBlockSource, extra: Partial<IndexerOptions> = {}): Promise<Indexer> {
    const ix = indexer(source, extra);
    await ix.bootstrap();
    await ix.drain();
    return ix;
  }

  it("TC-BE-006-05 idempotensi per (receipt_id, log_index)", async () => {
    const source = new ArrayBlockSource(fxLog42());
    await run(source);
    const before = snapshot();
    db.prepare("UPDATE indexer_cursor SET last_block_height = 999").run();
    await indexer(source).drain();
    expect(snapshot()).toEqual(before);
    expect(db.prepare("SELECT settled_history FROM members WHERE account_id = ?").safeIntegers(true).get(acct("cleaner"))).toEqual({ settled_history: 10_000_000n });
  });

  it("TC-BE-006-14 putar ulang dari cursor lama menghasilkan read model identik", async () => {
    const source = new ArrayBlockSource(fxLog42());
    await run(source);
    const before = snapshot();
    db.prepare("UPDATE indexer_cursor SET last_block_height = 1005").run();
    await indexer(source).drain();
    expect(snapshot()).toEqual(before);
  });

  it("TC-BE-006-15 clearing_applied berpotongan", async () => {
    const setup = fxLog42().slice(0, 7);
    const chunk0 = appliedLog([1, 2, 3, 4], { chunk: 0, chunks: 2 });
    const chunk1 = appliedLog([5, 6, 7], { chunk: 1, chunks: 2 });
    const source = new ArrayBlockSource([...setup, block(1007, { id: "ra", logs: [chunk0] }), block(1008, { id: "rb", logs: [chunk1] })]);
    await run(source);
    expect(db.prepare("SELECT cleared FROM obligations ORDER BY creditor, debtor").safeIntegers(true).all().map((r) => Number((r as { cleared: bigint }).cleared)).sort((a, b) => a - b)).toEqual([
      5_000_000, 15_000_000, 15_000_000, 20_000_000, 30_000_000, 30_000_000, 30_000_000,
    ]);
    expect(db.prepare("SELECT edge_count FROM clearing_log").get()).toEqual({ edge_count: 7 });
    const before = snapshot();
    db.prepare("UPDATE indexer_cursor SET last_block_height = 1007").run();
    await indexer(source).drain();
    expect(snapshot()).toEqual(before);
  });

  it("TC-BE-006-17 epoch_cutoff tidak cocok: handled 0, henti, fase tetap open", async () => {
    const blocks = [...fxLog42().slice(0, 3), block(1003, { logs: [cutoffLog({ edge_count: 8 })] })];
    const ix = indexer(new ArrayBlockSource(blocks));
    await ix.bootstrap();
    await expect(ix.drain()).rejects.toThrow(/epoch_cutoff/);
    expect(db.prepare("SELECT event, handled FROM events_raw WHERE block_height = 1003").all()).toEqual([{ event: "epoch_cutoff", handled: 0 }]);
    expect(db.prepare("SELECT phase FROM epochs WHERE epoch = 42").get()).toEqual({ phase: "open" });
    expect(cursor().last_block_height).toBe(1002);
  });

  it("TC-BE-006-18 rebuild penuh tanpa RPC", async () => {
    const source = new ArrayBlockSource(fxLog42());
    await run(source, { fetchParams: () => Promise.resolve(DEFAULT_PARAMS as never) });
    const before = snapshot();
    const calls = source.requested.length + source.headCalls;
    const replayed = rebuildReadModel(db, CIRCLE);
    expect(replayed).toBe(count("events_raw"));
    expect(snapshot()).toEqual(before);
    expect(source.requested.length + source.headCalls).toBe(calls);
  });
});
