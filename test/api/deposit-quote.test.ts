import { QuoteRequest } from "@defuse-protocol/one-click-sdk-typescript";
import { afterEach, describe, expect, it } from "vitest";
import { depositQuoteRoutes } from "../../src/settlement/deposit/quote.js";
import { MockOneClickTransport, USDC_BASE, USDT_NEAR } from "../../src/settlement/mock-transport.js";
import { OneClickClient, type OneClickTransport } from "../../src/settlement/one-click.js";
import { fxServer } from "../helpers/fx-api.js";
import { acct } from "../helpers/fx-log42.js";

const NOW = Date.parse("2026-11-09T11:41:00Z");

class Recording extends MockOneClickTransport {
  quotes: QuoteRequest[] = [];
  override async getQuote(req: QuoteRequest) {
    this.quotes.push(req);
    return super.getQuote(req);
  }
}

describe("BE-027 POST /x207/settlement/deposit/quote", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  async function post(
    body: unknown,
    options: { transport?: OneClickTransport; exists?: (a: string) => Promise<boolean>; upTo?: number } = {},
  ) {
    const transport = options.transport ?? new Recording();
    const client = new OneClickClient({
      config: { mode: "live", baseUrl: "mock://", jwt: undefined, appFees: [] },
      transport,
      now: () => NOW,
    });
    const routes = depositQuoteRoutes({ client, accountExists: options.exists ?? (async () => true), newJobId: () => "5d0f8a52-7c1e-4a8e-9a77-1f3c2b8d9e10" });
    const s = await fxServer(options.upTo ?? 8, [], () => NOW, routes);
    close = s.close;
    const res = await fetch(`${s.srv.url}/x207/settlement/deposit/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { res, json: await res.json(), db: s.db, transport };
  }
  const stake = (over: Record<string, unknown> = {}) => ({
    purpose: "stake", circle: "agents-main", account: acct("scraper"), amount: "50000000", originAsset: USDC_BASE,
    refundType: "INTENTS", refundTo: acct("scraper"), dry: false, ...over,
  });
  const settle = (over: Record<string, unknown> = {}) => ({
    purpose: "settle", circle: "agents-main", account: acct("scraper"), epoch: 42, originAsset: USDC_BASE,
    refundType: "INTENTS", refundTo: acct("scraper"), dry: false, ...over,
  });

  it("TC-BE-027-01 stake 50 USD from USDC on Base", async () => {
    const { res, json, transport } = await post(stake());
    expect(res.status).toBe(201);
    expect(json).toMatchObject({
      jobId: "5d0f8a52-7c1e-4a8e-9a77-1f3c2b8d9e10", status: "waiting_deposit", purpose: "stake", unit: "credit", decimals: 6,
      originAsset: USDC_BASE, destinationAsset: USDT_NEAR, recipientType: "INTENTS", recipient: acct("scraper"), amountOut: "50000000",
      depositAddress: "mock-deposit-address", paymentDeadline: null,
    });
    expect(json.quoteDeadline).toMatch(/^2026-11-09T/);
    expect(json.nextSteps.join("\n")).toContain("ft_withdraw from intents.near to the NEAR account without msg");
    expect(json.nextSteps.join("\n")).toContain('{"action":"stake"}');
    const sent = (transport as Recording).quotes[0] as QuoteRequest;
    expect(sent.swapType).toBe(QuoteRequest.swapType.EXACT_OUTPUT);
    expect(sent.recipientType).toBe(QuoteRequest.recipientType.INTENTS);
  });

  it("TC-BE-027-02 settling a due amount from D9", async () => {
    const { res, json, db, transport } = await post(settle());
    expect(res.status).toBe(201);
    expect(json).toMatchObject({ amountOut: "35000000", paymentDeadline: "2026-11-09T12:00:00Z", purpose: "settle" });
    expect(json.nextSteps.join("\n")).toContain('{"action":"settle","epoch":42}');
    expect((transport as Recording).quotes[0]?.swapType).toBe(QuoteRequest.swapType.EXACT_OUTPUT);
    expect((transport as Recording).quotes[0]?.amount).toBe("35000000");
    expect(db.prepare("SELECT kind, epoch, account_id, status FROM settlement_jobs").all()).toEqual([
      { kind: "deposit_settle", epoch: 42, account_id: acct("scraper"), status: "waiting_deposit" },
    ]);
  });

  it("TC-BE-027-03 amount is ignored for settle", async () => {
    const { json } = await post(settle({ amount: "1" }));
    expect(json.amountOut).toBe("35000000");
  });

  it.each([
    ["debtor already paid", { account: acct("cleaner"), refundTo: acct("cleaner") }, 9],
    ["posisi nol", { account: acct("translator"), refundTo: acct("translator") }, 8],
  ])("TC-BE-027-04 nothing owed: %s", async (_label, over, upTo) => {
    const { res, json } = await post(settle(over), { upTo });
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("nothing_due");
  });

  it("TC-BE-027-05 a non-existent refundTo is rejected before 1Click", async () => {
    const { res, json, db, transport } = await post(stake({ refundTo: "x207-probe.near" }), { exists: async (a) => a !== "x207-probe.near" });
    expect(res.status).toBe(422);
    expect(json.error.code).toBe("refund_account_not_found");
    expect((transport as Recording).quotes).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM settlement_jobs").get()).toEqual({ n: 0 });
  });

  it("TC-BE-027-06 unsupported asset", async () => {
    const { res, json } = await post(stake({ originAsset: "nep141:unknown.near" }));
    expect(res.status).toBe(422);
    expect(json.error.code).toBe("asset_not_supported");
  });

  it.each(["amount below minimum", "invalid address"])("TC-BE-027-07/08 1Click rejects: %s", async (reason) => {
    class Rejecting extends MockOneClickTransport {
      override async getQuote(): Promise<never> {
        throw new Error(reason);
      }
    }
    const { res, json } = await post(stake(), { transport: new Rejecting() });
    expect(res.status).toBe(502);
    expect(json.error.code).toBe("one_click_error");
    expect(json.error.details.upstream).toContain(reason);
  });

  it.each([
    ["wrong purpose", stake({ purpose: "foo" })],
    ["stake without amount", stake({ amount: undefined })],
    ["settle without epoch", settle({ epoch: undefined })],
    ["zero amount", stake({ amount: "0" })],
    ["not an object", "[1,2]"],
    ["not JSON", "{oops"],
  ])("TC-BE-027-09 invalid body: %s", async (_label, body) => {
    const { res, json } = await post(body);
    expect(res.status).toBe(400);
    expect(json.error.code).toBe("invalid_request");
  });

  it("TC-BE-027-10 circle or member does not exist", async () => {
    const a = await post(stake({ circle: "nope" }));
    expect([a.res.status, a.json.error.code]).toEqual([404, "circle_not_found"]);
    await close?.();
    const b = await post(stake({ account: "nobody.near" }));
    expect([b.res.status, b.json.error.code]).toEqual([404, "member_not_found"]);
  });

  it("TC-BE-027-11 payment deadline at risk", async () => {
    class Slow extends MockOneClickTransport {
      override async getQuote(req: QuoteRequest) {
        const quote = await super.getQuote(req);
        (quote.quote as unknown as { timeEstimate: number }).timeEstimate = 2000;
        return quote;
      }
    }
    // 11:41:00 → limit 12:00:00 = 1140 seconds; estimate 2000 seconds
    const { json } = await post(settle(), { transport: new Slow() });
    expect(json.warnings).toEqual(["deadline_risk"]);
    expect(json.timeEstimateSeconds).toBe(2000);
  });

  it("dry: true (default) does not need live mode and does not show a deposit address", async () => {
    const transport = new Recording();
    const client = new OneClickClient({ config: { mode: "dry", baseUrl: "mock://", jwt: undefined, appFees: [] }, transport, now: () => NOW });
    const s = await fxServer(8, [], () => NOW, depositQuoteRoutes({ client, accountExists: async () => true }));
    close = s.close;
    const res = await fetch(`${s.srv.url}/x207/settlement/deposit/quote`, { method: "POST", body: JSON.stringify(stake({ dry: undefined })) });
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json).toMatchObject({ dry: true, depositAddress: null });
    expect(transport.quotes[0]?.dry).toBe(true);
  });

  it("dry: false outside live mode is rejected", async () => {
    const client = new OneClickClient({ config: { mode: "dry", baseUrl: "mock://", jwt: undefined, appFees: [] }, transport: new Recording(), now: () => NOW });
    const s = await fxServer(8, [], () => NOW, depositQuoteRoutes({ client, accountExists: async () => true }));
    close = s.close;
    const res = await fetch(`${s.srv.url}/x207/settlement/deposit/quote`, { method: "POST", body: JSON.stringify(stake()) });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("live_mode_disabled");
  });
});
