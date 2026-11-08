import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listen, seedCircle, type TestServer } from "../helpers/d9-fixtures.js";
import { parseInt64Param } from "../../src/api/epoch-param.js";

const BASE = "/x207/circles/agents-main";

describe("BE-105 integer path params beyond int64 (A-BE-03)", () => {
  let db: Database.Database;
  let srv: TestServer;

  beforeEach(async () => {
    db = new Database(":memory:");
    seedCircle(db);
    srv = await listen({ db, now: () => Date.parse("2026-11-09T11:25:00Z") });
  });

  afterEach(async () => {
    await srv.close();
    db.close();
  });

  it("TC-BE-105-01 parseInt64Param accepts 0 and the int64 maximum, refuses more digits, a bigger value, a leading zero and signs", () => {
    expect(parseInt64Param("0", "n")).toBe(0n);
    expect(parseInt64Param("9223372036854775807", "n")).toBe(9223372036854775807n);
    for (const bad of ["9223372036854775808", "99999999999999999999999999", "01", "-1", "1.5", "", "1e3"]) {
      expect(() => parseInt64Param(bad, "n")).toThrow(/between 0 and/);
    }
  });

  it("TC-BE-105-02 an epoch or bundleId above int64 gives 400 invalid_request, not 500", async () => {
    for (const path of [
      `${BASE}/epochs/99999999999999999999999999/settlements`,
      `${BASE}/epochs/9223372036854775808`,
      `${BASE}/deals/99999999999999999999`,
    ]) {
      const res = await fetch(srv.url + path);
      expect(res.status, path).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_request");
    }
  });

  it("TC-BE-105-03 an epoch that fits int64 but does not exist is still 404", async () => {
    const res = await fetch(srv.url + `${BASE}/epochs/9223372036854775807`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("epoch_not_found");
  });
});
