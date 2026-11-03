import { existsSync, readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/index.js";
import { edgesHash as sdkEdgesHash, positionsHash as sdkPositionsHash } from "@x207/core";
import type { ClearedEdge } from "../../src/indexer/clearing-hashes.js";
import { prefetchClearingEdges, storedClearingEdges } from "../../src/indexer/clearing-edges.js";
import { epochHandlers } from "../../src/indexer/handlers/epochs.js";
import type { HandlerContext } from "../../src/indexer/handlers/index.js";
import { IndexerHaltError } from "../../src/indexer/errors.js";
import { Indexer } from "../../src/indexer/indexer.js";
import { rebuildReadModel } from "../../src/indexer/rebuild.js";
import { edgesHash, positionsHash } from "../helpers/clearing-hashes.js";
import { acct, ArrayBlockSource, block, CONTRACT, eventLog, fxLog42, nsOf, positions } from "../helpers/fx-log42.js";

// BE-077: interface 0.0.13. `clearing_applied` is a summary (edge_count, edges_hash) and the edges come from the view list_obligations; `epoch_committed` has all positions
// and positions_hash. The hash functions are the SDK ones (SDK-080); here a stand-in with the same shape: sha256 of the canonical JSON, edges with cleared > 0 sorted by (debtor, creditor).
const stub = { edgesHash: sdkEdgesHash, positionsHash: sdkPositionsHash as (list: unknown[]) => string };

const CIRCLE = "agents-main";
const EDGES: ClearedEdge[] = [
  { debtor: acct("translator"), creditor: acct("summarizer"), cleared: "30000000" },
  { debtor: acct("summarizer"), creditor: acct("image"), cleared: "30000000" },
  { debtor: acct("image"), creditor: acct("translator"), cleared: "30000000" },
  { debtor: acct("scraper"), creditor: acct("gpu"), cleared: "15000000" },
  { debtor: acct("gpu"), creditor: acct("cleaner"), cleared: "20000000" },
  { debtor: acct("cleaner"), creditor: acct("scraper"), cleared: "15000000" },
  { debtor: acct("cleaner"), creditor: acct("gpu"), cleared: "5000000" },
];
const summary = (over: Record<string, unknown> = {}) => ({
  epoch: 42, solver: "solver-b", cleared_total: "145000000", edge_count: 7, edges_hash: stub.edgesHash(EDGES), clearing_fee: "0", solver_fee: "0", ...over,
});
const committed = (over: Record<string, unknown> = {}) => {
  const list = positions() as never as Array<{ account_id: string }>;
  return {
    epoch: 42, committed_at: nsOf("2026-11-09T11:30:00Z"), payment_deadline: nsOf("2026-11-09T12:00:00Z"), total_due: "45000000", total_claimable: "45000000",
    position_count: list.length, positions_hash: stub.positionsHash(list), positions: list, ...over,
  };
};
const noSleep = { attempts: 3, delayMs: 0, sleep: async () => undefined };

describe("BE-077 clearing_applied and epoch_committed of interface 0.0.13", () => {
  let db: Database.Database;
  const ctxAt = (height: number): HandlerContext => ({ db, circleId: CIRCLE, receiptId: `r-${height}`, logIndex: 0, txHash: `tx-${height}`, block: { height, hash: `hash-${height}`, timestampNs: BigInt(height) * 1_000_000_000n } });
  const one = <T>(sql: string, ...args: unknown[]): T => db.prepare(sql).safeIntegers(true).get(...args) as T;
  const appliedBlock = (s = summary()) => block(1005, { logs: [eventLog("clearing_applied", s)] });

  beforeEach(async () => {
    db = openDatabase(":memory:");
    // up to the cutoff of epoch 42: the seven edges are in `obligations` with `cleared` empty (these events are in the form the parser knows)
    const ix = new Indexer({ db, source: new ArrayBlockSource(fxLog42().slice(0, 5)), circleId: CIRCLE, contractId: CONTRACT, startBlock: 1000 });
    await ix.bootstrap();
    await ix.drain();
  });
  afterEach(() => {
    db.close();
  });

  it("TC-BE-077-01 the edges read from list_obligations are checked against edges_hash, kept, and applied: cleared per edge, clearing_log, epochs.cleared_total", async () => {
    // the view also lists an edge that was not cleared: it is not part of the hash
    const withZero = [...EDGES, { debtor: acct("gpu"), creditor: acct("scraper"), cleared: "0" }];
    await prefetchClearingEdges(db, CIRCLE, CONTRACT, appliedBlock(), async () => withZero, noSleep);
    expect(storedClearingEdges(db, CIRCLE, 42)?.edges).toHaveLength(7);
    epochHandlers.clearing_applied!(ctxAt(1005), summary() as never);
    expect(db.prepare("SELECT cleared FROM obligations").safeIntegers(true).all().map((r) => Number((r as { cleared: bigint }).cleared)).sort((a, b) => a - b)).toEqual([
      5_000_000, 15_000_000, 15_000_000, 20_000_000, 30_000_000, 30_000_000, 30_000_000,
    ]);
    expect(one("SELECT solver, cleared_total, fee, edge_count FROM clearing_log WHERE epoch = 42")).toEqual({ solver: "solver-b", cleared_total: 145_000_000n, fee: 0n, edge_count: 7n });
    expect(one("SELECT cleared_total FROM epochs WHERE epoch = 42")).toEqual({ cleared_total: 145_000_000n });
  });

  it("TC-BE-077-02 a failing view is tried again (3 times) and then goes up as a source error that does not move the cursor; a set already kept is not read again", async () => {
    let calls = 0;
    const flaky = async (): Promise<ClearedEdge[]> => (++calls < 3 ? Promise.reject(new Error("rpc down")) : EDGES);
    await prefetchClearingEdges(db, CIRCLE, CONTRACT, appliedBlock(), flaky, noSleep);
    expect([calls, storedClearingEdges(db, CIRCLE, 42)?.edges.length]).toEqual([3, 7]);
    await prefetchClearingEdges(db, CIRCLE, CONTRACT, appliedBlock(), async () => Promise.reject(new Error("must not be called")), noSleep);

    db.prepare("DELETE FROM clearing_edges").run();
    let tries = 0;
    const dead = prefetchClearingEdges(db, CIRCLE, CONTRACT, appliedBlock(), async () => (tries++, Promise.reject(new Error("rpc down"))), noSleep);
    await expect(dead).rejects.toThrow(/failed 3 times: rpc down/);
    await expect(dead).rejects.not.toBeInstanceOf(IndexerHaltError);
    expect(tries).toBe(3);
  });

  it("TC-BE-077-03 the indexer halts when the edges are not the ones of the event, when there is no way to read them, or when the handler finds no set", async () => {
    const tampered = EDGES.map((e, i) => (i === 0 ? { ...e, cleared: "29000000" } : e));
    await expect(prefetchClearingEdges(db, CIRCLE, CONTRACT, appliedBlock(), async () => tampered, noSleep)).rejects.toBeInstanceOf(IndexerHaltError);
    await expect(prefetchClearingEdges(db, CIRCLE, CONTRACT, appliedBlock(), async () => EDGES.slice(1), noSleep)).rejects.toBeInstanceOf(IndexerHaltError);
    await expect(prefetchClearingEdges(db, CIRCLE, CONTRACT, appliedBlock(), undefined, noSleep)).rejects.toThrow(/list_obligations/);
    expect(storedClearingEdges(db, CIRCLE, 42)).toBeUndefined();
    expect(() => epochHandlers.clearing_applied!(ctxAt(1005), summary() as never)).toThrow(IndexerHaltError);
    // a set that does not add up to cleared_total
    await prefetchClearingEdges(db, CIRCLE, CONTRACT, appliedBlock(), async () => EDGES, noSleep);
    expect(() => epochHandlers.clearing_applied!(ctxAt(1005), summary({ cleared_total: "146000000" }) as never)).toThrow(/add up/);
    expect(one("SELECT COUNT(*) AS n FROM clearing_log")).toEqual({ n: 0n });
  });

  it("TC-BE-077-04 the Indexer reads the edges before the block and halts on the hash; with no summary in the block the view is not called", async () => {
    const calls: number[] = [];
    const ix = new Indexer({
      db, source: new ArrayBlockSource([appliedBlock()]), circleId: CIRCLE, contractId: CONTRACT, startBlock: 1005,
      fetchClearedEdges: async (epoch) => (calls.push(epoch), EDGES), prefetch: noSleep,
    });
    await ix.bootstrap().catch(() => undefined);
    // the cursor of the fixture is at 1004: the block 1005 is the next one; the event is read by the parser of the SDK that this build has, so only the read before the block is looked at here
    await ix.step().catch(() => undefined);
    expect(calls).toEqual([42]);
    expect(storedClearingEdges(db, CIRCLE, 42)?.edgesHash).toBe(stub.edgesHash(EDGES));

    const quiet: number[] = [];
    const other = new Indexer({ db, source: new ArrayBlockSource([block(1006, { logs: [eventLog("epoch_finalized", { epoch: 41, finalized_at: nsOf("2026-11-09T10:00:00Z"), defaulted_count: 0, total_defaulted: "0", pool: "0", shortfall: "0" })] })]), circleId: CIRCLE, contractId: CONTRACT, startBlock: 1005, fetchClearedEdges: async (e) => (quiet.push(e), EDGES) });
    await other.step().catch(() => undefined);
    expect(quiet).toEqual([]);
  });

  it("TC-BE-077-05 epoch_committed: the positions of the event are checked against position_count and positions_hash, then written (phase, deadline, settlements, outstanding debt)", () => {
    epochHandlers.epoch_committed!(ctxAt(1007), committed() as never);
    expect(one("SELECT phase, committed_at_ns, payment_deadline_ns FROM epochs WHERE epoch = 42")).toMatchObject({ phase: "payment_window", payment_deadline_ns: BigInt(nsOf("2026-11-09T12:00:00Z")) });
    expect(db.prepare("SELECT COUNT(*) AS n FROM settlements WHERE epoch = 42").get()).toEqual({ n: 6 });
    expect(one("SELECT role, net, amount, status FROM settlements WHERE account_id = ?", acct("scraper"))).toEqual({ role: "debtor", net: -35_000_000n, amount: 35_000_000n, status: "due" });
    expect(one("SELECT outstanding_debt FROM members WHERE account_id = ?", acct("scraper"))).toEqual({ outstanding_debt: 35_000_000n });
    expect(one("SELECT total_due, total_claimable FROM epochs WHERE epoch = 42")).toEqual({ total_due: 45_000_000n, total_claimable: 45_000_000n });
  });

  it("TC-BE-077-06 epoch_committed with a wrong position_count or positions_hash halts and writes nothing", () => {
    expect(() => epochHandlers.epoch_committed!(ctxAt(1007), committed({ position_count: 7 }) as never)).toThrow(/position_count/);
    expect(() => epochHandlers.epoch_committed!(ctxAt(1007), committed({ positions_hash: "00" }) as never)).toThrow(/positions_hash/);
    // totals that are not the sums of the positions
    expect(() => epochHandlers.epoch_committed!(ctxAt(1007), committed({ total_due: "44000000" }) as never)).toThrow(/total_due/);
    expect(() => epochHandlers.epoch_committed!(ctxAt(1007), committed({ total_claimable: "1" }) as never)).toThrow(/total_claimable/);
    const bent = (positions() as never as Array<Record<string, unknown>>).map((p, i) => (i === 0 ? { ...p, amount: "1" } : p));
    expect(() => epochHandlers.epoch_committed!(ctxAt(1007), committed({ positions: bent }) as never)).toThrow(IndexerHaltError);
    expect(db.prepare("SELECT COUNT(*) AS n FROM settlements").get()).toEqual({ n: 0 });
  });

  it("TC-BE-077-07 a rebuild keeps the edges that were read and does not need an RPC; a summary replayed from them gives the same read model", async () => {
    await prefetchClearingEdges(db, CIRCLE, CONTRACT, appliedBlock(), async () => EDGES, noSleep);
    epochHandlers.clearing_applied!(ctxAt(1005), summary() as never);
    const before = db.prepare("SELECT debtor, creditor, cleared FROM obligations ORDER BY debtor, creditor").all();
    rebuildReadModel(db, CIRCLE);
    expect(storedClearingEdges(db, CIRCLE, 42)?.edges).toHaveLength(7);
    // after the rebuild the obligations are back from the events that the parser knows, `cleared` is empty until the summary is replayed from the kept set
    epochHandlers.clearing_applied!(ctxAt(1005), summary() as never);
    expect(db.prepare("SELECT debtor, creditor, cleared FROM obligations ORDER BY debtor, creditor").all()).toEqual(before);
  });

  it("TC-BE-077-09 through the Indexer and the SDK parser: the 0.0.13 events of scenario FX-LOG42 give the same read model as the 0.0.12 events (edges from list_obligations)", async () => {
    const legacy = fxLog42();
    const asSummary = (line: string): string => {
      const envelope = JSON.parse(line.slice("EVENT_JSON:".length)) as { version: string; event: string; data: Array<Record<string, unknown>> };
      if (envelope.event !== "clearing_applied" && envelope.event !== "epoch_committed") return line;
      const d = envelope.data[0] as Record<string, unknown> & { edges?: ClearedEdge[]; positions?: Array<{ account_id: string }> };
      const { chunk: _c, chunks: _cs, edges, positions: list, ...rest } = d;
      envelope.version = "0.0.13";
      envelope.data = [envelope.event === "clearing_applied"
        ? { ...rest, edge_count: edges!.length, edges_hash: sdkEdgesHash(edges!) }
        : { ...rest, position_count: list!.length, positions_hash: sdkPositionsHash(list as never), positions: list }];
      return `EVENT_JSON:${JSON.stringify(envelope)}`;
    };
    const summarised = legacy.map((b) => ({ ...b, logs: b.logs.map((l) => ({ ...l, log: asSummary(l.log) })) }));
    expect(summarised.flatMap((b) => b.logs).filter((l) => l.log.includes("edges_hash") || l.log.includes("positions_hash"))).toHaveLength(2);

    const run = async (blocks: SourceBlock[], fetchClearedEdges?: (epoch: number) => Promise<ClearedEdge[]>): Promise<Database.Database> => {
      const target = openDatabase(":memory:");
      const ix = new Indexer({ db: target, source: new ArrayBlockSource(blocks), circleId: CIRCLE, contractId: CONTRACT, startBlock: 1000, ...(fetchClearedEdges ? { fetchClearedEdges } : {}), prefetch: noSleep });
      await ix.bootstrap();
      await ix.drain();
      return target;
    };
    const views: number[] = [];
    const a = await run(legacy);
    const b = await run(summarised, async (epoch) => (views.push(epoch), EDGES));
    try {
      expect(views).toEqual([42]);
      for (const table of ["obligations", "clearing_log", "settlements", "members", "member_limits"]) {
        expect([table, b.prepare(`SELECT * FROM ${table} ORDER BY 1, 2, 3, 4`).all()]).toEqual([table, a.prepare(`SELECT * FROM ${table} ORDER BY 1, 2, 3, 4`).all()]);
      }
      const cols = "circle_id, epoch, phase, cutoff_at_ns, closed_at_ns, proposal_deadline_ns, committed_at_ns, payment_deadline_ns, finalized_at_ns, edge_count, total_obligation, cleared_total";
      expect(b.prepare(`SELECT ${cols} FROM epochs ORDER BY epoch`).all()).toEqual(a.prepare(`SELECT ${cols} FROM epochs ORDER BY epoch`).all());
      expect(b.prepare("SELECT total_due, total_claimable FROM epochs WHERE epoch = 42").get()).toEqual({ total_due: 45_000_000, total_claimable: 45_000_000 });
      // a rebuild from events_raw and the kept edges needs no RPC and changes nothing
      const before = b.prepare("SELECT debtor, creditor, cleared FROM obligations ORDER BY debtor, creditor").all();
      rebuildReadModel(b, CIRCLE);
      expect(b.prepare("SELECT debtor, creditor, cleared FROM obligations ORDER BY debtor, creditor").all()).toEqual(before);
      expect(b.prepare("SELECT COUNT(*) AS n FROM settlements").get()).toEqual(a.prepare("SELECT COUNT(*) AS n FROM settlements").get());
    } finally {
      a.close();
      b.close();
    }
  });
});

// the golden vector of A2 (CT-099): the stand-in of the tests gives the bytes and the hashes of the contract
const VECTOR = new URL("../../../contracts/tests/vectors/clearing_hashes.json", import.meta.url).pathname;
describe.skipIf(!existsSync(VECTOR))("BE-077 the SDK hashes and the copy of the tests are the ones of the golden vector", () => {
  const vector = (): { edges: Array<{ name: string; input: ClearedEdge[]; edges_hash: string }>; positions: Array<{ name: string; input: unknown[]; positions_hash: string }> } => JSON.parse(readFileSync(VECTOR, "utf8"));

  it("TC-BE-077-08 edges_hash and positions_hash of every case of the vector", () => {
    const v = vector();
    expect(v.edges.length).toBeGreaterThan(0);
    expect(v.positions.length).toBeGreaterThan(0);
    for (const c of v.edges) expect([c.name, edgesHash(c.input), sdkEdgesHash(c.input)]).toEqual([c.name, c.edges_hash, c.edges_hash]);
    for (const c of v.positions) expect([c.name, positionsHash(c.input), (sdkPositionsHash as (l: unknown[]) => string)(c.input)]).toEqual([c.name, c.positions_hash, c.positions_hash]);
  });
});
