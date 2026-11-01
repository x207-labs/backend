import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ApiError, type QuoteRequest, type QuoteResponse, type TokenResponse } from "@defuse-protocol/one-click-sdk-typescript";
import { describe, expect, it, vi } from "vitest";
import { settlementConfigFromEnv, type SettlementConfig } from "../../src/settlement/config.js";
import { SettlementError } from "../../src/settlement/errors.js";
import {
  buildFtTransferCall,
  buildFtWithdraw,
  settleMsg,
  simulateIntents,
  stakeMsg,
  type ViewFunction,
} from "../../src/settlement/intents.js";
import { MOCK_TOKENS, USDC_BASE, USDT_NEAR, USDT_TRON } from "../../src/settlement/mock-transport.js";
import { OneClickClient, type OneClickTransport, type QuoteParams } from "../../src/settlement/one-click.js";

const config = (over: Partial<SettlementConfig> = {}): SettlementConfig => ({
  mode: "dry",
  baseUrl: "https://1click.example",
  jwt: undefined,
  appFees: [],
  ...over,
});

/** Transport tiruan yang merekam request. */
function fakeTransport(over: Partial<OneClickTransport> = {}) {
  const calls = { quote: [] as QuoteRequest[], tokens: 0, status: [] as string[], generate: [] as unknown[], submit: [] as unknown[] };
  const transport: OneClickTransport = {
    getTokens: async () => {
      calls.tokens += 1;
      return MOCK_TOKENS as TokenResponse[];
    },
    getQuote: async (r) => {
      calls.quote.push(r);
      return { quote: { amountIn: r.amount, amountOut: r.amount } } as unknown as QuoteResponse;
    },
    getExecutionStatus: async (a) => {
      calls.status.push(a);
      return { status: "PROCESSING" } as never;
    },
    generateIntent: async (r) => {
      calls.generate.push(r);
      return { intent: {}, correlationId: "c" } as never;
    },
    submitIntent: async (r) => {
      calls.submit.push(r);
      return { intentHash: "h", correlationId: "c" };
    },
    ...over,
  };
  return { transport, calls };
}

const baseQuote: QuoteParams = {
  swapType: "EXACT_OUTPUT",
  originAsset: USDC_BASE,
  destinationAsset: USDT_NEAR,
  amount: "50000000",
  depositType: "ORIGIN_CHAIN",
  recipientType: "INTENTS",
  refundType: "INTENTS",
  refundTo: "scraper.x207-circle.near",
  recipient: "scraper.x207-circle.near",
};

