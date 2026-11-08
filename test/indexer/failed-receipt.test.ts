import { describe, expect, it } from "vitest";
import { NeardataBlockSource } from "../../src/indexer/neardata-source.js";
import { RpcBlockSource, type ChainOutcome, type ChainReader } from "../../src/indexer/rpc-source.js";
import { CONTRACT } from "../helpers/fx-log42.js";

// BE-107 (A-BE-01): the logs of a FAILED receipt are not events: its state change was rolled back, so the read model must not apply them.
const LOG = 'EVENT_JSON:{"standard":"x207","version":"1.0.0","event":"member_admitted","data":[{"account_id":"a.near","status":"active"}]}';
const outcome = (id: string, status: unknown) => ({
  execution_outcome: { id, outcome: { executor_id: CONTRACT, logs: [LOG], status } },
  receipt: { receipt: { Action: { signer_id: "aux.near", actions: [{ FunctionCall: { method_name: "ft_resolve", args: "" } }] } } }, tx_hash: `tx-${id}`,
});

describe("BE-107 neardata source skips the logs of failed receipts", () => {
  async function ids(outcomes: unknown[]): Promise<string[]> {
    const body = { block: { header: { height: 7, hash: "h7", timestamp_nanosec: "1" } }, shards: [{ receipt_execution_outcomes: outcomes }] };
    const src = new NeardataBlockSource({ baseUrl: "https://nd.test", contractId: CONTRACT, fetch: (async () => Response.json(body)) as unknown as typeof fetch });
    return ((await src.getBlock(7))?.logs ?? []).map((l) => l.receiptId);
  }

  it("TC-BE-107-01 Failure is skipped; SuccessValue, SuccessReceiptId and a missing status are kept", async () => {
    expect(
      await ids([
        outcome("fail", { Failure: { ActionError: { kind: "x" } } }),
        outcome("ok1", { SuccessValue: "" }),
        outcome("ok2", { SuccessReceiptId: "next" }),
        outcome("none", undefined),
      ]),
    ).toEqual(["ok1", "ok2", "none"]);
  });
});

describe("BE-107 rpc source skips the logs of failed receipts", () => {
  it("TC-BE-107-02 an outcome marked failed is not collected", async () => {
    const outcomes: ChainOutcome[] = [
      { receiptId: "bad", executorId: CONTRACT, logs: [LOG], failed: true, blockHash: "h101" },
      { receiptId: "good", executorId: CONTRACT, logs: [LOG], failed: false, blockHash: "h101" },
    ];
    const chain: ChainReader = {
      endpoint: "x",
      finalHeight: async () => 101,
      block: async (height: number) => (height === 100 ? { height, hash: "h100", timestampNs: 1n, newChunkHashes: ["c"] } : { height, hash: "h101", timestampNs: 2n, newChunkHashes: [] }),
      heightOfBlock: async (hash: string) => Number(hash.slice(1)),
      chunkTransactions: async () => [{ hash: "tx", signerId: "a.near" }],
      txOutcomes: async () => outcomes,
    } as unknown as ChainReader;
    const src = new RpcBlockSource(chain, CONTRACT, 100);
    await src.getBlock(100);
    const block = await src.getBlock(101);
    expect(block?.logs.map((l) => l.receiptId)).toEqual(["good"]);
  });
});
