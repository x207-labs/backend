import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { QuoteRequest } from "@defuse-protocol/one-click-sdk-typescript";
import { settlementConfigFromEnv } from "../../src/settlement/config.js";
import { buildDepositSteps } from "../../src/settlement/deposit/steps.js";
import { MockOneClickTransport, USDC_BASE, USDT_NEAR, USDT_TRON } from "../../src/settlement/mock-transport.js";
import { OneClickClient, type OneClickTransport } from "../../src/settlement/one-click.js";
import { depositQuoteRoutes } from "../../src/settlement/deposit/quote.js";
import { fxServer } from "../helpers/fx-api.js";
import { acct } from "../helpers/fx-log42.js";

const circle = "x207-circle.near";
const job = (over: Record<string, unknown> = {}) =>
  ({ kind: "deposit_stake", status: "ready_withdraw", account_id: acct("scraper"), epoch: null, amount_out: "50000000", ...over }) as never;

describe("BE-029 jalur masuk ADR-19", () => {
  it("TC-BE-029-01 semua quote deposit ke INTENTS dengan tujuan USDT NEAR", async () => {
    const sent: QuoteRequest[] = [];
    class Rec extends MockOneClickTransport {
      override async getQuote(req: QuoteRequest) {
        sent.push(req);
        return super.getQuote(req);
      }
    }
    const client = new OneClickClient({ config: { mode: "live", baseUrl: "mock://", jwt: undefined, appFees: [] }, transport: new Rec() as OneClickTransport });
    const s = await fxServer(8, [], undefined, depositQuoteRoutes({ client, accountExists: async () => true }));
    try {
      for (const body of [
        { purpose: "stake", amount: "50000000", originAsset: USDC_BASE },
        { purpose: "stake", amount: "1000000", originAsset: USDT_TRON },
        { purpose: "settle", epoch: 42, originAsset: USDC_BASE },
      ]) {
        const res = await fetch(`${s.srv.url}/x207/settlement/deposit/quote`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ circle: "agents-main", account: acct("scraper"), refundType: "INTENTS", refundTo: acct("scraper"), dry: true, ...body }),
        });
        expect(res.status).toBe(201);
      }
    } finally {
      await s.close();
    }
    expect(sent).toHaveLength(3);
    for (const req of sent) {
      expect(req.recipientType).toBe(QuoteRequest.recipientType.INTENTS);
      expect(req.destinationAsset).toBe(USDT_NEAR);
    }
  });

  it("TC-BE-029-02 ft_withdraw ke akun NEAR pemilik tanpa msg", () => {
    const [withdraw] = buildDepositSteps({ job: job({ amount_out: "35000000" }), owner: acct("scraper"), circleContractId: circle });
    expect(withdraw).toEqual({
      contractId: "intents.near", methodName: "ft_withdraw", deposit: "1",
      args: { token: "usdt.tether-token.near", receiver_id: acct("scraper"), amount: "35000000" },
    });
    expect(Object.keys(withdraw.args)).not.toContain("msg");
  });

  it("TC-BE-029-03 ft_transfer_call stake, dengan dan tanpa member_id", () => {
    const [, own] = buildDepositSteps({ job: job(), owner: acct("scraper"), circleContractId: circle });
    expect(own).toMatchObject({ contractId: "usdt.tether-token.near", methodName: "ft_transfer_call", args: { receiver_id: circle, amount: "50000000", msg: '{"action":"stake"}' } });
    const [, agent] = buildDepositSteps({ job: job(), owner: "owner.near", circleContractId: circle });
    expect(JSON.parse(agent.args.msg as string)).toEqual({ action: "stake", member_id: acct("scraper") });
  });

  it("TC-BE-029-04 ft_transfer_call settle epoch 42 sebesar due", () => {
    const [, settle] = buildDepositSteps({ job: job({ kind: "deposit_settle", epoch: 42, amount_out: "35000000" }), owner: "owner.near", circleContractId: circle });
    expect(settle.args).toEqual({ receiver_id: circle, amount: "35000000", msg: `{"action":"settle","epoch":42,"member_id":"${acct("scraper")}"}` });
  });

  it("langkah hanya untuk job deposit yang ready_withdraw", () => {
    expect(() => buildDepositSteps({ job: job({ status: "waiting_deposit" }), owner: "a.near", circleContractId: circle })).toThrow(/ready_withdraw/);
    expect(() => buildDepositSteps({ job: job({ kind: "withdraw" }), owner: "a.near", circleContractId: circle })).toThrow(/withdraw/);
  });

  it("TC-BE-029-05 worker tidak menerima kunci pemilik", () => {
    const config = settlementConfigFromEnv({ X207_SETTLEMENT_MODE: "dry", OWNER_PRIVATE_KEY: "ed25519:x" } as never);
    expect(Object.keys(config).sort()).toEqual(["appFees", "baseUrl", "jwt", "mode"]);
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
      });
    for (const file of [...walk("src/settlement"), ...walk("src/api")]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/process\.env\.\w*(PRIVATE|SECRET|SEED|SIGNER)\w*/i);
      expect(source, file).not.toMatch(/\b(privateKey|private_key|secretKey|KeyPair\.from)/);
    }
  });
});
