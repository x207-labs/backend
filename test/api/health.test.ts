import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/index.js";
import { Indexer } from "../../src/indexer/indexer.js";
import { ArrayBlockSource, CONTRACT as FX_CONTRACT, acct, fxLog42 } from "../helpers/fx-log42.js";
import { listen, seedAg6, seedCircle, type TestServer } from "../helpers/d9-fixtures.js";
import { Ajv } from "ajv";
import { readFileSync } from "node:fs";

const BASE = "/x207/circles/agents-main";

describe("BE-006 GET /x207/health", () => {
  let db: Database.Database;
  let srv: TestServer;
  afterEach(async () => {
    await srv.close();
    db.close();
  });

  it("TC-BE-006-20 normal", async () => {
    db = openDatabase(":memory:");
    seedCircle(db);
    db.prepare("UPDATE indexer_cursor SET head_block_height = last_block_height + 3, lag_blocks = 3, updated_at = ?").run(Date.parse("2026-11-09T11:30:02Z"));
    srv = await listen({ db });
    const res = await fetch(srv.url + "/x207/health");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({
      status: "ok",
      cursors: [{ name: "x207-circle.near", lastBlockHeight: 171234567, headBlockHeight: 171234570, lagBlocks: 3, rpcEndpoint: "https://rpc.mainnet.fastnear.com", updatedAt: "2026-11-09T11:30:02Z" }],
    });
    const ajv = new Ajv({ strict: false });
    ajv.addSchema(JSON.parse(readFileSync(new URL("../../docs/api-schemas/common.json", import.meta.url), "utf8")));
    const validate = ajv.compile(JSON.parse(readFileSync(new URL("../../docs/api-schemas/health.json", import.meta.url), "utf8")));
    expect(validate(body)).toBe(true);
  });

  it("TC-BE-006-21 more than 100 blocks behind: degraded", async () => {
    db = openDatabase(":memory:");
    seedCircle(db);
    db.prepare("UPDATE indexer_cursor SET lag_blocks = 101").run();
    srv = await listen({ db });
    const res = await fetch(srv.url + "/x207/health");
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("degraded");
  });

  it("TC-BE-006-22 before bootstrap: 503 indexer_unavailable", async () => {
    db = openDatabase(":memory:");
    srv = await listen({ db });
    const res = await fetch(srv.url + "/x207/health");
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("indexer_unavailable");
  });
});
