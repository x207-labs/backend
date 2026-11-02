import { describe, expect, it } from "vitest";
import { MockOneClickTransport, USDC_BASE } from "../../src/settlement/mock-transport.js";
import { OneClickClient } from "../../src/settlement/one-click.js";
import { listen } from "../helpers/d9-fixtures.js";
import { fxServer } from "../helpers/fx-api.js";
import { acct } from "../helpers/fx-log42.js";

describe("settlement worker routes on the API server", () => {
  it("createApiServer serves deposit quote, withdraw quote and job status when `settlement` is given", async () => {
    const base = await fxServer(8);
    const client = new OneClickClient({ config: { mode: "mock", baseUrl: "mock://", jwt: undefined, appFees: [] }, transport: new MockOneClickTransport() });
    const srv = await listen({ db: base.db, settlement: { client, accountExists: async () => true } });
    try {
      const post = (path: string, body: unknown) =>
        fetch(`${srv.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const deposit = await post("/x207/settlement/deposit/quote", {
        purpose: "stake", circle: "agents-main", account: acct("scraper"), amount: "50000000", originAsset: USDC_BASE,
        refundType: "INTENTS", refundTo: acct("scraper"),
      });
      expect(deposit.status).toBe(201);
      const withdraw = await post("/x207/settlement/withdraw/quote", {
        circle: "agents-main", account: acct("gpu"), destinationAsset: USDC_BASE, amount: "45000000", recipient: "0xabc", refundTo: acct("gpu"),
      });
      expect(withdraw.status).toBe(201);
      const job = (await withdraw.json()) as { jobId: string };
      const status = await fetch(`${srv.url}/x207/settlement/jobs/${job.jobId}`);
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({ kind: "withdraw", status: "quoted" });
    } finally {
      await srv.close();
      await base.close();
    }
  });

  it("without `settlement` the worker paths do not exist", async () => {
    const base = await fxServer(8);
    try {
      const res = await fetch(`${base.srv.url}/x207/settlement/withdraw/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(res.status).toBe(404);
    } finally {
      await base.close();
    }
  });
});
