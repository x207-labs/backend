import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { pollActiveJobs, refreshJob, startJobMonitor, mapOneClickStatus } from "../../src/settlement/deposit/monitor.js";
import { getJob, insertJob, type JobRow, type NewJob } from "../../src/settlement/jobs.js";
import { MOCK_TOKENS } from "../../src/settlement/mock-transport.js";
import { OneClickClient, type OneClickTransport } from "../../src/settlement/one-click.js";
import { jobRoutes } from "../../src/api/routes/jobs.js";
import { listen, type TestServer } from "../helpers/d9-fixtures.js";

const T0 = Date.parse("2026-11-09T11:40:00Z");
const DEADLINE = Date.parse("2026-11-09T11:45:00Z");
const JOB_ID = "5d0f8a52-7c1e-4a8e-9a77-1f3c2b8d9e10";

function job(over: Partial<NewJob> = {}): NewJob {
  return {
    job_id: JOB_ID,
    kind: "deposit_settle",
    circle_id: "agents-main",
    account_id: "scraper.x207-circle.near",
    epoch: 42,
    origin_asset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    destination_asset: "nep141:usdt.tether-token.near",
    amount_in: "35050000",
    amount_out: "35000000",
    withdraw_fee: null,
    deposit_address: "0x7a1c",
    refund_to: "scraper.x207-circle.near",
    recipient: "scraper.x207-circle.near",
    recipient_type: "INTENTS",
    dry: 0,
    status: "waiting_deposit",
    quote_json: "{}",
    quote_deadline: DEADLINE,
    created_at: T0 - 60_000,
    ...over,
  };
}

