import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { appConfigFromEnv, startApp, type App } from "../src/main.js";
import { DEFAULT_PARAMS } from "./helpers/fx-log42.js";

const ENV = { NEAR_RPC_PRIMARY_URL: "http://rpc.test", X207_CONTRACT_ID: "x207-circle.testnet", X207_START_BLOCK: "100" };

describe("main process", () => {
  it("appConfigFromEnv reads required and optional variables", () => {
    expect(appConfigFromEnv({ ...ENV, NEAR_RPC_FALLBACK_URL: "http://fb.test", X207_API_PORT: "9000" })).toMatchObject({
      contractId: "x207-circle.testnet", circleId: "agents-main", startBlock: 100, rpcEndpoints: ["http://rpc.test", "http://fb.test"],
      host: "127.0.0.1", port: 9000, dbPath: "x207.sqlite", jobPollMs: 15000,
    });
  });

  it("appConfigFromEnv rejects a missing or malformed variable", () => {
    expect(() => appConfigFromEnv({ ...ENV, X207_CONTRACT_ID: "" })).toThrow(/X207_CONTRACT_ID/);
    expect(() => appConfigFromEnv({ ...ENV, X207_START_BLOCK: "abc" })).toThrow(/X207_START_BLOCK/);
    expect(() => appConfigFromEnv({ X207_CONTRACT_ID: "a.near", X207_START_BLOCK: "1" })).toThrow(/NEAR_RPC_PRIMARY_URL/);
  });

  let app: App | undefined;
  let rpc: ReturnType<typeof createServer> | undefined;
  afterEach(async () => {
    await app?.stop();
    await new Promise<void>((done) => (rpc ? rpc.close(() => done()) : done()));
  });

  it("startApp serves the read API and the settlement endpoints on top of a bootstrapped D9", async () => {
    rpc = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: "x207", result: { result: [...Buffer.from(JSON.stringify(DEFAULT_PARAMS))] } }));
      });
    });
    await new Promise<void>((ready) => rpc!.listen(0, "127.0.0.1", ready));
    const rpcUrl = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;
    const lines: string[] = [];
    app = await startApp({ ...ENV, NEAR_RPC_PRIMARY_URL: rpcUrl, X207_DB_PATH: ":memory:", X207_API_PORT: "0", X207_SETTLEMENT_MODE: "mock" }, (l) => lines.push(l));
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    expect((await fetch(`${url}/x207/health`)).status).toBe(200);
    const params = await fetch(`${url}/x207/circles/agents-main/params`);
    expect(params.status).toBe(200);
    // the settlement route exists: a member that is not in D9 gives member_not_found, not a 404 for the path
    const quote = await fetch(`${url}/x207/settlement/withdraw/quote`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ circle: "agents-main", account: "nobody.testnet", destinationAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", amount: "45000000", recipient: "0xabc", refundTo: "nobody.testnet" }),
    });
    expect(quote.status).toBe(404);
    expect(((await quote.json()) as { error: { code: string } }).error.code).toBe("member_not_found");
    expect(lines.some((l) => l.includes('"mode":"mock"') && l.includes('"msg":"x207 backend ready"'))).toBe(true);
  });
});
