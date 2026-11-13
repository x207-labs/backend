import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../../src/db/index.js";
import { Indexer } from "../../src/indexer/indexer.js";
import { ArrayBlockSource, CONTRACT, DEFAULT_PARAMS, acct, block, eventLog } from "../helpers/fx-log42.js";
import { coreTooOld } from "../helpers/installed-core.js";

// the events `relayer_fee_*` of 0.0.17 are known only to a core of that interface or later
const OLD_CORE = coreTooOld("0.0.17");

// BE-103: contracts 0.0.16 and 0.0.17 add the DAO parameter `relayer_fee` and the events `relayer_fee_paid` / `relayer_fee_failed`.
const V16 = { ...DEFAULT_PARAMS, max_search_share_bps: 500, bond_threshold: "100000000", bond_bps: 2000, prune_delay_epochs: 2, relayer_fee: "250000" };
const CIRCLE = "agents-main";

describe("BE-103 relayer_fee of interface 0.0.16 and 0.0.17 in the read model", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDatabase(":memory:");
  });
  afterEach(() => db.close());
  const make = (blocks: ReturnType<typeof block>[], params: unknown) =>
    new Indexer({ db, source: new ArrayBlockSource(blocks), circleId: CIRCLE, contractId: CONTRACT, startBlock: 1000, fetchParams: () => Promise.resolve(params as never) });
  const stored = (): Record<string, unknown> =>
    Object.fromEntries((db.prepare("SELECT field, new_value FROM params WHERE circle_id = ?").all(CIRCLE) as { field: string; new_value: string }[]).map((r) => [r.field, JSON.parse(r.new_value)]));

  it("TC-BE-103-01 a circle of 0.0.16 stores relayer_fee from get_params; a circle of 0.0.15 (no such field) stores none", async () => {
    await make([], V16).bootstrap();
    expect(stored().relayer_fee).toBe("250000");
    expect(Object.keys(stored())).toHaveLength(14);
    const { relayer_fee: _unused, ...v15 } = V16;
    void _unused;
    db.prepare("DELETE FROM params").run();
    await make([], v15).bootstrap();
    expect(stored().relayer_fee).toBeUndefined();
    expect(Object.keys(stored())).toHaveLength(13);
  });

  it("TC-BE-103-02 params_updated that changes relayer_fee is stored (it must not fail the CHECK and halt the indexer) and is the pending value of the next epoch", async () => {
    const changed = { ...V16, relayer_fee: "100000" };
    const log = eventLog("params_updated", { old: V16, new: changed, changed: ["relayer_fee"], effective_epoch: 5 });
    const ix = make([block(1000, { logs: [log] })], V16);
    await ix.bootstrap();
    await ix.drain();
    expect(db.prepare("SELECT field, old_value, new_value, effective_epoch FROM params WHERE effective_epoch = 5").all()).toEqual([
      { field: "relayer_fee", old_value: '"250000"', new_value: '"100000"', effective_epoch: 5 },
    ]);
    expect(db.prepare("SELECT handled FROM events_raw WHERE event = 'params_updated'").all()).toEqual([{ handled: 1 }]);
  });

  it.skipIf(OLD_CORE)(`TC-BE-103-03 relayer_fee_paid and relayer_fee_failed (claim_evm, withdraw_stake_evm; request_exit_evm, set_auto_settle_evm from 0.0.17) are stored in events_raw, handled${OLD_CORE ? ` (${OLD_CORE})` : ""}`, async () => {
    const fee = (event: string, action: string, amount: string) => eventLog(event, { account_id: acct("translator"), relayer: acct("scraper"), action, epoch: 7, amount }, "0.0.17");
    const logs = [
      fee("relayer_fee_paid", "claim", "250000"),
      fee("relayer_fee_paid", "request_exit", "250000"),
      fee("relayer_fee_paid", "auto_settle", "250000"),
      fee("relayer_fee_failed", "withdraw_stake", "250000"),
    ];
    const ix = make([block(1000, { logs })], V16);
    await ix.bootstrap();
    await ix.drain();
    const rows = db.prepare("SELECT event, handled, data_json FROM events_raw WHERE event LIKE 'relayer_fee_%' ORDER BY log_index").all() as { event: string; handled: number; data_json: string }[];
    expect(rows.map((r) => [r.event, r.handled])).toEqual([["relayer_fee_paid", 1], ["relayer_fee_paid", 1], ["relayer_fee_paid", 1], ["relayer_fee_failed", 1]]);
    expect(rows.map((r) => (JSON.parse(r.data_json) as { action: string }[])[0]!.action)).toEqual(["claim", "request_exit", "auto_settle", "withdraw_stake"]);
  });
});
