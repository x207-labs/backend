import { describe, expect, it } from "vitest";
import { SettlementError } from "../../src/settlement/errors.js";
import { checkSignedPayload, mtNotification, planResidualBatches, runResidualBatch, type ResidualTransfer, type SignedPayload } from "../../src/settlement/residual/batch.js";

const CIRCLE = "x207-circle.near";
const VERIFIER = "intents.near";
const positions = [
  { account: "scraper.near", amount: 40_000_000n },
  { account: "gpu.near", amount: 15_000_000n },
  { account: "zero.near", amount: 0n },
  { account: "cleaner.near", amount: 5_000_000n },
];

const signedFor = (t: ResidualTransfer, patch: Record<string, unknown> = {}): SignedPayload => ({
  payload: { message: JSON.stringify({ signer_id: t.debtor, verifying_contract: VERIFIER, deadline: "2026-11-05T10:00:00Z", intents: [t.intent], ...patch }) },
  signature: "ed25519:x",
});

describe("BE-034 plan", () => {
  it("TC-BE-034-01 one transfer per debtor to the circle with the settle msg, zero amounts left out, sorted by account", () => {
    const [batch] = planResidualBatches(positions, { circleContract: CIRCLE, epoch: 42 });
    expect(batch!.map((t) => [t.debtor, t.amount])).toEqual([["cleaner.near", "5000000"], ["gpu.near", "15000000"], ["scraper.near", "40000000"]]);
    expect(batch![0]!.intent).toEqual({
      intent: "transfer", receiver_id: CIRCLE, tokens: { "nep141:usdt.tether-token.near": "5000000" }, msg: '{"action":"settle","epoch":42}',
    });
  });

  it("TC-BE-034-02 more debtors than maxPerCall make several calls; a bad maxPerCall is refused", () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ account: `d${i}.near`, amount: 1n }));
    expect(planResidualBatches(many, { circleContract: CIRCLE, epoch: 1, maxPerCall: 3 }).map((b) => b.length)).toEqual([3, 3, 1]);
    expect(planResidualBatches(many, { circleContract: CIRCLE, epoch: 1 }).map((b) => b.length)).toEqual([5, 2]);
    expect(() => planResidualBatches(many, { circleContract: CIRCLE, epoch: 1, maxPerCall: 0 })).toThrow(RangeError);
    expect(planResidualBatches([], { circleContract: CIRCLE, epoch: 1 })).toEqual([]);
  });
});

describe("BE-034 signed payload check", () => {
  const [[transfer]] = planResidualBatches([{ account: "gpu.near", amount: 15_000_000n }], { circleContract: CIRCLE, epoch: 42 }) as [[ResidualTransfer]];

  it("TC-BE-034-03 accepts the planned transfer and refuses another signer, amount, receiver, msg or a second intent", () => {
    expect(checkSignedPayload(signedFor(transfer), transfer, VERIFIER)).toEqual({ ok: true, debtor: "gpu.near" });
    const altered = (patch: object) => checkSignedPayload(signedFor(transfer, { intents: [{ ...transfer.intent, ...patch }] }), transfer, VERIFIER);
    expect(altered({ tokens: { "nep141:usdt.tether-token.near": "1" } })).toMatchObject({ ok: false });
    expect(altered({ receiver_id: "evil.near" })).toMatchObject({ ok: false });
    expect(altered({ msg: '{"action":"stake"}' })).toMatchObject({ ok: false });
    expect(checkSignedPayload(signedFor(transfer, { signer_id: "scraper.near" }), transfer, VERIFIER)).toMatchObject({ ok: false, reason: expect.stringContaining("signer_id") });
    expect(checkSignedPayload(signedFor(transfer, { verifying_contract: "other.near" }), transfer, VERIFIER)).toMatchObject({ ok: false });
    expect(checkSignedPayload(signedFor(transfer, { intents: [transfer.intent, transfer.intent] }), transfer, VERIFIER)).toMatchObject({ ok: false });
    expect(checkSignedPayload({ payload: { message: "nope" } }, transfer, VERIFIER)).toMatchObject({ ok: false });
    expect(checkSignedPayload({}, transfer, VERIFIER)).toMatchObject({ ok: false });
  });

  it("TC-BE-034-04 key order inside the intent does not matter", () => {
    const shuffled = { msg: transfer.intent.msg, tokens: transfer.intent.tokens, receiver_id: transfer.intent.receiver_id, intent: "transfer" };
    expect(checkSignedPayload(signedFor(transfer, { intents: [shuffled] }), transfer, VERIFIER)).toMatchObject({ ok: true });
  });
});

