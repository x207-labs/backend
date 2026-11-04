import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/index.js";
import { Indexer } from "../../src/indexer/indexer.js";
import { FailoverRpcClient } from "../../src/indexer/rpc-client.js";
import { RpcBlockSource, rpcChainReader } from "../../src/indexer/rpc-source.js";
import { CONTRACT } from "../helpers/fx-log42.js";
import { MockRpc } from "../helpers/mock-rpc.js";

const HEIGHTS = [100, 101, 102, 103, 104, 105];

describe("BE-005 RPC client under the indexer", () => {
  const started: MockRpc[] = [];
  afterEach(async () => {
    await Promise.all(started.splice(0).map((rpc) => rpc.kill()));
  });
  async function mock(): Promise<MockRpc> {
    const rpc = await new MockRpc(HEIGHTS).start();
    started.push(rpc);
    return rpc;
  }
  function indexer(client: FailoverRpcClient, db = openDatabase(":memory:")) {
    const source = new RpcBlockSource(rpcChainReader(client), CONTRACT, 100);
    return { db, ix: new Indexer({ db, source, circleId: "agents-main", contractId: CONTRACT, startBlock: 100 }) };
  }
  const cursor = (db: ReturnType<typeof openDatabase>) => db.prepare("SELECT last_block_height, rpc_endpoint FROM indexer_cursor").get();

  it("TC-BE-005-01 primary healthy: rpc_endpoint = primary URL", async () => {
    const [primary, fallback] = [await mock(), await mock()];
    const { db, ix } = indexer(new FailoverRpcClient({ endpoints: [primary.url, fallback.url], timeoutMs: 300 }));
    await ix.bootstrap();
    await ix.drain();
    expect(cursor(db)).toEqual({ last_block_height: 105, rpc_endpoint: primary.url });
    expect(fallback.methods).toEqual([]);
  });

  it("TC-BE-005-02 primary dies midway: cursor continues without skipping, rpc_endpoint = fallback", async () => {
    const [primary, fallback] = [await mock(), await mock()];
    const { db, ix } = indexer(new FailoverRpcClient({ endpoints: [primary.url, fallback.url], timeoutMs: 300 }));
    await ix.bootstrap();
    await ix.drain(3);
    expect(cursor(db)).toEqual({ last_block_height: 102, rpc_endpoint: primary.url });
    await primary.kill();
    await ix.drain();
    expect(cursor(db)).toEqual({ last_block_height: 105, rpc_endpoint: fallback.url });
    expect(fallback.blockRequests.map((r) => r.block_id).filter((h) => h !== undefined)).toEqual([103, 104, 105]);
  });

  it("TC-BE-005-04 both RPCs down: cursor does not advance, the indexer retries and recovers", async () => {
    const [primary, fallback] = [await mock(), await mock()];
    const { db, ix } = indexer(new FailoverRpcClient({ endpoints: [primary.url, fallback.url], timeoutMs: 300, cooldownMs: 0 }));
    await ix.bootstrap();
    await ix.drain(2);
    primary.mode = 503;
    fallback.mode = 503;
    await expect(ix.step()).rejects.toThrow(/All RPC endpoints failed/);
    expect(cursor(db)).toMatchObject({ last_block_height: 101 });
    primary.mode = "ok";
    await ix.drain();
    expect(cursor(db)).toMatchObject({ last_block_height: 105 });
  });
});