describe("BE-028 pemantauan status job deposit", () => {
  let db: Database.Database;
  let oneClickStatus: string;
  let statusCalls: string[];
  let fail: boolean;
  let client: OneClickClient;
  let now: number;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
    oneClickStatus = "PENDING_DEPOSIT";
    statusCalls = [];
    fail = false;
    now = T0;
    const transport: OneClickTransport = {
      getTokens: async () => MOCK_TOKENS,
      getQuote: async () => { throw new Error("tidak dipakai"); },
      getExecutionStatus: async (address) => {
        statusCalls.push(address);
        if (fail) throw new Error("HTTP 500");
        return { status: oneClickStatus } as never;
      },
      generateIntent: async () => { throw new Error("tidak dipakai"); },
      submitIntent: async () => { throw new Error("tidak dipakai"); },
    };
    client = new OneClickClient({ config: { mode: "dry", baseUrl: "x", jwt: undefined, appFees: [] }, transport });
  });

  afterEach(() => db.close());

  const deps = () => ({ db, client, now: () => now });
  const refresh = async (raw: string, kind?: NewJob["kind"]) => {
    oneClickStatus = raw;
    const row = getJob(db, JOB_ID) as JobRow;
    return refreshJob(deps(), kind ? { ...row, kind } : row);
  };

  it("TC-BE-028-01 menunggu setoran menyimpan status mentah", async () => {
    insertJob(db, job());
    for (const raw of ["PENDING_DEPOSIT", "INCOMPLETE_DEPOSIT"]) {
      const j = await refresh(raw);
      expect(j.status).toBe("waiting_deposit");
      expect(j.one_click_status).toBe(raw);
    }
  });

  it("TC-BE-028-02 diproses", async () => {
    insertJob(db, job());
    for (const raw of ["KNOWN_DEPOSIT_TX", "PROCESSING"]) {
      expect((await refresh(raw)).status).toBe("processing");
    }
  });

  it("TC-BE-028-03 SUCCESS pada deposit_settle → ready_withdraw dan updated_at berubah", async () => {
    insertJob(db, job());
    now = T0 + 5000;
    const j = await refresh("SUCCESS");
    expect(j.status).toBe("ready_withdraw");
    expect(j.one_click_status).toBe("SUCCESS");
    expect(j.updated_at).toBe(T0 + 5000);
  });

  it("TC-BE-028-03b SUCCESS pada deposit_stake juga ready_withdraw; withdraw → completed", async () => {
    insertJob(db, job({ kind: "deposit_stake", epoch: null }));
    expect((await refresh("SUCCESS")).status).toBe("ready_withdraw");
    expect(mapOneClickStatus("SUCCESS", "withdraw")).toBe("completed");
    expect(mapOneClickStatus("PENDING_DEPOSIT", "withdraw")).toBeNull();
  });

  it("TC-BE-028-04 REFUNDED", async () => {
    insertJob(db, job());
    expect((await refresh("REFUNDED")).status).toBe("refunded");
  });

  it("TC-BE-028-05 FAILED", async () => {
    insertJob(db, job());
    expect((await refresh("FAILED")).status).toBe("failed");
  });

  it("TC-BE-028-06 lewat quote_deadline tanpa setoran → expired; setoran sebelum tenggat tetap diproses", async () => {
    insertJob(db, job());
    now = DEADLINE - 1;
    expect((await refresh("PENDING_DEPOSIT")).status).toBe("waiting_deposit");
    now = DEADLINE + 1;
    expect((await refresh("PENDING_DEPOSIT")).status).toBe("expired");

    db.exec("DELETE FROM settlement_jobs");
    insertJob(db, job());
    now = DEADLINE + 1;
    expect((await refresh("PROCESSING")).status).toBe("processing");
  });

  it("TC-BE-028-07 status akhir tidak dipantau lagi", async () => {
    for (const status of ["failed", "refunded", "expired"] as const) {
      db.exec("DELETE FROM settlement_jobs");
      insertJob(db, job({ status }));
      const j = await refresh("SUCCESS");
      expect(j.status).toBe(status);
    }
    expect(statusCalls).toHaveLength(0);
    expect(await pollActiveJobs(deps())).toEqual({ polled: 0, failed: 0 });
  });

  it("job dry atau tanpa deposit address tidak dipantau", async () => {
    insertJob(db, job({ dry: 1, deposit_address: null, status: "quoted" }));
    await refresh("SUCCESS");
    expect(statusCalls).toHaveLength(0);
  });

  it("pollActiveJobs memperbarui semua job aktif dan terus berjalan bila satu gagal", async () => {
    insertJob(db, job());
    insertJob(db, job({ job_id: "11111111-1111-1111-1111-111111111111", deposit_address: "0xother", created_at: T0 }));
    oneClickStatus = "SUCCESS";
    expect(await pollActiveJobs(deps())).toEqual({ polled: 2, failed: 0 });
    expect((getJob(db, JOB_ID) as JobRow).status).toBe("ready_withdraw");

    db.exec("DELETE FROM settlement_jobs");
    insertJob(db, job());
    fail = true;
    expect(await pollActiveJobs(deps())).toEqual({ polled: 1, failed: 1 });
    expect((getJob(db, JOB_ID) as JobRow).status).toBe("waiting_deposit");
  });

  it("startJobMonitor memanggil pemantauan berkala dan bisa dihentikan", async () => {
    vi.useFakeTimers();
    try {
      insertJob(db, job());
      oneClickStatus = "PROCESSING";
      const stop = startJobMonitor(deps(), 1000);
      await vi.advanceTimersByTimeAsync(1100);
      expect((getJob(db, JOB_ID) as JobRow).status).toBe("processing");
      stop();
      const calls = statusCalls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(statusCalls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("GET /x207/settlement/jobs/{jobId}", () => {
    let srv: TestServer;
    afterEach(async () => {
      await srv.close();
    });

    it("TC-BE-028-08 job TC-BE-028-03: bentuk respons Spec 6.5", async () => {
      insertJob(db, job());
      oneClickStatus = "SUCCESS";
      now = Date.parse("2026-11-09T11:41:20Z");
      srv = await listen({ db, now: () => now, extraRoutes: jobRoutes(client) });
      const res = await fetch(`${srv.url}/x207/settlement/jobs/${JOB_ID}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        jobId: JOB_ID,
        kind: "deposit_settle",
        status: "ready_withdraw",
        oneClickStatus: "SUCCESS",
        account: "scraper.x207-circle.near",
        epoch: 42,
        depositAddress: "0x7a1c",
        amountOut: "35000000",
        intentHash: null,
        updatedAt: "2026-11-09T11:41:20Z",
      });
    });

    it("TC-BE-028-09 job tidak ada → 404 job_not_found", async () => {
      srv = await listen({ db, extraRoutes: jobRoutes(client) });
      const res = await fetch(`${srv.url}/x207/settlement/jobs/00000000-0000-0000-0000-000000000000`);
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("job_not_found");
    });

    it("TC-BE-028-10 1Click error saat baca status → 502 one_click_error, job tidak berubah", async () => {
      insertJob(db, job());
      fail = true;
      srv = await listen({ db, now: () => now, extraRoutes: jobRoutes(client) });
      const res = await fetch(`${srv.url}/x207/settlement/jobs/${JOB_ID}`);
      expect(res.status).toBe(502);
      expect((await res.json()).error.code).toBe("one_click_error");
      const row = getJob(db, JOB_ID) as JobRow;
      expect(row.status).toBe("waiting_deposit");
      expect(row.updated_at).toBe(T0 - 60_000);
    });

    it("status akhir dijawab tanpa memanggil 1Click", async () => {
      insertJob(db, job({ status: "refunded", one_click_status: "REFUNDED" }));
      srv = await listen({ db, extraRoutes: jobRoutes(client) });
      const body = await (await fetch(`${srv.url}/x207/settlement/jobs/${JOB_ID}`)).json();
      expect(body.status).toBe("refunded");
      expect(statusCalls).toHaveLength(0);
    });
  });
});
