import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { apiOptionsFromEnv } from "../../src/api/server.js";
import { migrate } from "../../src/db/migrate.js";
import { listen, seedAg6, seedCircle, type TestServer } from "../helpers/d9-fixtures.js";

const BASE = "/x207/circles/agents-main";

describe("BE-014 server read API", () => {
  let db: Database.Database;
  let srv: TestServer;

  afterEach(async () => {
    await srv.close();
    db.close();
  });

  it("TC-BE-014-11 D9 belum dimigrasi dijawab 503 indexer_unavailable", async () => {
    db = new Database(":memory:");
    srv = await listen({ db });
    const res = await fetch(srv.url + `${BASE}/members`);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("indexer_unavailable");
  });

  it("TC-BE-014-11b indexer belum bootstrap (tanpa cursor) dijawab 503", async () => {
    db = new Database(":memory:");
    migrate(db);
    db.prepare("INSERT INTO circles VALUES ('agents-main', 'x207-circle.near', 'x207:agents-main')").run();
    srv = await listen({ db });
    const res = await fetch(srv.url + `${BASE}/members`);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("indexer_unavailable");
  });

  it("TC-BE-014-17 rate limit per IP: permintaan ke-6 dijawab 429 dengan Retry-After", async () => {
    db = new Database(":memory:");
    seedCircle(db);
    seedAg6(db);
    let t = 1_000_000;
    srv = await listen({ db, rateLimitPerMinute: 5, now: () => t });
    for (let i = 0; i < 5; i++) expect((await fetch(srv.url + `${BASE}/members`)).status).toBe(200);
    const limited = await fetch(srv.url + `${BASE}/members`);
    expect(limited.status).toBe(429);
    expect((await limited.json()).error.code).toBe("rate_limited");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // endpoint lain di IP yang sama juga dibatasi
    expect((await fetch(srv.url + `${BASE}/epochs`)).status).toBe(429);
    // jendela berikutnya melepas batas
    t += 61_000;
    expect((await fetch(srv.url + `${BASE}/members`)).status).toBe(200);
  });

  it("tanpa rate limit bila nol", async () => {
    db = new Database(":memory:");
    seedCircle(db);
    srv = await listen({ db, rateLimitPerMinute: 0 });
    for (let i = 0; i < 10; i++) expect((await fetch(srv.url + `${BASE}/members`)).status).toBe(200);
  });

  it("path tidak dikenal dijawab 404 dengan format error", async () => {
    db = new Database(":memory:");
    seedCircle(db);
    srv = await listen({ db });
    const res = await fetch(srv.url + "/x207/unknown");
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  it("apiOptionsFromEnv membaca API_RATE_LIMIT_PER_MINUTE", () => {
    expect(apiOptionsFromEnv({ API_RATE_LIMIT_PER_MINUTE: "5" })).toEqual({ rateLimitPerMinute: 5 });
    expect(apiOptionsFromEnv({})).toEqual({ rateLimitPerMinute: 0 });
    expect(() => apiOptionsFromEnv({ API_RATE_LIMIT_PER_MINUTE: "x" })).toThrow();
  });
});
