import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/index.js";
import { Indexer } from "../../src/indexer/indexer.js";
import { RpcBlockSource, type ChainBlock, type ChainOutcome, type ChainReader, type ChainTx } from "../../src/indexer/rpc-source.js";
import { CONTRACT, eventLog, joinLog, acct } from "../helpers/fx-log42.js";

const USDT = "usdt.tether-token.near";

/** Rantai tiruan: blok 100..105; blok 103 dilewati. */
class FakeChain implements ChainReader {
  endpoint = "fake://sandbox";
  readonly txCalls: string[] = [];
  readonly blocks = new Map<number, ChainBlock>();
  readonly chunkTxs = new Map<string, ChainTx[]>();
  readonly outcomes = new Map<string, ChainOutcome[]>();
  constructor(readonly head: number) {
    for (const h of [100, 101, 102, 104, 105]) this.blocks.set(h, { height: h, hash: `h${h}`, timestampNs: BigInt(h) * 1_000_000_000n, newChunkHashes: [`c${h}`] });
  }
  finalHeight = () => Promise.resolve(this.head);
  block = (height: number) => Promise.resolve(this.blocks.get(height) ?? null);
  heightOfBlock = (hash: string) => Promise.resolve(Number(hash.slice(1)));
  chunkTransactions = (chunk: string) => Promise.resolve(this.chunkTxs.get(chunk) ?? []);
  txOutcomes = (tx: ChainTx) => {
    this.txCalls.push(tx.hash);
    return Promise.resolve(this.outcomes.get(tx.hash) ?? []);
  };
}

describe("ADR-34 RpcBlockSource", () => {
  function chain(): FakeChain {
    const c = new FakeChain(105);
    // Transaksi ke USDT (ft_transfer_call) di blok 100: receipt kontrak dieksekusi di blok 102 (dua log).
    c.chunkTxs.set("c100", [{ hash: "tx-a", signerId: acct("translator") }]);
    c.outcomes.set("tx-a", [
      { receiptId: "ra0", executorId: USDT, logs: ["Transfer"], blockHash: "h101" },
      { receiptId: "ra1", executorId: CONTRACT, logs: [joinLog("translator"), "plain"], blockHash: "h102" },
      { receiptId: "ra2", executorId: USDT, logs: [], blockHash: "h104" },
    ]);
    // Transaksi langsung ke kontrak di blok 102, dieksekusi di blok 104 (blok 103 dilewati chain).
    c.chunkTxs.set("c102", [{ hash: "tx-b", signerId: acct("gpu") }]);
    c.outcomes.set("tx-b", [{ receiptId: "rb1", executorId: CONTRACT, logs: [eventLog("member_admitted", { account_id: acct("translator"), status: "pending" })], blockHash: "h104" }]);
    return c;
  }

  it("outcome diatribusikan ke blok eksekusinya, bukan blok transaksi; filter executor kontrak", async () => {
    const src = new RpcBlockSource(chain(), CONTRACT, 100);
    const heights: Record<number, string[]> = {};
    for (const h of [100, 101, 102, 103, 104, 105]) {
      const b = await src.getBlock(h);
      heights[h] = b ? b.logs.map((l) => `${l.receiptId}#${l.logIndex}`) : ["skipped"];
    }
    expect(heights).toEqual({ 100: [], 101: [], 102: ["ra1#0", "ra1#1"], 103: ["skipped"], 104: ["rb1#0"], 105: [] });
  });

  it("txHash, header blok, dan log_index = posisi di daftar log outcome", async () => {
    const src = new RpcBlockSource(chain(), CONTRACT, 100);
    for (const h of [100, 101]) await src.getBlock(h);
    const block = await src.getBlock(102);
    expect(block).toMatchObject({ height: 102, hash: "h102", timestampNs: 102_000_000_000n });
    expect(block?.logs[1]).toMatchObject({ receiptId: "ra1", logIndex: 1, txHash: "tx-a", log: "plain" });
  });

  it("tiap transaksi hanya ditelusuri sekali", async () => {
    const c = chain();
    const src = new RpcBlockSource(c, CONTRACT, 100);
    for (const h of [100, 101, 102, 103, 104, 105]) await src.getBlock(h);
    expect(c.txCalls).toEqual(["tx-a", "tx-b"]);
  });

  it("lompat langsung ke blok jauh memindai semua blok sebelumnya", async () => {
    const src = new RpcBlockSource(chain(), CONTRACT, 100);
    const block = await src.getBlock(104);
    expect(block?.logs.map((l) => l.receiptId)).toEqual(["rb1"]);
  });

  it("indexer penuh di atas RpcBlockSource: event masuk D9 dengan blok eksekusi", async () => {
    const db = openDatabase(":memory:");
    const ix = new Indexer({ db, source: new RpcBlockSource(chain(), CONTRACT, 100), circleId: "agents-main", contractId: CONTRACT, startBlock: 100 });
    await ix.bootstrap();
    await ix.drain();
    expect(db.prepare("SELECT event, block_height, tx_hash FROM events_raw ORDER BY block_height").all()).toEqual([
      { event: "member_joined", block_height: 102, tx_hash: "tx-a" },
      { event: "member_admitted", block_height: 104, tx_hash: "tx-b" },
    ]);
    expect(db.prepare("SELECT account_id, admitted FROM members").all()).toEqual([{ account_id: acct("translator"), admitted: 1 }]);
    db.close();
  });
});
