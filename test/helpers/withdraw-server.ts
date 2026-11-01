import type Database from "better-sqlite3";
import { MockOneClickTransport, USDC_BASE } from "../../src/settlement/mock-transport.js";
import { OneClickClient, type OneClickTransport } from "../../src/settlement/one-click.js";
import { withdrawRoutes } from "../../src/settlement/withdraw/routes.js";
import { acct } from "./fx-log42.js";
import { fxServer } from "./fx-api.js";

export const NOW = Date.parse("2026-11-09T11:41:00Z");
export const JOB = "a83e2c41-0b5d-4f0e-8c21-6d9f7e5a1b22";

export class Recording extends MockOneClickTransport {
  failAt: "quote" | "generate-intent" | "submit-intent" | null = null;
  override async getQuote(req: Parameters<MockOneClickTransport["getQuote"]>[0]) {
    if (this.failAt === "quote") throw new Error("boom quote");
    return super.getQuote(req);
  }
  override async generateIntent() {
    if (this.failAt === "generate-intent") throw new Error("boom generate");
    return super.generateIntent();
  }
  override async submitIntent() {
    if (this.failAt === "submit-intent") throw new Error("boom submit");
    return super.submitIntent();
  }
}


export async function withdrawServer(options: { transport?: Recording; mode?: "mock" | "dry" | "live"; accountExists?: (a: string) => Promise<boolean> } = {}): Promise<{
  post: (path: string, body: unknown) => Promise<{ res: Response; json: Record<string, any> }>;
  db: Database.Database;
  transport: Recording;
  close: () => Promise<void>;
}> {
  const transport = options.transport ?? new Recording();
  const client = new OneClickClient({
    config: { mode: options.mode ?? "live", baseUrl: "mock://", jwt: undefined, appFees: [] },
    transport: transport as OneClickTransport,
    now: () => NOW,
  });
  let n = 0;
  const s = await fxServer(8, [], () => NOW, withdrawRoutes({ client, accountExists: options.accountExists ?? (async () => true), newJobId: () => (n++ === 0 ? JOB : `job-${n}`) }));
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${s.srv.url}/x207/settlement/withdraw/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { res, json: (await res.json()) as Record<string, any> };
  };
  return { post, db: s.db, transport, close: s.close };
}

export const quoteBody = (over: Record<string, unknown> = {}) => ({
  circle: "agents-main", account: acct("gpu"), destinationAsset: USDC_BASE, amount: "45000000", recipient: "0x4b2e0000000000000000000000000000000c10",
  refundTo: acct("gpu"), acceptHighFee: false, dry: true, ...over,
});
