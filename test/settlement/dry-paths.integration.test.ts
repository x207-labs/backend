import { QuoteRequest } from "@defuse-protocol/one-click-sdk-typescript";
import { describe, expect, it } from "vitest";
import { depositQuoteRoutes, nearAccountExists } from "../../src/settlement/deposit/quote.js";
import { settlementConfigFromEnv } from "../../src/settlement/config.js";
import { rpcViewFunction, simulateIntents } from "../../src/settlement/intents.js";
import { USDC_BASE, USDT_NEAR } from "../../src/settlement/mock-transport.js";
import { OneClickClient, sdkTransport, type OneClickTransport } from "../../src/settlement/one-click.js";
import { withdrawRoutes } from "../../src/settlement/withdraw/routes.js";
import { fxServer } from "../helpers/fx-api.js";
import { acct } from "../helpers/fx-log42.js";

// Opt-in: real network, no funds. Run: X207_INTEGRATION=1 npx vitest run test/settlement/dry-paths.integration.test.ts
// Only `dry` mode and `simulate_intents`: no transactions, no `dry: false` requests.
const run = process.env.X207_INTEGRATION === "1";
if (run) process.loadEnvFile(new URL("../../.env", import.meta.url));

const EVM = process.env.X207_TEST_EVM_ADDRESS ?? "0x1111111111111111111111111111111111111111";

describe.skipIf(!run)("BE-032 deposit and withdraw paths without funds (integration)", () => {
  const quotes: QuoteRequest[] = [];
  const config = () => ({ ...settlementConfigFromEnv(process.env), mode: "dry" as const });
  const recording = (): OneClickTransport => {
    const real = sdkTransport({ baseUrl: config().baseUrl, jwt: config().jwt });
    return { ...real, getQuote: (r) => (quotes.push(r), real.getQuote(r)) };
  };
  const client = () => new OneClickClient({ config: config(), transport: recording() });
  const rpc = () => process.env.NEAR_RPC_PRIMARY_URL ?? "https://rpc.mainnet.near.org";

  async function post(path: string, body: unknown, exists: (a: string) => Promise<boolean> = async () => true) {
    const c = client();
    const s = await fxServer(8, [], undefined, [...depositQuoteRoutes({ client: c, accountExists: exists }), ...withdrawRoutes({ client: c, accountExists: exists })]);
    try {
      const res = await fetch(`${s.srv.url}/x207/settlement/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { res, json: (await res.json()) as Record<string, any>, jobs: s.db.prepare("SELECT kind, status FROM settlement_jobs").all() };
    } finally {
      await s.close();
    }
  }
  const deposit = (over: Record<string, unknown> = {}) => ({
    purpose: "stake", circle: "agents-main", account: acct("scraper"), amount: "50000000", originAsset: USDC_BASE,
    refundType: "ORIGIN_CHAIN", refundTo: EVM, dry: true, ...over,
  });

  it("TC-BE-032-01 deposit quote stake and settle, job waiting_deposit", async () => {
    const stake = await post("deposit/quote", deposit());
    const settle = await post("deposit/quote", deposit({ purpose: "settle", epoch: 42, amount: undefined }));
    expect([stake.res.status, settle.res.status], JSON.stringify([stake.json, settle.json])).toEqual([201, 201]);
    expect([stake.json.status, settle.json.status]).toEqual(["waiting_deposit", "waiting_deposit"]);
    expect(settle.jobs).toEqual([{ kind: "deposit_settle", status: "waiting_deposit" }]);
  });

  it("TC-BE-032-02 withdraw quote 1 USDT to USDC Base", async () => {
    const { res, json } = await post("withdraw/quote", { circle: "agents-main", account: acct("gpu"), destinationAsset: USDC_BASE, amount: "1000000", recipient: EVM, refundTo: acct("gpu"), dry: true });
    expect(res.status, JSON.stringify(json)).toBe(201);
    expect(json.withdrawFee).toBe("2400");
  });

  it("TC-BE-032-03 simulate_intents is mapped to a clear result, without a transaction", { timeout: 60_000 }, async () => {
    const view = rpcViewFunction(rpc());
    const empty = await simulateIntents(view, []);
    expect(empty).toMatchObject({ ok: true });
    const bad = await simulateIntents(view, [{ standard: "nep413", payload: {}, public_key: "ed25519:x", signature: "ed25519:y" }]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("simulation_failed");
  });

  it("TC-BE-032-04 refundTo a NEAR account that does not exist is rejected before 1Click", { timeout: 60_000 }, async () => {
    const before = quotes.length;
    const { res, json } = await post(
      "deposit/quote",
      deposit({ refundType: "INTENTS", refundTo: "x207-no-such-account-1.near" }),
      nearAccountExists(rpc()),
    );
    expect([res.status, json.error.code]).toEqual([422, "refund_account_not_found"]);
    expect(quotes.length).toBe(before);
  });

  it("TC-BE-032-05 upstream error is mapped", async () => {
    const unsupported = await post("deposit/quote", deposit({ originAsset: "nep141:nope.near" }));
    expect([unsupported.res.status, unsupported.json.error.code]).toEqual([422, "asset_not_supported"]);
    const badAddress = await post("withdraw/quote", { circle: "agents-main", account: acct("gpu"), destinationAsset: USDC_BASE, amount: "1000000", recipient: "bukan-alamat", refundTo: acct("gpu"), dry: true });
    expect([badAddress.res.status, badAddress.json.error?.code], JSON.stringify(badAddress.json)).toEqual([502, "one_click_error"]);
    const tiny = await post("deposit/quote", deposit({ amount: "1" }));
    expect([tiny.res.status, tiny.json.error?.code], JSON.stringify(tiny.json)).toEqual([502, "one_click_error"]);
  });

  it("TC-BE-032-06 no dry:false request during the suite", () => {
    expect(quotes.length).toBeGreaterThan(0);
    for (const q of quotes) expect(q.dry).toBe(true);
    expect(USDT_NEAR).toBe("nep141:usdt.tether-token.near");
  });
});
