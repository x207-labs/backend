import { afterEach, describe, expect, it } from "vitest";
import { USDC_BASE, USDT_TRON } from "../../src/settlement/mock-transport.js";
import { JOB, Recording, quoteBody, withdrawServer } from "../helpers/withdraw-server.js";

describe("BE-030 POST /x207/settlement/withdraw/*", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  async function server(options: Parameters<typeof withdrawServer>[0] = {}) {
    const s = await withdrawServer(options);
    close = s.close;
    return s;
  }

describe("BE-030 / BE-031 POST /x207/settlement/withdraw/*", () => {
  it("TC-BE-030-01 quote to USDC on Base shows withdrawFee", async () => {
    const { post, db } = await server();
    const { res, json } = await post("quote", quoteBody());
    expect(res.status).toBe(201);
    expect(json).toMatchObject({
      jobId: JOB, status: "quoted", dry: true, depositType: "INTENTS", recipientType: "DESTINATION_CHAIN", withdrawFee: "2400",
      variableFeeBpsEstimate: 14, totalFeePct: 0.1453, threshold: { chain: "base", minAmount: "250000", ok: true }, warnings: [],
      amountIn: "45000000", destinationAsset: USDC_BASE,
    });
    expect(db.prepare("SELECT kind, status, recipient_type, withdraw_fee FROM settlement_jobs").all()).toEqual([
      { kind: "withdraw", status: "quoted", recipient_type: "DESTINATION_CHAIN", withdraw_fee: "2400" },
    ]);
  });

  it("TC-BE-030-02 intent rejects a job that is not quoted yet; withdrawFee only in the quote response", async () => {
    const { post } = await server();
    const quoted = await post("quote", quoteBody());
    const intent = await post("intent", { jobId: JOB });
    expect(quoted.json.withdrawFee).toBe("2400");
    expect(intent.json.withdrawFee).toBeUndefined();
    const again = await post("intent", { jobId: JOB });
    expect(again.res.status).toBe(409);
  });

  it("TC-BE-030-03 generate intent", async () => {
    const { post, db } = await server();
    await post("quote", quoteBody());
    const { res, json } = await post("intent", { jobId: JOB });
    expect(res.status).toBe(200);
    expect(json).toEqual({ jobId: JOB, intent: { standard: "nep413", mock: true } });
    expect(db.prepare("SELECT status FROM settlement_jobs").get()).toEqual({ status: "awaiting_signature" });
  });

  it("TC-BE-030-04 submit intent", async () => {
    const { post, db } = await server();
    await post("quote", quoteBody());
    await post("intent", { jobId: JOB });
    const { res, json } = await post("submit", { jobId: JOB, signedIntent: { standard: "nep413", signature: "x" } });
    expect(res.status).toBe(202);
    expect(json).toEqual({ jobId: JOB, status: "processing", intentHash: "mock-intent-hash" });
    expect(db.prepare("SELECT status, intent_hash FROM settlement_jobs").get()).toEqual({ status: "processing", intent_hash: "mock-intent-hash" });
  });

  it("TC-BE-030-05 submit before intent", async () => {
    const { post } = await server();
    await post("quote", quoteBody());
    const { res, json } = await post("submit", { jobId: JOB, signedIntent: { a: 1 } });
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("job_state_conflict");
  });

  it("TC-BE-030-06 intent for a deposit job", async () => {
    const { post, db } = await server();
    await post("quote", quoteBody());
    db.prepare("UPDATE settlement_jobs SET kind = 'deposit_settle'").run();
    const { res, json } = await post("intent", { jobId: JOB });
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("job_state_conflict");
  });

  it("TC-BE-030-07 intent twice", async () => {
    const { post } = await server();
    await post("quote", quoteBody());
    expect((await post("intent", { jobId: JOB })).res.status).toBe(200);
    const second = await post("intent", { jobId: JOB });
    expect(second.res.status).toBe(409);
    expect(second.json.error.code).toBe("job_state_conflict");
  });

  it("TC-BE-030-08 unknown jobId", async () => {
    const { post } = await server();
    for (const path of ["intent", "submit"]) {
      const { res, json } = await post(path, { jobId: "9b0f2d3a-0000-4000-8000-000000000000", signedIntent: { a: 1 } });
      expect(res.status).toBe(404);
      expect(json.error.code).toBe("job_not_found");
    }
  });

  it("TC-BE-030-09 signedIntent missing", async () => {
    const { post } = await server();
    await post("quote", quoteBody());
    await post("intent", { jobId: JOB });
    const { res, json } = await post("submit", { jobId: JOB });
    expect(res.status).toBe(400);
    expect(json.error.code).toBe("invalid_request");
  });

  it("TC-BE-030-10 1Click error at each step, job status does not advance", async () => {
    const t = new Recording();
    const { post, db } = await server({ transport: t });
    t.failAt = "quote";
    const q = await post("quote", quoteBody());
    expect([q.res.status, q.json.error.code]).toEqual([502, "one_click_error"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM settlement_jobs").get()).toEqual({ n: 0 });
    t.failAt = null;
    await post("quote", quoteBody());
    t.failAt = "generate-intent";
    const i = await post("intent", { jobId: JOB });
    expect([i.res.status, i.json.error.code]).toEqual([502, "one_click_error"]);
    expect(db.prepare("SELECT status FROM settlement_jobs").get()).toEqual({ status: "quoted" });
    t.failAt = null;
    await post("intent", { jobId: JOB });
    t.failAt = "submit-intent";
    const s = await post("submit", { jobId: JOB, signedIntent: { a: 1 } });
    expect([s.res.status, s.json.error.code]).toEqual([502, "one_click_error"]);
    expect(db.prepare("SELECT status FROM settlement_jobs").get()).toEqual({ status: "awaiting_signature" });
  });

  it("dry mode never sends a signed intent", async () => {
    const t = new Recording();
    const { post, db } = await server({ transport: t, mode: "dry" });
    await post("quote", quoteBody());
    await post("intent", { jobId: JOB });
    const s = await post("submit", { jobId: JOB, signedIntent: { a: 1 } });
    expect([s.res.status, s.json.error.code]).toEqual([422, "live_mode_disabled"]);
    expect(db.prepare("SELECT status FROM settlement_jobs").get()).toEqual({ status: "awaiting_signature" });
  });

  it("member and circle must exist; body must be valid", async () => {
    const { post } = await server();
    expect((await post("quote", quoteBody({ circle: "nope" }))).json.error.code).toBe("circle_not_found");
    expect((await post("quote", quoteBody({ account: "ghost.near" }))).json.error.code).toBe("member_not_found");
    expect((await post("quote", quoteBody({ amount: "0" }))).res.status).toBe(400);
  });
});

  it("TC-BE-030-12 refundTo missing", async () => {
    const t = new Recording();
    const { post, db } = await server({ transport: t, accountExists: async () => false });
    const { res, json } = await post("quote", quoteBody({ refundTo: "ghost.near" }));
    expect([res.status, json.error.code]).toEqual([422, "refund_account_not_found"]);
    expect(t.requests).not.toContain("quote");
    expect(db.prepare("SELECT COUNT(*) AS n FROM settlement_jobs").get()).toEqual({ n: 0 });
  });
});
