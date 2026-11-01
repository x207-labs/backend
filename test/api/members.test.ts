import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acct, listen, seedAg6, seedCircle, seedMember, type TestServer } from "../helpers/d9-fixtures.js";

const BASE = "/x207/circles/agents-main";

describe("BE-014 read API anggota", () => {
  let db: Database.Database;
  let srv: TestServer;

  async function start(upTo: "L19" | "L29" = "L19") {
    db = new Database(":memory:");
    seedCircle(db);
    seedAg6(db, upTo);
    srv = await listen({ db });
  }
  const get = (path: string) => fetch(srv.url + path);

  afterEach(async () => {
    await srv.close();
    db.close();
  });

  it("TC-BE-014-01 daftar anggota urut account dengan unit dan decimals", async () => {
    await start();
    const res = await get(`${BASE}/members`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.circle).toBe("agents-main");
    expect(body.unit).toBe("credit");
    expect(body.decimals).toBe(6);
    expect(body.nextCursor).toBeNull();
    expect(body.items.map((m: { account: string }) => m.account)).toEqual(
      ["cleaner", "gpu", "image", "scraper", "summarizer", "translator"].map(acct),
    );
    expect(Object.keys(body.items[0]).sort()).toEqual(
      [
        "account", "exitRequestedEpoch", "headroom", "joinedAt", "limit", "outstandingDebt",
        "pubkeyVoucher", "settledHistory", "stake", "status", "termsHash",
      ].sort(),
    );
  });

  it("TC-BE-014-02 filter status", async () => {
    await start("L29");
    const active = await (await get(`${BASE}/members?status=active`)).json();
    expect(active.items.map((m: { account: string }) => m.account)).toEqual(
      ["cleaner", "gpu", "image", "summarizer", "translator"].map(acct),
    );
    const suspended = await (await get(`${BASE}/members?status=suspended`)).json();
    expect(suspended.items.map((m: { account: string }) => m.account)).toEqual([acct("scraper")]);
  });

  it("TC-BE-014-03 paginasi cursor keyset 2/2/2 tanpa duplikat", async () => {
    await start();
    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 3; i++) {
      const res = await get(`${BASE}/members?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      const body = await res.json();
      sizes.push(body.items.length);
      seen.push(...body.items.map((m: { account: string }) => m.account));
      cursor = body.nextCursor;
    }
    expect(sizes).toEqual([2, 2, 2]);
    expect(cursor).toBeNull();
    expect(seen).toEqual(["cleaner", "gpu", "image", "scraper", "summarizer", "translator"].map(acct));
  });

  it("TC-BE-014-04 limit di luar batas ditolak 400", async () => {
    await start();
    for (const bad of ["201", "0", "abc", "-1"]) {
      const res = await get(`${BASE}/members?limit=${bad}`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("invalid_request");
      expect(typeof body.error.message).toBe("string");
      expect(body.error.details).toBeTypeOf("object");
    }
    expect((await get(`${BASE}/members?limit=200`)).status).toBe(200);
  });

  it("TC-BE-014-04b cursor rusak ditolak 400", async () => {
    await start();
    const res = await get(`${BASE}/members?cursor=!!!`);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_request");
  });

  it("TC-BE-014-05 status tidak dikenal", async () => {
    await start();
    const res = await get(`${BASE}/members?status=banned`);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_request");
  });

  it("TC-BE-014-06 lingkaran tidak ada", async () => {
    await start();
    const res = await get("/x207/circles/nope/members");
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("circle_not_found");
  });

  it("TC-BE-014-07 satu anggota", async () => {
    await start();
    const res = await get(`${BASE}/members/${acct("scraper")}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      circle: "agents-main",
      unit: "credit",
      decimals: 6,
      account: acct("scraper"),
      status: "active",
      stake: "100000000",
      limit: "80000000",
      outstandingDebt: "50000000",
      headroom: "30000000",
      termsHash: "terms-scraper",
      pubkeyVoucher: "ed25519:scraper",
      settledHistory: "0",
      joinedAt: "2026-11-03T08:12:44Z",
      exitRequestedEpoch: null,
    });
  });

  it("TC-BE-014-08 headroom 0 untuk anggota tidak active", async () => {
    await start();
    seedMember(db, { name: "newbie", status: "pending", stake: 0, limit: 0, debt: 0 });
    seedMember(db, { name: "slashed", status: "suspended", stake: 5, limit: 80_000_000, debt: 10 });
    const pending = await (await get(`${BASE}/members/${acct("newbie")}`)).json();
    expect(pending.headroom).toBe("0");
    expect(pending.status).toBe("pending");
    const suspended = await (await get(`${BASE}/members/${acct("slashed")}`)).json();
    expect(suspended.headroom).toBe("0");
  });

  it("TC-BE-014-08b exitRequestedEpoch tampil untuk anggota yang meminta keluar (ADR-29)", async () => {
    await start();
    seedMember(db, { name: "leaver", exitRequestedEpoch: 43 });
    const body = await (await get(`${BASE}/members/${acct("leaver")}`)).json();
    expect(body.exitRequestedEpoch).toBe(43);
  });

  it("TC-BE-014-09 anggota tidak ada", async () => {
    await start();
    const res = await get(`${BASE}/members/nobody.near`);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("member_not_found");
  });

  it("TC-BE-014-10 header kesegaran dan CORS", async () => {
    await start();
    const ok = await get(`${BASE}/members`);
    expect(ok.headers.get("x-x207-indexed-block")).toBe("171234567");
    expect(ok.headers.get("access-control-allow-origin")).toBe("*");
    const notFound = await get(`${BASE}/members/nobody.near`);
    expect(notFound.headers.get("x-x207-indexed-block")).toBe("171234567");
    const bad = await get(`${BASE}/members?limit=999`);
    expect(bad.headers.get("x-x207-indexed-block")).toBe("171234567");
    const preflight = await fetch(srv.url + BASE + "/members", { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("TC-BE-014-16 jumlah string bilangan bulat, waktu ISO 8601 UTC, field camelCase", async () => {
    await start();
    const body = await (await get(`${BASE}/members`)).json();
    for (const m of body.items) {
      for (const key of ["stake", "limit", "outstandingDebt", "headroom", "settledHistory"]) {
        expect(m[key]).toMatch(/^\d+$/);
      }
      expect(m.joinedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      for (const key of Object.keys(m)) expect(key).toMatch(/^[a-z][A-Za-z0-9]*$/);
    }
  });

  it("jumlah di atas 2^53 tidak kehilangan presisi", async () => {
    await start();
    seedMember(db, { name: "whale", stake: 9007199254740993n, limit: 9007199254740995n, debt: 2n });
    const body = await (await get(`${BASE}/members/${acct("whale")}`)).json();
    expect(body.stake).toBe("9007199254740993");
    expect(body.headroom).toBe("9007199254740993");
  });
});
