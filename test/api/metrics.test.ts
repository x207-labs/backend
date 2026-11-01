import { afterEach, describe, expect, it } from "vitest";
import { appliedLog, AGENTS, block, committedLog, cutoffLog, joinLog, positions, stakeLog, voucherLog } from "../helpers/fx-log42.js";
import { fxServer } from "../helpers/fx-api.js";
import { computeEpochMetrics, ratio4 } from "../../src/api/metrics.js";
import type { EpochRow } from "../../src/api/routes/epochs.js";
import { row } from "../../src/api/format.js";

const BASE = "/x207/circles/agents-main";

describe("BE-018 metrik epoch", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  async function fx(upTo: number, extra: Parameters<typeof fxServer>[1] = []) {
    const s = await fxServer(upTo, extra);
    close = s.close;
    return s;
  }
  async function get(path: string, upTo: number, extra: Parameters<typeof fxServer>[1] = []) {
    const s = await fx(upTo, extra);
    const res = await fetch(`${s.srv.url}${BASE}${path}`);
    return { res, body: await res.json(), s };
  }

  it("TC-BE-018-01 cleared ratio", async () => {
    const { body } = await get("/epochs/42/metrics", 8);
    expect(body).toMatchObject({ circle: "agents-main", epoch: 42, phase: "payment_window", totalVoucherValue: "190000000", cleared: "145000000", clearedRatio: 0.7632 });
  });

  it("TC-BE-018-02 penghematan transfer", async () => {
    const { body } = await get("/epochs/42/metrics", 8);
    expect(body).toMatchObject({ voucherCount: 60, residualTransfers: 3, transferSavings: 20 });
  });

  it("TC-BE-018-03 net internal debt sebelum dan sesudah", async () => {
    const { body } = await get("/epochs/42/metrics", 8);
    expect(body).toMatchObject({ debtBefore: "190000000", debtAfter: "45000000", debtReduction: 0.7632, netDebt: "45000000" });
  });

  it("TC-BE-018-04 kepadatan grafik", async () => {
    const { body } = await get("/epochs/42/metrics", 8);
    expect(body.graph).toEqual({ participants: 6, edges: 7, density: 0.2333 });
  });

  it("TC-BE-018-05 fungsi metrik langsung dengan baris FX-E42", async () => {
    const s = await fx(8);
    const epoch = row<EpochRow>(s.db, "SELECT * FROM epochs WHERE epoch = 42") as EpochRow;
    expect(computeEpochMetrics(s.db, "agents-main", epoch)).toMatchObject({
      totalVoucherValue: "190000000", cleared: "145000000", clearedRatio: 0.7632, voucherCount: 60, residualTransfers: 3,
      transferSavings: 20, debtBefore: "190000000", debtAfter: "45000000", debtReduction: 0.7632, netDebt: "45000000",
      graph: { participants: 6, edges: 7, density: 0.2333 },
    });
  });

  it("TC-BE-018-06 epoch hanya siklus", async () => {
    const setup = [
      block(1000, ...AGENTS.map((n) => ({ logs: [joinLog(n)] }))),
      block(1001, ...AGENTS.map((n) => ({ logs: [stakeLog(n)] }))),
      block(1002, ...[0, 1, 2].map((i) => ({ logs: [voucherLog(i)] }))),
      block(1003, { logs: [cutoffLog({ edge_count: 3, participant_count: 3, total_obligation: "90000000" })] }),
      block(1004, { logs: [appliedLog([1, 2, 3], { cleared_total: "90000000" }), committedLog({ positions: positions().slice(3), total_due: "0", total_claimable: "0" })] }),
    ];
    const { body } = await get("/epochs/42/metrics", 0, setup);
    expect(body).toMatchObject({ clearedRatio: 1, debtAfter: "0", residualTransfers: 0, transferSavings: null, debtReduction: 1, netDebt: "0" });
  });

  it("TC-BE-018-07 epoch kosong", async () => {
    const s = await fx(0, [block(1000, { logs: [cutoffLog({ edge_count: 0, participant_count: 0, total_obligation: "0" })] })]);
    const body = await (await fetch(`${s.srv.url}${BASE}/epochs/42/metrics`)).json();
    expect(body).toMatchObject({ totalVoucherValue: "0", clearedRatio: null, voucherCount: 0 });
    expect(body.graph).toEqual({ participants: 0, edges: 0, density: null });
  });

  it("TC-BE-018-08 bentuk field P1 hadir", async () => {
    const { body } = await get("/epochs/42/metrics", 8);
    expect(body).toHaveProperty("defaultRate", null);
    expect(body).toHaveProperty("clearingTimeSeconds");
    expect(body.clearingTimeSeconds).toBe(604);
  });

  it("TC-BE-018-09 epoch tidak ada", async () => {
    const { res, body } = await get("/epochs/99/metrics", 8);
    expect(res.status).toBe(404);
    expect(body.error.code).toBe("epoch_not_found");
  });

  it("TC-BE-018-11 epoch belum commit", async () => {
    const { res, body } = await get("/epochs/42/metrics", 3);
    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      totalVoucherValue: "190000000", voucherCount: 60, debtBefore: "190000000", graph: { participants: 6, edges: 7, density: 0.2333 },
      cleared: null, clearedRatio: null, debtAfter: null, debtReduction: null, residualTransfers: null, transferSavings: null,
      netDebt: null, defaultRate: null, clearingTimeSeconds: null,
    });
  });

  it("ratio4 membulatkan setengah ke atas dan null untuk pembagi nol", () => {
    expect(ratio4(145n, 190n)).toBe(0.7632);
    expect(ratio4(1n, 3n)).toBe(0.3333);
    expect(ratio4(1n, 0n)).toBeNull();
  });

  it("BE-019 defaultRate: null sebelum finalized, nilai default ÷ total residual sesudahnya", async () => {
    const before = await get("/epochs/42/metrics", 9);
    expect(before.body.defaultRate).toBeNull();
    const after = await get("/epochs/42/metrics", 10);
    expect(after.body.defaultRate).toBe(0.7778);
  });

  it("BE-019 defaultRate 0 untuk epoch tanpa default", async () => {
    const s = await fx(8);
    s.db.prepare("UPDATE epochs SET phase = 'finalized' WHERE epoch = 42").run();
    s.db.prepare("UPDATE settlements SET status = 'paid' WHERE status = 'due'").run();
    const body = await (await fetch(`${s.srv.url}${BASE}/epochs/42/metrics`)).json();
    expect(body.defaultRate).toBe(0);
  });
});
