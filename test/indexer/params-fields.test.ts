import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../../src/db/index.js";
import { Indexer } from "../../src/indexer/indexer.js";
import { ArrayBlockSource, CONTRACT, DEFAULT_PARAMS, block, eventLog } from "../helpers/fx-log42.js";

// BE-092: `get_params` of the 0.0.13 contract has 13 fields; the read model keeps all of them, also in a database that was made when only 9 were listed.
const FULL = { ...DEFAULT_PARAMS, max_search_share_bps: 500, bond_threshold: "100000000", bond_bps: 2000, prune_delay_epochs: 2 };
const CIRCLE = "agents-main";

describe("BE-092 all fields of get_params are stored", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDatabase(":memory:");
  });
  afterEach(() => db.close());
  const make = (params: unknown) => new Indexer({ db, source: new ArrayBlockSource([]), circleId: CIRCLE, contractId: CONTRACT, startBlock: 1000, fetchParams: () => Promise.resolve(params as never) });
  const stored = (): Record<string, unknown> =>
    Object.fromEntries((db.prepare("SELECT field, new_value FROM params WHERE circle_id = ?").all(CIRCLE) as { field: string; new_value: string }[]).map((r) => [r.field, JSON.parse(r.new_value)]));

  it("TC-BE-092-01 a new database stores the 13 fields with the exact names of the contract", async () => {
    await make(FULL).bootstrap();
    expect(stored()).toEqual(FULL);
  });

  it("TC-BE-092-02 a database with the first 9 fields gets the 4 missing ones and keeps the others", async () => {
    await make(DEFAULT_PARAMS).bootstrap();
    expect(Object.keys(stored())).toHaveLength(9);
    db.prepare("UPDATE params SET new_value = '7200' WHERE field = 'epoch_length'").run();
    await make(FULL).bootstrap();
    expect(stored()).toEqual({ ...FULL, epoch_length: 7200 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM params WHERE field = 'bond_bps'").get()).toEqual({ n: 1 });
  });

  it("TC-BE-092-03 bootstrapping again changes nothing; a contract without the 4 fields stores only the 9", async () => {
    await make(FULL).bootstrap();
    await make(FULL).bootstrap();
    expect(db.prepare("SELECT COUNT(*) AS n FROM params").get()).toEqual({ n: 13 });
    const other = openDatabase(":memory:");
    try {
      await new Indexer({ db: other, source: new ArrayBlockSource([]), circleId: CIRCLE, contractId: CONTRACT, startBlock: 1000, fetchParams: () => Promise.resolve(DEFAULT_PARAMS as never) }).bootstrap();
      expect(other.prepare("SELECT COUNT(*) AS n FROM params").get()).toEqual({ n: 9 });
    } finally {
      other.close();
    }
  });

  it("TC-BE-092-04 a params_updated that changes a new field is stored and shows as the pending value of the next epoch", async () => {
    const changed = { ...FULL, bond_bps: 2500, prune_delay_epochs: 3 };
    const log = eventLog("params_updated", { old: FULL, new: changed, changed: ["bond_bps", "prune_delay_epochs"], effective_epoch: 5 });
    const ix = new Indexer({ db, source: new ArrayBlockSource([block(1000, { logs: [log] })]), circleId: CIRCLE, contractId: CONTRACT, startBlock: 1000, fetchParams: () => Promise.resolve(FULL as never) });
    await ix.bootstrap();
    await ix.drain();
    const rows = db.prepare("SELECT field, old_value, new_value, effective_epoch FROM params WHERE effective_epoch = 5 ORDER BY field").all();
    expect(rows).toEqual([
      { field: "bond_bps", old_value: "2000", new_value: "2500", effective_epoch: 5 },
      { field: "prune_delay_epochs", old_value: "2", new_value: "3", effective_epoch: 5 },
    ]);
  });
});
