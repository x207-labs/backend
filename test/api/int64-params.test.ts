import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listen, seedCircle, seedEpoch, type TestServer } from "../helpers/d9-fixtures.js";
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

  it("TC-BE-108-02 a closed root /metrics (token set) does not close the dashboard route epochs/{n}/metrics", async () => {
    await srv.close();
    db.close();
    db = new Database(":memory:");
    seedCircle(db);
    seedEpoch(db, { epoch: 42, phase: "finalized", closedAt: "2026-11-09T08:19:56Z", proposalDeadline: "2026-11-09T08:29:56Z", committedAt: "2026-11-09T08:30:00Z", paymentDeadline: "2026-11-09T09:00:00Z", finalizedAt: "2026-11-09T09:00:30Z", edgeCount: 1, totalObligation: 100_000_000, cleared: 80_000_000 });
    srv = await listen({ db, now: () => Date.parse("2026-11-09T11:25:00Z"), metricsToken: "closed-token" });
    expect((await fetch(`${srv.url}/metrics`)).status).toBe(401);
    expect((await fetch(`${srv.url}${BASE}/epochs/42/metrics`)).status).toBe(200);
    expect((await fetch(`${srv.url}/healthz`)).status).toBe(200);
  });

  it("TC-BE-105-03an epoch that fits int64 but does not exist is still 404", async () => {
    const res = await fetch(srv.url + `${BASE}/epochs/9223372036854775807`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("epoch_not_found");
  });
});
