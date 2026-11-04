import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/index.js";
import { Indexer } from "../../src/indexer/indexer.js";
import { rebuildReadModel } from "../../src/indexer/rebuild.js";
import { NeardataBlockSource } from "../../src/indexer/neardata-source.js";
import type { SourceBlock } from "../../src/indexer/block-source.js";
import { ArrayBlockSource, CONTRACT, fxLog42 } from "../helpers/fx-log42.js";

// BE-091: `prune_epoch` emits nothing, so the indexer learns of a prune from the call: the source reports it, the indexer derives the event `epoch_pruned`, the read model marks the epoch.
const CIRCLE = "agents-main";
const call = (method: string, args: unknown) => ({ FunctionCall: { method_name: method, args: Buffer.from(JSON.stringify(args)).toString("base64") } });
const pruneBlock = (height: number, epoch = 42): SourceBlock => ({ height, hash: `hash-${height}`, timestampNs: BigInt(height) * 1_000_000_000n, logs: [], prunes: [{ receiptId: `prune-${height}`, txHash: `tx-${height}`, signerId: "aux.near", epoch }] });

describe("BE-091 a prune of an epoch reaches the read model", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDatabase(":memory:");
  });
  afterEach(() => db.close());
  const unavailable = (epoch: number): bigint => (db.prepare("SELECT edges_unavailable AS u FROM epochs WHERE epoch = ?").safeIntegers(true).get(epoch) as { u: bigint }).u;

  async function ingest(extra: SourceBlock[]): Promise<void> {
    const base = fxLog42();
    const ix = new Indexer({ db, source: new ArrayBlockSource([...base, ...extra.map((b, i) => ({ ...b, height: base.length + 1000 + i, hash: `hash-x${i}` }))]), circleId: CIRCLE, contractId: CONTRACT, startBlock: 1000 });
    await ix.bootstrap();
    await ix.drain();
  }

  it("TC-BE-091-01 a successful prune marks the epoch edges_unavailable and keeps what was indexed; the derived event is in events_raw, handled", async () => {
    await ingest([]);
    expect(unavailable(42)).toBe(0n);
    const edgesBefore = (db.prepare("SELECT COUNT(*) AS n FROM obligations WHERE epoch = 42").safeIntegers(true).get() as { n: bigint }).n;
    db.close();
    db = openDatabase(":memory:");
    await ingest([pruneBlock(0)]);
    expect(unavailable(42)).toBe(1n);
    expect((db.prepare("SELECT COUNT(*) AS n FROM obligations WHERE epoch = 42").safeIntegers(true).get() as { n: bigint }).n).toBe(edgesBefore);
    expect(db.prepare("SELECT event, handled, method_name, signer_id, tx_hash FROM events_raw WHERE event = 'epoch_pruned'").get()).toEqual({
      event: "epoch_pruned", handled: 1, method_name: "prune_epoch", signer_id: "aux.near", tx_hash: expect.stringMatching(/^tx-/),
    });
    expect(unavailable(43)).toBe(0n);
  });

  it("TC-BE-091-02 a prune of an epoch the read model does not have changes nothing, and a second prune of the same epoch is harmless", async () => {
    await ingest([pruneBlock(0, 99), pruneBlock(1), pruneBlock(2)]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM epochs WHERE epoch = 99").get()).toEqual({ n: 0 });
    expect(unavailable(42)).toBe(1n);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events_raw WHERE event = 'epoch_pruned'").get()).toEqual({ n: 3 });
  });

  it("TC-BE-091-03 a rebuild from events_raw gives the same flag (the derived event is stored like any other)", async () => {
    await ingest([pruneBlock(0)]);
    rebuildReadModel(db, CIRCLE);
    expect(unavailable(42)).toBe(1n);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events_raw WHERE handled = 0").get()).toEqual({ n: 0 });
  });
});

describe("BE-091 NeardataBlockSource reports only the prune_epoch calls of the circle that succeeded", () => {
  const outcome = (id: string, executor: string, actions: unknown[], status: unknown) => ({
    execution_outcome: { id, outcome: { executor_id: executor, logs: [], status } },
    receipt: { receipt: { Action: { signer_id: "aux.near", actions } } }, tx_hash: `tx-${id}`,
  });
  async function blockOf(outcomes: unknown[]) {
    const body = { block: { header: { height: 7, hash: "h7", timestamp_nanosec: "1" } }, shards: [{ receipt_execution_outcomes: outcomes }] };
    const src = new NeardataBlockSource({ baseUrl: "https://nd.test", contractId: CONTRACT, fetch: (async () => Response.json(body)) as unknown as typeof fetch });
    return src.getBlock(7);
  }

  it("TC-BE-091-04 the call that succeeded is reported with its epoch, signer and transaction", async () => {
    const block = await blockOf([outcome("r1", CONTRACT, [call("prune_epoch", { epoch: 7, max_items: 200 })], { SuccessValue: "Mw==" })]);
    expect(block?.prunes).toEqual([{ receiptId: "r1", txHash: "tx-r1", signerId: "aux.near", epoch: 7 }]);
  });

  it("TC-BE-091-05 not reported: a failed call, another method, another contract, arguments without an epoch, a block without a prune has no prunes key", async () => {
    const block = await blockOf([
      outcome("f", CONTRACT, [call("prune_epoch", { epoch: 7, max_items: 1 })], { Failure: { ActionError: {} } }),
      outcome("m", CONTRACT, [call("finalize_epoch", { epoch: 7 })], { SuccessValue: "" }),
      outcome("o", "other.near", [call("prune_epoch", { epoch: 7, max_items: 1 })], { SuccessValue: "" }),
      outcome("a", CONTRACT, [call("prune_epoch", { max_items: 1 })], { SuccessValue: "" }),
      outcome("z", CONTRACT, [call("prune_epoch", { epoch: 0, max_items: 1 })], { SuccessValue: "" }),
      outcome("g", CONTRACT, [{ FunctionCall: { method_name: "prune_epoch", args: "not base64 json" } }], { SuccessValue: "" }),
      outcome("n", CONTRACT, [call("prune_epoch", { epoch: 3 })], undefined),
    ]);
    expect(block).not.toBeNull();
    expect(block).not.toHaveProperty("prunes");
  });
});