describe("BE-034 run", () => {
  const [batch] = planResidualBatches(positions, { circleContract: CIRCLE, epoch: 42 }) as [ResidualTransfer[]];
  const allSigned = new Map(batch.map((t) => [t.debtor, signedFor(t)]));
  const okView = async (_c: string, method: string) => {
    expect(method).toBe("simulate_intents");
    return { report: {}, invariant_violated: null, state: { fee: 1, current_salt: "252812b3" } };
  };

  it("TC-BE-034-05 dry and mock stop after a passing simulation and never execute", async () => {
    let executed = 0;
    for (const mode of ["dry", "mock"] as const) {
      const result = await runResidualBatch(batch, { mode, verifier: VERIFIER, view: okView, signed: allSigned, execute: async () => (executed += 1, "tx") });
      expect(result).toMatchObject({ status: "dry_run_ok", debtors: ["cleaner.near", "gpu.near", "scraper.near"] });
    }
    expect(executed).toBe(0);
  });

  it("TC-BE-034-06 a missing or wrong payload rejects the batch before any simulation", async () => {
    let simulated = 0;
    const view = async () => (simulated += 1, {});
    const partial = new Map(allSigned);
    partial.delete("gpu.near");
    partial.set("scraper.near", signedFor(batch[2]!, { signer_id: "x.near" }));
    const result = await runResidualBatch(batch, { mode: "dry", verifier: VERIFIER, view, signed: partial });
    expect(result).toMatchObject({ status: "rejected" });
    expect((result as { problems: unknown[] }).problems).toHaveLength(2);
    expect(simulated).toBe(0);
  });

  it("TC-BE-034-07 a failing simulation or a violated invariant stops live mode too", async () => {
    let executed = 0;
    const execute = async () => (executed += 1, "tx");
    const failing = await runResidualBatch(batch, { mode: "live", verifier: VERIFIER, view: async () => { throw new Error("nonce reused"); }, signed: allSigned, execute });
    expect(failing).toEqual({ status: "simulation_failed", message: "nonce reused" });
    const violated = await runResidualBatch(batch, { mode: "live", verifier: VERIFIER, view: async () => ({ invariant_violated: { unmatched_deltas: {} } }), signed: allSigned, execute });
    expect(violated).toMatchObject({ status: "invariant_violated" });
    expect(executed).toBe(0);
  });

  it("TC-BE-034-08 live executes once, then reconciles: a debtor still due stays pending", async () => {
    const statuses: Record<string, string[]> = { "cleaner.near": ["paid"], "gpu.near": ["due", "paid"], "scraper.near": ["due", "due", "due"] };
    const read = (d: string) => statuses[d]!.shift() ?? "due";
    const sent: number[] = [];
    const result = await runResidualBatch(batch, {
      mode: "live", verifier: VERIFIER, view: okView, signed: allSigned, execute: async (s) => (sent.push(s.length), "tx-1"), readStatus: async (d) => read(d),
      attempts: 3, sleep: async () => {},
    });
    expect(sent).toEqual([3]);
    expect(result).toEqual({
      status: "executed", debtors: ["cleaner.near", "gpu.near", "scraper.near"], txHash: "tx-1",
      outcomes: [{ debtor: "cleaner.near", status: "paid" }, { debtor: "gpu.near", status: "paid" }, { debtor: "scraper.near", status: "pending" }],
    });
  });

  it("TC-BE-034-09 live without an execute function is live_mode_disabled", async () => {
    await expect(runResidualBatch(batch, { mode: "live", verifier: VERIFIER, view: okView, signed: allSigned })).rejects.toBeInstanceOf(SettlementError);
  });

  it("TC-BE-034-10 dry shows the mt_on_transfer notification of each debtor exactly as Intents will send it, and sends nothing", async () => {
    const result = await runResidualBatch(batch, { mode: "dry", verifier: VERIFIER, view: okView, signed: allSigned });
    expect(result).toMatchObject({ status: "dry_run_ok" });
    const notifications = (result as { notifications: unknown[] }).notifications;
    expect(notifications).toEqual(batch.map(mtNotification));
    expect(notifications[1]).toEqual({
      debtor: "gpu.near",
      args: {
        sender_id: "gpu.near", previous_owner_ids: ["gpu.near"], token_ids: ["nep141:usdt.tether-token.near"], amounts: ["15000000"], msg: '{"action":"settle","epoch":42}',
      },
    });
  });

  it("TC-BE-034-11 mock delivers each notification to the circle and reconciles: a refusal leaves only that debtor pending", async () => {
    const delivered: string[] = [];
    const deliver = async (n: { debtor: string; args: { amounts: string[] } }) => {
      if (n.debtor === "gpu.near") throw new Error("ERR_UNDERPAYMENT: sent 14000000 due 15000000");
      delivered.push(n.debtor);
      return n.debtor === "scraper.near" ? "5000000" : "0";
    };
    const result = await runResidualBatch(batch, {
      mode: "mock", verifier: VERIFIER, view: okView, signed: allSigned, deliver, readStatus: async (d) => (d === "gpu.near" ? "due" : "paid"),
    });
    expect(delivered).toEqual(["cleaner.near", "scraper.near"]);
    expect(result).toMatchObject({
      status: "mock_run",
      outcomes: [
        { debtor: "cleaner.near", status: "paid", refunded: "0" },
        { debtor: "gpu.near", status: "pending", error: expect.stringContaining("ERR_UNDERPAYMENT") },
        { debtor: "scraper.near", status: "paid", refunded: "5000000" },
      ],
    });
  });

  it("TC-BE-034-12 mock never delivers when the simulation fails or a payload is wrong", async () => {
    let delivered = 0;
    const deliver = async () => (delivered += 1, "0");
    await runResidualBatch(batch, { mode: "mock", verifier: VERIFIER, view: async () => { throw new Error("nonce reused"); }, signed: allSigned, deliver });
    const partial = new Map(allSigned);
    partial.delete("gpu.near");
    await runResidualBatch(batch, { mode: "mock", verifier: VERIFIER, view: okView, signed: partial, deliver });
    expect(delivered).toBe(0);
  });

  it("TC-BE-034-13 dry plans withdraw_intents_balance after the payments and before any claim, for the whole amount of the batch", async () => {
    const result = await runResidualBatch(batch, { mode: "dry", verifier: VERIFIER, view: okView, signed: allSigned });
    expect(result).toMatchObject({ status: "dry_run_ok", withdrawal: { status: "planned", method: "withdraw_intents_balance", expected: "60000000" } });
  });

  it("TC-BE-034-14 mock withdraws what the circle kept (transfers minus refunds of the debtors that were paid), once, after the deliveries", async () => {
    const order: string[] = [];
    const result = await runResidualBatch(batch, {
      mode: "mock", verifier: VERIFIER, view: okView, signed: allSigned,
      deliver: async (n) => (order.push(`deliver:${n.debtor}`), n.debtor === "scraper.near" ? "5000000" : "0"),
      readStatus: async (d) => (d === "gpu.near" ? "due" : "paid"),
      withdraw: async () => (order.push("withdraw"), "..."),
    });
    // cleaner 5 + scraper 40 - 5 refunded = 40; gpu is still due and is not counted
    expect(order).toEqual(["deliver:cleaner.near", "deliver:gpu.near", "deliver:scraper.near", "withdraw"]);
    expect(result).toMatchObject({ status: "mock_run", withdrawal: { status: "done", amount: "..." } });
    const planned = await runResidualBatch(batch, {
      mode: "mock", verifier: VERIFIER, view: okView, signed: allSigned, deliver: async () => "0", readStatus: async (d) => (d === "gpu.near" ? "due" : "paid"),
    });
    expect(planned).toMatchObject({ withdrawal: { status: "planned", expected: "45000000" } });
  });

  it("TC-BE-034-15 mock: nothing paid means nothing to withdraw; a failing withdrawal is reported and does not hide the outcomes", async () => {
    let withdrawn = 0;
    const none = await runResidualBatch(batch, {
      mode: "mock", verifier: VERIFIER, view: okView, signed: allSigned, deliver: async () => { throw new Error("ERR_UNDERPAYMENT"); }, withdraw: async () => (withdrawn += 1, "0"),
    });
    expect(none).toMatchObject({ status: "mock_run" });
    expect((none as { withdrawal?: unknown }).withdrawal).toBeUndefined();
    expect(withdrawn).toBe(0);
    const failing = await runResidualBatch(batch, {
      mode: "mock", verifier: VERIFIER, view: okView, signed: allSigned, deliver: async () => "0", readStatus: async () => "paid", withdraw: async () => { throw new Error("ERR_WITHDRAW_IN_FLIGHT"); },
    });
    expect(failing).toMatchObject({ status: "mock_run", withdrawal: { status: "failed", error: "ERR_WITHDRAW_IN_FLIGHT" } });
    expect((failing as { outcomes: unknown[] }).outcomes).toHaveLength(3);
  });
});
