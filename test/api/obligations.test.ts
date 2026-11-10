import { afterEach, describe, expect, it } from "vitest";
import { acct, block, voucherLog } from "../helpers/fx-log42.js";
import { fxServer } from "../helpers/fx-api.js";

const BASE = "/x207/circles/agents-main";

describe("BE-015 GET …/epochs/{n}/obligations", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  // The clock of the server. The scenario FX-LOG42 has epoch 42 closed at 11:19:56 with its proposal deadline at 11:29:56 on 2026-11-09, so the phase `clearing`
  // holds only before that: a test that wants it gives `at` (a fixed instant), it never reads the real clock.
  const CLEARING_AT = Date.parse("2026-11-09T11:25:00Z");
  async function get(path: string, upTo = 5, extra: Parameters<typeof fxServer>[1] = [], at?: number) {
    const s = await fxServer(upTo, extra, at === undefined ? undefined : () => at);
    close = s.close;
    const res = await fetch(`${s.srv.url}${BASE}${path}`);
    return { res, body: await res.json() };
  }

  it("TC-BE-015-01 cutoff snapshot (default)", async () => {
    const { res, body } = await get("/epochs/42/obligations", 5, [], CLEARING_AT);
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ circle: "agents-main", epoch: 42, phase: "clearing", stage: "cutoff", unit: "credit", decimals: 6, edgeCount: 7, totalObligation: "190000000" });
    expect(body.edges).toHaveLength(7);
    expect(body.edges.map((e: { debtor: string; creditor: string }) => `${e.debtor}>${e.creditor}`)).toEqual(
      [...body.edges.map((e: { debtor: string; creditor: string }) => `${e.debtor}>${e.creditor}`)].sort(),
    );
    for (const e of body.edges) {
      expect(e.cleared).toBeNull();
      expect(e.remaining).toBe(e.amount);
      expect(typeof e.seq).toBe("number");
    }
  });

  it("TC-BE-015-02 totals match", async () => {
    const { body } = await get("/epochs/42/obligations");
    expect(body.edges.reduce((s: bigint, e: { amount: string }) => s + BigInt(e.amount), 0n)).toBe(BigInt(body.totalObligation));
    expect(body.edges.length).toBe(body.edgeCount);
  });

  it("TC-BE-015-03 cutoff while the epoch is still open: 409 epoch_not_closed", async () => {
    const { res, body } = await get("/epochs/43/obligations?stage=cutoff");
    expect(res.status).toBe(409);
    expect(body.error.code).toBe("epoch_not_closed");
  });

  it("TC-BE-015-04 live: edges of the running epoch without cleared", async () => {
    const extra = [block(1011, { logs: [voucherLog(0, { epoch: 43 }), voucherLog(3, { epoch: 43 })] })];
    const { res, body } = await get("/epochs/43/obligations?stage=live", 5, extra);
    expect(res.status).toBe(200);
    expect(body.edges).toHaveLength(2);
    expect(body.edges.every((e: { cleared: null }) => e.cleared === null)).toBe(true);
    expect(body.edgeCount).toBe(2);
  });

  it("TC-BE-015-05 cleared after commit", async () => {
    const { body } = await get("/epochs/42/obligations?stage=cleared", 8);
    const byPair = Object.fromEntries(body.edges.map((e: { debtor: string; creditor: string }) => [`${e.debtor}>${e.creditor}`, e]));
    expect(byPair[`${acct("scraper")}>${acct("gpu")}`]).toMatchObject({ cleared: "15000000", remaining: "35000000" });
    expect(byPair[`${acct("cleaner")}>${acct("gpu")}`]).toMatchObject({ cleared: "5000000", remaining: "10000000" });
    for (const pair of ["translator>summarizer", "summarizer>image", "image>translator", "gpu>cleaner", "cleaner>scraper"]) {
      const [d, c] = pair.split(">") as [string, string];
      expect(byPair[`${acct(d)}>${acct(c)}`].remaining).toBe("0");
    }
  });

  it("TC-BE-015-06 cleared before commit: edges empty", async () => {
    const { res, body } = await get("/epochs/42/obligations?stage=cleared", 5);
    expect(res.status).toBe(200);
    expect(body.edges).toEqual([]);
  });

  it("TC-BE-015-07 unknown stage", async () => {
    const { res, body } = await get("/epochs/42/obligations?stage=foo");
    expect(res.status).toBe(400);
    expect(body.error.code).toBe("invalid_request");
  });

  it("TC-BE-015-08 epoch does not exist", async () => {
    const { res, body } = await get("/epochs/99/obligations");
    expect(res.status).toBe(404);
    expect(body.error).toMatchObject({ code: "epoch_not_found", details: { circle: "agents-main", epoch: 99 } });
  });

  it("TC-BE-015-09 current = largest epoch", async () => {
    const { res, body } = await get("/epochs/current/obligations?stage=cutoff");
    expect(res.status).toBe(409);
    expect(body.error.details.epoch).toBe(43);
  });

  it("{n} is not an integer: 400", async () => {
    const { res } = await get("/epochs/abc/obligations");
    expect(res.status).toBe(400);
  });
});
