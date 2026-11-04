import { describe, expect, it } from "vitest";
import { AccountIndexBlockSource } from "../../src/indexer/account-index-source.js";
import type { BlockSource, SourceBlock } from "../../src/indexer/block-source.js";
import { blockSourceFromEnv, appConfigFromEnv } from "../../src/main.js";
import { FailoverRpcClient } from "../../src/indexer/rpc-client.js";

// BE-089: the testnet indexer reads only the blocks of the transactions that the index of the account lists.
describe("BE-089 AccountIndexBlockSource", () => {
  const block = (height: number): SourceBlock => ({ height, hash: `h${height}`, timestampNs: BigInt(height), logs: [] });
  function setup(txHeights: number[], head: number) {
    const asked: number[] = [];
    const inner: BlockSource = { endpoint: "inner", finalHeight: async () => head, getBlock: async (h) => { asked.push(h); return block(h); } };
    const pages: Array<{ heights: number[]; token: string | null }> = [];
    const sorted = [...txHeights].sort((a, b) => b - a);
    for (let i = 0; i < sorted.length; i += 2) pages.push({ heights: sorted.slice(i, i + 2), token: i + 2 < sorted.length ? `t${i + 2}` : null });
    const requests: unknown[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      requests.push(body);
      const page = body.resume_token ? pages.find((p, i) => `t${i * 2}` === body.resume_token) : pages[0];
      return new Response(JSON.stringify({ account_txs: (page?.heights ?? []).map((h) => ({ tx_block_height: h })), resume_token: page?.token ?? null }), { status: 200 });
    }) as unknown as typeof fetch;
    const clock = { now: 1_000_000 };
    const source = new AccountIndexBlockSource({ inner, txIndexUrl: "https://tx.example/v0/account", contractId: "c.testnet", fetch: fetchImpl, now: () => clock.now, sleep: async () => undefined, marginBlocks: 10 });
    return { source, asked, requests, clock, inner };
  }

  it("TC-BE-089-04 a block is read only when it is the block of a listed transaction or one of the 8 after it; the other heights are skipped; the source stops a margin behind the head", async () => {
    const { source, asked } = setup([100, 103, 200], 300);
    expect(await source.finalHeight()).toBe(290);
    for (let h = 95; h <= 215; h++) await source.getBlock(h);
    expect(asked).toEqual([...range(100, 111), ...range(200, 208)]); // 100..108 and 103..111 overlap
    expect(await source.getBlock(99)).toBeNull();
    expect(await source.getBlock(209)).toBeNull();
    function range(a: number, b: number) { return Array.from({ length: b - a + 1 }, (_, i) => a + i); }
  });

  it("TC-BE-089-05 the index is read newest first and a later read stops at the first page with nothing new; it is read at most once each refreshMs", async () => {
    const { source, requests, clock } = setup([10, 20, 30, 40, 50], 1000);
    await source.finalHeight();
    expect(requests).toHaveLength(3); // the first read goes to the end
    await source.finalHeight();
    expect(requests).toHaveLength(3); // too soon
    clock.now += 6_000;
    await source.finalHeight();
    expect(requests).toHaveLength(4); // one page, nothing new, stop
  });

  it("TC-BE-089-06 X207_BLOCK_SOURCE picks the source; account-index needs both URLs; an unknown value is refused", () => {
    const rpc = new FailoverRpcClient({ endpoints: ["http://127.0.0.1:1"] });
    const base = { NEAR_RPC_PRIMARY_URL: "http://127.0.0.1:1", X207_CONTRACT_ID: "c.testnet", X207_START_BLOCK: "1" };
    const cfg = (extra: Record<string, string>) => appConfigFromEnv({ ...base, ...extra });
    expect(blockSourceFromEnv({ ...base }, cfg({}), rpc).constructor.name).toBe("RpcBlockSource");
    expect(blockSourceFromEnv({ ...base, X207_BLOCK_SOURCE: "neardata", NEARDATA_URL: "https://n.example" }, cfg({}), rpc).constructor.name).toBe("NeardataBlockSource");
    expect(blockSourceFromEnv({ ...base, X207_BLOCK_SOURCE: "account-index", NEARDATA_URL: "https://n.example", FASTNEAR_TX_URL: "https://t.example" }, cfg({}), rpc).constructor.name).toBe("AccountIndexBlockSource");
    expect(() => blockSourceFromEnv({ ...base, X207_BLOCK_SOURCE: "account-index", NEARDATA_URL: "https://n.example" }, cfg({}), rpc)).toThrow(/FASTNEAR_TX_URL is required/);
    expect(() => blockSourceFromEnv({ ...base, X207_BLOCK_SOURCE: "nope" }, cfg({}), rpc)).toThrow(/must be rpc, neardata or account-index/);
  });
});
