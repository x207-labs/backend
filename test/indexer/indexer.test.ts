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

describe("BE-006 inti indexer", () => {
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

  it("TC-BE-006-01 hanya log dari executor kontrak", async () => {
    const b = block(1000, { logs: [eventLog("member_joined", { account_id: acct("translator"), pubkey_voucher: "k", terms_hash: "t", status: "pending", joined_at: "1" })] });
    b.logs.push({ receiptId: "other", logIndex: 0, executorId: "intents.near", txHash: null, log: b.logs[0]!.log.replace("translator", "intruder") });
    await run(new ArrayBlockSource([b]));
    expect(db.prepare("SELECT receipt_id FROM events_raw").all()).toEqual([{ receipt_id: b.logs[0]!.receiptId }]);
  });

  it("TC-BE-006-02 log bukan EVENT_JSON diabaikan", async () => {
    const b = block(1000, { logs: ["Transfer 5 to x", `EVENT_JSON:${JSON.stringify({ standard: "nep141", version: "1.0.0", event: "ft_mint", data: [] })}`] });
    await run(new ArrayBlockSource([b]));
    expect(count("events_raw")).toBe(0);
    expect(cursor().last_block_height).toBe(1000);
  });

  it("TC-BE-006-03 parse NEP-297 ke events_raw", async () => {
    await run(new ArrayBlockSource(fxLog42()));
    const row = db.prepare("SELECT * FROM events_raw WHERE event = 'voucher_registered' ORDER BY receipt_id LIMIT 1").get() as Record<string, unknown>;
    expect(row).toMatchObject({ standard: "x207", version: "0.0.1", event: "voucher_registered", block_height: 1002, block_hash: "hash-1002", handled: 1, contract_id: CONTRACT });
    expect(row.block_timestamp_ns).toBe(1002_000_000_000);
    expect(JSON.parse(row.data_json as string)).toEqual([JSON.parse(voucherLog(0).slice("EVENT_JSON:".length)).data[0]]);
  });

  it("TC-BE-006-04 satu receipt beberapa log, diproses berurutan", async () => {
    const setup = fxLog42().slice(0, 8);
    const b = block(1008, { id: "rz", logs: [claimedLog("30000000"), claimFailedLog("15000000")] });
    // Posisi gpu harus claimable dulu: commit tanpa claim, lalu satu receipt berisi klaim sebagian.
    await run(new ArrayBlockSource([...setup, b]));
    expect(db.prepare("SELECT log_index, event FROM events_raw WHERE receipt_id = 'rz' ORDER BY log_index").all()).toEqual([
      { log_index: 0, event: "residual_claimed" },
      { log_index: 1, event: "residual_claim_failed" },
    ]);
  });

  it("TC-BE-006-06 handler tidak diulang untuk baris lama", async () => {
    const spy = vi.fn();
    const handlers: HandlerMap = { residual_paid: spy };
    const blocks = fxLog42().slice(0, 9);
    const source = new ArrayBlockSource(blocks);
    await run(source, { handlers });
    expect(spy).toHaveBeenCalledTimes(1);
    db.prepare("UPDATE indexer_cursor SET last_block_height = 1007").run();
    await indexer(source, { handlers }).drain();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("TC-BE-006-07 event tak dikenal: handled 2, cursor maju, read model tetap", async () => {
    const b = block(1000, { logs: [eventLog("foo_bar", { x: 1 })] });
    await run(new ArrayBlockSource([b]));
    expect(db.prepare("SELECT event, handled FROM events_raw").all()).toEqual([{ event: "foo_bar", handled: 2 }]);
    expect(count("members") + count("epochs") + count("obligations")).toBe(0);
    expect(cursor().last_block_height).toBe(1000);
  });

  it("TC-BE-006-08 atomisitas per blok", async () => {
    const source = new ArrayBlockSource(fxLog42().slice(0, 9));
    const handlers: HandlerMap = { epoch_committed: () => { throw new Error("boom"); } };
    const ix = indexer(source, { handlers });
    await ix.bootstrap();
    await expect(ix.drain()).rejects.toThrow("boom");
    expect(db.prepare("SELECT COUNT(*) AS n FROM events_raw WHERE block_height = 1007").get()).toEqual({ n: 0 });
    expect(count("settlements")).toBe(0);
    expect(cursor().last_block_height).toBe(1006);
  });

  it("TC-BE-006-09 bootstrap cursor dan params awal", async () => {
    const source = new ArrayBlockSource([], 1000);
    const ix = indexer(source, { fetchParams: () => Promise.resolve(DEFAULT_PARAMS as never) });
    await ix.bootstrap();
    await ix.step();
    expect(source.requested).toEqual([1000]);
    expect(cursor()).toMatchObject({ start_block_height: 1000, contract_id: CONTRACT });
    const rows = db.prepare("SELECT field, old_value, new_value, receipt_id FROM params ORDER BY id").all() as Record<string, string | null>[];
    expect(rows).toHaveLength(9);
    expect(rows.every((r) => r.old_value === null && r.receipt_id === "init:1000")).toBe(true);
    expect(rows.find((r) => r.field === "payment_window")?.new_value).toBe("1800");
    expect(rows.find((r) => r.field === "fees")?.new_value).toBe('{"clearing_fee_bps":0,"solver_fee_bps":0}');
  });

  it("TC-BE-006-10 lanjut setelah restart tanpa membaca blok dua kali", async () => {
    const blocks = fxLog42();
    const first = new ArrayBlockSource(blocks, 1003);
    await run(first);
    expect(cursor().last_block_height).toBe(1003);
    const second = new ArrayBlockSource(blocks, 1005);
    const ix = indexer(second);
    await ix.bootstrap();
    await ix.drain();
    expect(second.requested).toEqual([1004, 1005]);
  });

  it("TC-BE-006-11 blok tanpa event", async () => {
    await run(new ArrayBlockSource([block(1000)], 1000));
    expect(cursor()).toMatchObject({ last_block_height: 1000, last_block_hash: "hash-1000" });
    expect(count("events_raw")).toBe(0);
  });

  it("blok yang dilewati chain memajukan cursor tanpa mengubah hash", async () => {
    await run(new ArrayBlockSource([block(1000), block(1002)], 1002));
    expect(cursor()).toMatchObject({ last_block_height: 1002, last_block_hash: "hash-1002" });
  });

  it("TC-BE-006-12 lag", async () => {
    const source = new ArrayBlockSource([], 1150);
    const ix = indexer(source);
    await ix.bootstrap();
    db.prepare("UPDATE indexer_cursor SET last_block_height = 1050").run();
    await ix.step();
    expect(cursor()).toMatchObject({ last_block_height: 1051, head_block_height: 1150, lag_blocks: 99 });
  });

  it("TC-BE-006-13 head lebih rendah: cursor tidak mundur", async () => {
    const source = new ArrayBlockSource([], 1010);
    const ix = indexer(source);
    await ix.bootstrap();
    db.prepare("UPDATE indexer_cursor SET last_block_height = 1050").run();
    expect(await ix.step()).toEqual({ kind: "idle" });
    expect(cursor()).toMatchObject({ last_block_height: 1050, lag_blocks: 0 });
  });

  it("TC-BE-006-16 overflow u128: henti, rollback, cursor tidak maju", async () => {
    const source = new ArrayBlockSource([block(1000, { logs: [voucherLog(0, { cumulative_amount: (2n ** 63n).toString() })] })]);
    const ix = indexer(source);
    await ix.bootstrap();
    await expect(ix.step()).rejects.toBeInstanceOf(IndexerHaltError);
    expect(count("events_raw")).toBe(0);
    expect(cursor().last_block_height).toBe(999);
  });

  it("TC-BE-006-19 event P1 hanya disimpan", async () => {
    const b = block(1000, { logs: [eventLog("solver_fee_claimed", { solver: "solver-b", amount: "5" })] });
    await run(new ArrayBlockSource([b]));
    expect(db.prepare("SELECT event, handled FROM events_raw").all()).toEqual([{ event: "solver_fee_claimed", handled: 1 }]);
    expect(count("members") + count("obligations")).toBe(0);
  });

  it("run mencoba lagi dengan backoff saat sumber gagal, cursor tidak maju", async () => {
    const source = new ArrayBlockSource([block(1000)], 1000);
    let failures = 2;
    const original = source.getBlock.bind(source);
    source.getBlock = (h) => (failures-- > 0 ? Promise.reject(new Error("rpc down")) : original(h));
    const ix = indexer(source);
    await ix.bootstrap();
    const ctrl = new AbortController();
    const errors: unknown[] = [];
    const done = ix.run({ signal: ctrl.signal, pollMs: 5, maxBackoffMs: 10, onError: (e) => errors.push(e) });
    await vi.waitFor(() => expect(cursor().last_block_height).toBe(1000));
    ctrl.abort();
    await done;
    expect(errors).toHaveLength(2);
  });
});

describe("BE-006 ketergantungan fixture", () => {
  it("paidLog dan committedLog tersedia", () => {
    expect(paidLog()).toContain("residual_paid");
    expect(committedLog()).toContain("epoch_committed");
  });
});
