import { describe, expect, it } from "vitest";
import { NeardataBlockSource, NeardataError } from "../../src/indexer/neardata-source.js";

const CONTRACT = "x207-circle.near";
const LOG_A = 'EVENT_JSON:{"standard":"x207","version":"0.0.1","event":"x","data":[{}]}';

function outcome(id: string, executor: string, logs: string[], tx: string | null = "tx1") {
  return { execution_outcome: { id, outcome: { executor_id: executor, logs }, block_hash: "bh" }, receipt: {}, tx_hash: tx };
}

const BLOCK = {
  block: { header: { height: 1001, hash: "hash1001", timestamp_nanosec: "1793535145853498471" } },
  shards: [
    { shard_id: 0, receipt_execution_outcomes: [outcome("r1", CONTRACT, ["plain", LOG_A]), outcome("r2", "intents.near", [LOG_A])] },
    { shard_id: 1, receipt_execution_outcomes: [outcome("r3", CONTRACT, [LOG_A], null)] },
    { shard_id: 2 },
  ],
};

function source(routes: Record<string, () => Response>): { src: NeardataBlockSource; seen: string[] } {
  const seen: string[] = [];
  const fetchImpl = ((url: string) => {
    const path = new URL(url).pathname;
    seen.push(path);
    const route = routes[path];
    return Promise.resolve(route ? route() : new Response("{}", { status: 404 }));
  }) as unknown as typeof fetch;
  return { src: new NeardataBlockSource({ baseUrl: "https://neardata.test/", contractId: CONTRACT, fetch: fetchImpl }), seen };
}

describe("ADR-34 NeardataBlockSource", () => {
  it("TC-BE-006-01 hanya outcome receipt milik kontrak, log_index = posisi di daftar log outcome", async () => {
    const { src } = source({ "/v0/block/1001": () => Response.json(BLOCK) });
    const block = await src.getBlock(1001);
    expect(block).toEqual({
      height: 1001, hash: "hash1001", timestampNs: 1793535145853498471n,
      logs: [
        { receiptId: "r1", logIndex: 0, executorId: CONTRACT, txHash: "tx1", log: "plain" },
        { receiptId: "r1", logIndex: 1, executorId: CONTRACT, txHash: "tx1", log: LOG_A },
        { receiptId: "r3", logIndex: 0, executorId: CONTRACT, txHash: null, log: LOG_A },
      ],
    });
  });

  it("blok yang dilewati chain (null) dikembalikan sebagai null", async () => {
    const { src } = source({ "/v0/block/1002": () => Response.json(null) });
    await expect(src.getBlock(1002)).resolves.toBeNull();
  });

  it("finalHeight dari last_block/final", async () => {
    const { src, seen } = source({ "/v0/last_block/final": () => Response.json(BLOCK) });
    await expect(src.finalHeight()).resolves.toBe(1001);
    expect(seen).toEqual(["/v0/last_block/final"]);
  });

  it("blok di masa depan atau HTTP error dilempar sebagai NeardataError", async () => {
    const future = () => Response.json({ error: "The block is too far in the future", type: "BLOCK_DOES_NOT_EXIST" }, { status: 404 });
    const { src } = source({ "/v0/block/9": future, "/v0/block/8": () => Response.json({ type: "BLOCK_DOES_NOT_EXIST" }) });
    await expect(src.getBlock(9)).rejects.toBeInstanceOf(NeardataError);
    await expect(src.getBlock(8)).rejects.toThrow(/BLOCK_DOES_NOT_EXIST/);
  });

  it("endpoint tanpa garis miring penutup", () => {
    expect(source({}).src.endpoint).toBe("https://neardata.test");
  });
});
