import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/index.js";
import { Indexer } from "../../src/indexer/indexer.js";
import { ArrayBlockSource, CONTRACT as FX_CONTRACT, acct, fxLog42 } from "../helpers/fx-log42.js";
import { listen, seedAg6, seedCircle, type TestServer } from "../helpers/d9-fixtures.js";
import { Ajv } from "ajv";
import { readFileSync } from "node:fs";

const BASE = "/x207/circles/agents-main";

describe("BE-011 GET …/members/{account}/limits", () => {
  let db: Database.Database;
  let srv: TestServer;
  afterEach(async () => {
    await srv.close();
    db.close();
  });

  async function fx(): Promise<void> {
    db = openDatabase(":memory:");
    const ix = new Indexer({ db, source: new ArrayBlockSource(fxLog42()), circleId: "agents-main", contractId: FX_CONTRACT, startBlock: 1000 });
    await ix.bootstrap();
    await ix.drain();
    srv = await listen({ db });
  }

  it("TC-BE-011-06 riwayat terbaru dulu, jumlah string", async () => {
    await fx();
    const res = await fetch(`${srv.url}${BASE}/members/${acct("scraper")}/limits`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([
      { epoch: 42, oldLimit: "80000000", newLimit: "0", status: "suspended", reason: "default", blockHeight: 1009 },
      { epoch: null, oldLimit: "0", newLimit: "80000000", status: "active", reason: "stake", blockHeight: 1001 },
    ]);
    expect(body.nextCursor).toBeNull();
  });

  it("TC-BE-011-07 paginasi 2/2/1 tanpa baris ganda", async () => {
    db = openDatabase(":memory:");
    seedCircle(db);
    seedAg6(db);
    const insert = db.prepare(
      "INSERT INTO member_limits (circle_id, account_id, epoch, old_limit, new_limit, status, reason, block_height, receipt_id, log_index) VALUES ('agents-main', ?, ?, 0, ?, 'active', 'finalize', ?, ?, 0)",
    );
    for (let i = 1; i <= 5; i++) insert.run(acct("gpu"), i, i * 10, 100 + i, `r${i}`);
    srv = await listen({ db });
    const seen: number[] = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    do {
      const res = await fetch(`${srv.url}${BASE}/members/${acct("gpu")}/limits?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      const body = await res.json();
      sizes.push(body.items.length);
      seen.push(...body.items.map((i: { epoch: number }) => i.epoch));
      cursor = body.nextCursor;
    } while (cursor);
    expect(sizes).toEqual([2, 2, 1]);
    expect(seen).toEqual([5, 4, 3, 2, 1]);
  });

  it("TC-BE-011-08 akun tidak ada: 404 member_not_found", async () => {
    await fx();
    const res = await fetch(`${srv.url}${BASE}/members/nobody.near/limits`);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("member_not_found");
  });
});
