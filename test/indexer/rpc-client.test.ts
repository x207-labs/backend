import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  AllRpcEndpointsFailedError,
  EndpointBehindError,
  FailoverRpcClient,
  rpcClientFromEnv,
  type EndpointChange,
} from "../../src/indexer/rpc-client.js";
import { MockRpc } from "../helpers/mock-rpc.js";

const HEIGHTS = [100, 101, 102, 103, 104, 105];

describe("BE-005 FailoverRpcClient", () => {
  const started: MockRpc[] = [];

  async function mock(heights = HEIGHTS): Promise<MockRpc> {
    const rpc = await new MockRpc(heights).start();
    started.push(rpc);
    return rpc;
  }

  function client(primary: MockRpc, fallback: MockRpc, extra = {}): FailoverRpcClient {
    return new FailoverRpcClient({ endpoints: [primary.url, fallback.url], timeoutMs: 200, ...extra });
  }

  afterEach(async () => {
    await Promise.all(started.splice(0).map((rpc) => rpc.kill()));
  });

  it("TC-BE-005-01 primary healthy: block read from the primary", async () => {
    const [primary, fallback] = [await mock(), await mock()];
    const rpc = client(primary, fallback);

    const block = await rpc.getBlock(103);

    expect(block?.header.height).toBe(103);
    expect(rpc.activeEndpoint).toBe(primary.url);
    expect(fallback.methods).toEqual([]);
  });

  it("TC-BE-005-02 primary dies mid-range: the fallback continues without skipping", async () => {
    const [primary, fallback] = [await mock(), await mock()];
    const changes: EndpointChange[] = [];
    const rpc = client(primary, fallback, { onEndpointChange: (c: EndpointChange) => changes.push(c) });

    const read: number[] = [];
    for (const height of HEIGHTS) {
      if (height === 103) await primary.kill();
      const block = await rpc.getBlock(height);
      read.push(block!.header.height);
    }

    expect(read).toEqual(HEIGHTS);
    expect(rpc.activeEndpoint).toBe(fallback.url);
    expect(fallback.blockRequests.map((r) => r.block_id).filter(Boolean)).toEqual([103, 104, 105]);
    expect(changes.map(({ from, to }) => ({ from, to }))).toEqual([{ from: primary.url, to: fallback.url }]);
    expect(changes[0]?.failures[0]?.endpoint).toBe(primary.url);
  });

  it("TC-BE-005-02 primary times out: switch to the fallback", async () => {
    const [primary, fallback] = [await mock(), await mock()];
    primary.mode = "hang";
    const rpc = client(primary, fallback, { timeoutMs: 50 });

    expect((await rpc.getFinalBlock()).header.height).toBe(105);
    expect(rpc.activeEndpoint).toBe(fallback.url);
  });

  it.each([503, 500, 502, 504, 429])("TC-BE-005-03 primary answers HTTP %i: switch to the fallback", async (status) => {
    const [primary, fallback] = [await mock(), await mock()];
    primary.mode = status;
    const rpc = client(primary, fallback);

    expect((await rpc.getBlock(101))?.header.height).toBe(101);
    expect(rpc.activeEndpoint).toBe(fallback.url);
  });

  it("TC-BE-005-04 both RPCs down: the error carries all failures, the next call recovers", async () => {
    const [primary, fallback] = [await mock(), await mock()];
    primary.mode = 503;
    fallback.mode = 503;
    const rpc = client(primary, fallback);

    const error = await rpc.getBlock(101).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AllRpcEndpointsFailedError);
    expect((error as AllRpcEndpointsFailedError).failures.map((f) => f.endpoint)).toEqual([primary.url, fallback.url]);

    // Still in cooldown: all endpoints are still tried, so the indexer retry does not get stuck.
    fallback.mode = "ok";
    expect((await rpc.getBlock(101))?.header.height).toBe(101);
    expect(rpc.activeEndpoint).toBe(fallback.url);
  });

  it("returns to the primary after cooldown, not before", async () => {
    const [primary, fallback] = [await mock(), await mock()];
    let now = 1_000;
    primary.mode = 503;
    const rpc = client(primary, fallback, { cooldownMs: 500, now: () => now });

    await rpc.getBlock(101);
    primary.mode = "ok";
    await rpc.getBlock(102);
    expect(primary.methods).toEqual([]);
    expect(rpc.activeEndpoint).toBe(fallback.url);

    now += 501;
    await rpc.getBlock(103);
    expect(rpc.activeEndpoint).toBe(primary.url);
  });

  it("TC-BE-005-05 endpoints from env", async () => {
    const [primary, fallback] = [await mock(), await mock()];
    const rpc = rpcClientFromEnv({ NEAR_RPC_PRIMARY_URL: primary.url, NEAR_RPC_FALLBACK_URL: fallback.url });

    await rpc.getFinalBlock();

    expect(rpc.activeEndpoint).toBe(primary.url);
    expect(primary.methods).toEqual(["block"]);
  });

  it.each(["NEAR_RPC_PRIMARY_URL", "NEAR_RPC_FALLBACK_URL"])("TC-BE-005-05 without %s: fails, does not use a default URL", (name) => {
    const env = { NEAR_RPC_PRIMARY_URL: "http://a.test", NEAR_RPC_FALLBACK_URL: "http://b.test", [name]: "" };
    expect(() => rpcClientFromEnv(env)).toThrow(`Missing env ${name}`);
  });

  it("TC-BE-005-06 only final blocks: heights above the final head are never requested", async () => {
    const [primary, fallback] = [await mock(), await mock()];
    const rpc = client(primary, fallback);

    await rpc.getFinalBlock();
    await rpc.getBlock(103);
    const error = await rpc.getBlock(106).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AllRpcEndpointsFailedError);
    const failures = (error as AllRpcEndpointsFailedError).failures;
    expect(failures.every((f) => f.error instanceof EndpointBehindError)).toBe(true);
    for (const request of [...primary.blockRequests, ...fallback.blockRequests]) {
      expect(request.finality === "final" || request.block_id! <= 105).toBe(true);
    }
  });

  it("TC-BE-005-07 without NEAR Lake", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      dependencies?: object;
      devDependencies?: object;
    };
    const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    expect(names).toContain("near-api-js");
    expect(names.filter((name) => name.includes("near-lake"))).toEqual([]);
  });

  it("a height skipped by the chain: null without failover", async () => {
    const [primary, fallback] = [await mock([100, 101, 103]), await mock([100, 101, 103])];
    const rpc = client(primary, fallback);

    await expect(rpc.getBlock(102)).resolves.toBeNull();

    expect(rpc.activeEndpoint).toBe(primary.url);
    expect(fallback.methods).toEqual([]);
  });

  it("a lagging fallback is not treated as a skipped block", async () => {
    const [primary, fallback] = [await mock(), await mock([100, 101])];
    const rpc = client(primary, fallback);
    await rpc.getBlock(103);
    await primary.kill();

    const error = await rpc.getBlock(104).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AllRpcEndpointsFailedError);
    const fallbackFailure = (error as AllRpcEndpointsFailedError).failures.find((f) => f.endpoint === fallback.url);
    expect(fallbackFailure?.error).toBeInstanceOf(EndpointBehindError);
  });
});