describe("BE-025 klien E6 1Click/Intents", () => {
  it("TC-BE-025-01 versi SDK dipin tanpa ^ atau ~", () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"));
    expect(pkg.dependencies["@defuse-protocol/one-click-sdk-typescript"]).toBe("0.1.26");
    expect(pkg.dependencies["@defuse-protocol/intents-sdk"]).toBe("0.93.0");
  });

  it("TC-BE-025-02 mode mock menjawab dari FX-1C tanpa jaringan", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new OneClickClient({ config: config({ mode: "mock" }) });
    // B2.1: 0,01 USDT Intents → USDC Base
    const q = await client.quote({
      ...baseQuote,
      swapType: "EXACT_INPUT",
      originAsset: USDT_NEAR,
      destinationAsset: USDC_BASE,
      amount: "10000",
      depositType: "INTENTS",
      recipientType: "DESTINATION_CHAIN",
      recipient: "0x4b2e000000000000000000000000000000007c10",
    });
    expect(q.quote.amountOut).toBe("7582");
    expect(q.quote.withdrawFee).toBe("2400");
    const status = await client.status("mock-deposit-address");
    expect(status.status).toBe("SUCCESS");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("TC-BE-025-02b mock memuat nominal B2.1–B2.5, B1.1, B1.4, dan Tron", async () => {
    const client = new OneClickClient({ config: config({ mode: "mock" }) });
    const out = async (amount: string, dest = USDC_BASE) =>
      (
        await client.quote({
          ...baseQuote, swapType: "EXACT_INPUT", originAsset: USDT_NEAR, destinationAsset: dest, amount,
          depositType: "INTENTS", recipientType: "DESTINATION_CHAIN", recipient: "0xabc",
        })
      ).quote;
    expect((await out("100000")).amountOut).toBe("97450");
    expect((await out("250000")).amountOut).toBe("247239");
    expect((await out("1000000")).amountOut).toBe("996203");
    expect((await out("5000000")).amountOut).toBe("4990613");
    expect((await out("1000000", USDT_TRON)).withdrawFee).toBe("900000");
    const b11 = await client.quote({ ...baseQuote, swapType: "EXACT_INPUT", originAsset: USDT_NEAR, destinationAsset: USDT_NEAR, amount: "1000000" });
    expect(b11.quote.amountOut).toBe("1000000");
    const b14 = await client.quote({ ...baseQuote, swapType: "EXACT_INPUT", amount: "1000000" });
    expect(b14.quote.amountOut).toBe("1001078");
  });

  it("TC-BE-025-03 mode dry: request membawa dry true", async () => {
    const { transport, calls } = fakeTransport();
    const client = new OneClickClient({ config: config({ mode: "dry" }), transport });
    await client.quote({ ...baseQuote, dry: true });
    expect(calls.quote[0]?.dry).toBe(true);
  });

  it("TC-BE-025-04 dry:false tanpa mode live → 422 live_mode_disabled, 0 request ke 1Click", async () => {
    for (const mode of ["dry", "mock"] as const) {
      const { transport, calls } = fakeTransport();
      const client = new OneClickClient({ config: config({ mode }), transport });
      const err = await client.quote({ ...baseQuote, dry: false }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SettlementError);
      expect((err as SettlementError).code).toBe("live_mode_disabled");
      expect((err as SettlementError).status).toBe(422);
      expect(calls.tokens).toBe(0);
      expect(calls.quote).toHaveLength(0);
    }
  });

  it("TC-BE-025-05 mode live eksplisit: dry false diteruskan", async () => {
    const { transport, calls } = fakeTransport();
    const client = new OneClickClient({ config: config({ mode: "live" }), transport });
    await client.quote({ ...baseQuote, dry: false });
    expect(calls.quote[0]?.dry).toBe(false);
  });

  it("TC-BE-025-06 tanpa field dry diperlakukan dry true, juga di mode live", async () => {
    const { transport, calls } = fakeTransport();
    const client = new OneClickClient({ config: config({ mode: "live" }), transport });
    await client.quote(baseQuote);
    expect(calls.quote[0]?.dry).toBe(true);
  });

  it("TC-BE-025-07 daftar tujuan dari /v0/tokens: aset di luar daftar ditolak 422", async () => {
    const { transport, calls } = fakeTransport();
    const client = new OneClickClient({ config: config(), transport });
    const err = await client
      .quote({ ...baseQuote, destinationAsset: "nep141:nope.near" })
      .catch((e: unknown) => e);
    expect((err as SettlementError).code).toBe("asset_not_supported");
    expect((err as SettlementError).status).toBe(422);
    expect(calls.quote).toHaveLength(0);
    await expect(client.quote(baseQuote)).resolves.toBeDefined();
    expect(calls.quote).toHaveLength(1);
    expect(calls.tokens).toBe(1); // daftar di-cache
  });

  it("TC-BE-025-07b daftar tokens dimuat ulang setelah TTL", async () => {
    const { transport, calls } = fakeTransport();
    let t = 0;
    const client = new OneClickClient({ config: config(), transport, now: () => t, tokensTtlMs: 1000 });
    await client.listTokens();
    t = 999;
    await client.listTokens();
    expect(calls.tokens).toBe(1);
    t = 1000;
    await client.listTokens();
    expect(calls.tokens).toBe(2);
  });

  it("TC-BE-025-08 appFees: default kosong, lalu dari env", async () => {
    const empty = fakeTransport();
    await new OneClickClient({ config: settlementConfigFromEnv({}), transport: empty.transport }).quote(baseQuote);
    expect(empty.calls.quote[0]).not.toHaveProperty("appFees");

    const withFee = fakeTransport();
    const cfg = settlementConfigFromEnv({ X207_APP_FEES: '[{"recipient":"fee.near","fee":1}]' });
    await new OneClickClient({ config: cfg, transport: withFee.transport }).quote(baseQuote);
    expect(withFee.calls.quote[0]?.appFees).toEqual([{ recipient: "fee.near", fee: 1 }]);
  });

  it("konfigurasi env: mode default dry, nilai tak sah ditolak", () => {
    expect(settlementConfigFromEnv({}).mode).toBe("dry");
    expect(settlementConfigFromEnv({ X207_SETTLEMENT_MODE: "live" }).mode).toBe("live");
    expect(() => settlementConfigFromEnv({ X207_SETTLEMENT_MODE: "yolo" })).toThrow();
    expect(() => settlementConfigFromEnv({ X207_APP_FEES: "nope" })).toThrow();
    expect(() => settlementConfigFromEnv({ X207_APP_FEES: '[{"recipient":"a","fee":0}]' })).toThrow();
  });

  it("quote EXACT_OUTPUT ke INTENTS membawa field yang benar", async () => {
    const { transport, calls } = fakeTransport();
    const client = new OneClickClient({ config: config(), transport, now: () => Date.parse("2026-11-09T11:00:00Z") });
    await client.quote(baseQuote);
    expect(calls.quote[0]).toMatchObject({
      swapType: "EXACT_OUTPUT",
      depositType: "ORIGIN_CHAIN",
      recipientType: "INTENTS",
      refundType: "INTENTS",
      amount: "50000000",
      slippageTolerance: 100,
      deadline: "2026-11-09T11:30:00.000Z",
    });
  });

  it("TC-BE-025-09 simulate_intents: sukses apa adanya, error → simulation_failed", async () => {
    const ok: ViewFunction = vi.fn(async () => ({ intents_executed: [], logs: [] }));
    expect(await simulateIntents(ok, [])).toEqual({ ok: true, result: { intents_executed: [], logs: [] } });
    expect(ok).toHaveBeenCalledWith("intents.near", "simulate_intents", { signed: [] });
    const bad: ViewFunction = async () => {
      throw new Error("invalid signature");
    };
    expect(await simulateIntents(bad, [{}])).toEqual({ ok: false, code: "simulation_failed", message: "invalid signature" });
  });

  it("TC-BE-025-10 status, generate-intent, submit-intent memakai argumen job", async () => {
    const { transport, calls } = fakeTransport();
    const client = new OneClickClient({ config: config(), transport });
    expect((await client.status("0xdeposit")).status).toBe("PROCESSING");
    expect(calls.status).toEqual(["0xdeposit"]);
    await client.generateIntent({ depositAddress: "0xdeposit", signerId: "gpu.x207-circle.near", standard: "nep413" as never });
    expect(calls.generate[0]).toEqual({ type: "swap_transfer", depositAddress: "0xdeposit", signerId: "gpu.x207-circle.near", standard: "nep413" });
    const signed = { standard: "nep413", payload: {} } as never;
    expect(await client.submitIntent(signed)).toEqual({ intentHash: "h", correlationId: "c" });
    expect(calls.submit[0]).toEqual({ type: "swap_transfer", signedData: signed });
  });

  it("TC-BE-025-10b error upstream menjadi one_click_error dengan pesan asli", async () => {
    const apiError = new ApiError(
      { method: "POST", url: "/v0/quote" },
      { url: "/v0/quote", ok: false, status: 400, statusText: "Bad Request", body: { message: "Amount is too low for bridge, try at least 1000000" } },
      "Bad Request",
    );
    const { transport } = fakeTransport({ getQuote: async () => { throw apiError; } });
    const client = new OneClickClient({ config: config(), transport });
    const err = (await client.quote(baseQuote).catch((e: unknown) => e)) as SettlementError;
    expect(err.code).toBe("one_click_error");
    expect(err.status).toBe(502);
    expect(err.details.upstream).toBe("Amount is too low for bridge, try at least 1000000");
    expect(err.details.upstreamStatus).toBe(400);

    const net = fakeTransport({ getTokens: async () => { throw new Error("ECONNREFUSED"); } });
    const e2 = (await new OneClickClient({ config: config(), transport: net.transport }).listTokens().catch((e: unknown) => e)) as SettlementError;
    expect(e2.code).toBe("one_click_error");
    expect(e2.details.upstream).toBe("ECONNREFUSED");
  });

  it("builder ft_withdraw tanpa msg dan ft_transfer_call dengan msg stake/settle (ADR-19)", () => {
    const w = buildFtWithdraw({ receiverId: "scraper.x207-circle.near", amount: "35000000" });
    expect(w).toEqual({
      contractId: "intents.near",
      methodName: "ft_withdraw",
      args: { token: "usdt.tether-token.near", receiver_id: "scraper.x207-circle.near", amount: "35000000" },
      deposit: "1",
    });
    expect(w.args).not.toHaveProperty("msg");
    const stake = buildFtTransferCall({ receiverId: "x207-circle.near", amount: "50000000", msg: stakeMsg() });
    expect(stake.contractId).toBe("usdt.tether-token.near");
    expect(stake.methodName).toBe("ft_transfer_call");
    expect(stake.args).toEqual({ receiver_id: "x207-circle.near", amount: "50000000", msg: '{"action":"stake"}' });
    expect(settleMsg(42)).toBe('{"action":"settle","epoch":42}');
    expect(settleMsg(42, "scraper.x207-circle.near")).toBe('{"action":"settle","epoch":42,"member_id":"scraper.x207-circle.near"}');
    expect(stakeMsg("translator.x207-circle.near")).toBe('{"action":"stake","member_id":"translator.x207-circle.near"}');
    expect(buildFtWithdraw({ receiverId: "a.near", amount: "1", gas: "30000000000000" }).gas).toBe("30000000000000");
  });
});
