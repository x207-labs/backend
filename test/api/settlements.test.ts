import { afterEach, describe, expect, it } from "vitest";
import { acct } from "../helpers/fx-log42.js";
import { fxServer } from "../helpers/fx-api.js";

const BASE = "/x207/circles/agents-main";

describe("BE-016 settlement per anggota dan per epoch", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  async function get(path: string, upTo: number, extra: Parameters<typeof fxServer>[1] = []) {
    const s = await fxServer(upTo, extra);
    close = s.close;
    const res = await fetch(`${s.srv.url}${BASE}${path}`);
    return { res, body: await res.json(), db: s.db };
  }
  const gpu = `/members/${acct("gpu")}/settlements`;

  it("TC-BE-016-01 kreditor selama payment_window", async () => {
    const { res, body } = await get(gpu, 9);
    expect(res.status).toBe(200);
    expect(body.items[0]).toEqual({
      epoch: 42, phase: "payment_window", role: "creditor", net: "+45000000", amount: "45000000", status: "claimable",
      claimableNow: false, destination: null, txHash: null,
    });
  });

  it("TC-BE-016-02 kreditor setelah finalisasi", async () => {
    const { body } = await get(gpu, 10);
    expect(body.items[0]).toMatchObject({ status: "claimable", claimableNow: true, phase: "finalized" });
  });

  it("TC-BE-016-03 kreditor setelah klaim", async () => {
    const { body } = await get(gpu, 11);
    expect(body.items[0]).toMatchObject({ status: "claimed", destination: "intents", claimableNow: false });
    expect(body.items[0].txHash).toEqual(expect.any(String));
  });

  it("TC-BE-016-04 debtor due", async () => {
    const { body } = await get(`/members/${acct("scraper")}/settlements`, 8);
    expect(body.items[0]).toEqual({
      epoch: 42, phase: "payment_window", role: "debtor", net: "-35000000", amount: "35000000", status: "due",
      claimableNow: false, destination: null, txHash: null, due: "2026-11-09T12:00:00Z", paidAmount: "0", stakeSlashed: "0", haircut: "0",
    });
  });

  it("TC-BE-016-05 debtor default", async () => {
    const { body } = await get(`/members/${acct("scraper")}/settlements`, 10);
    expect(body.items[0]).toMatchObject({ status: "defaulted", stakeSlashed: "35000000" });
  });

  it("TC-BE-016-06 filter status", async () => {
    const { body } = await get(`/members/${acct("cleaner")}/settlements?status=paid`, 9);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ epoch: 42, status: "paid", paidAmount: "10000000" });
    const none = await fetch(`${(await fxServer(9)).srv.url}${BASE}${gpu}?status=bogus`);
    expect(none.status).toBe(400);
  });

  it("TC-BE-016-07 urutan epoch turun dan paginasi", async () => {
    const s = await fxServer(8);
    close = s.close;
    const ins = s.db.prepare(
      "INSERT INTO settlements (circle_id, epoch, account_id, role, net, amount, cleared, status, updated_block) VALUES ('agents-main', ?, ?, 'creditor', 5, 5, 0, 'claimed', 1)",
    );
    for (const e of [40, 41]) {
      s.db.prepare("INSERT INTO epochs (circle_id, epoch, phase) VALUES ('agents-main', ?, 'finalized')").run(e);
      ins.run(e, acct("gpu"));
    }
    const first = await (await fetch(`${s.srv.url}${BASE}${gpu}?limit=2`)).json();
    expect(first.items.map((i: { epoch: number }) => i.epoch)).toEqual([42, 41]);
    const second = await (await fetch(`${s.srv.url}${BASE}${gpu}?limit=2&cursor=${first.nextCursor}`)).json();
    expect(second.items.map((i: { epoch: number }) => i.epoch)).toEqual([40]);
    expect(second.nextCursor).toBeNull();
  });

  it("TC-BE-016-08 anggota tidak ada", async () => {
    const { res, body } = await get("/members/nobody.near/settlements", 8);
    expect(res.status).toBe(404);
    expect(body.error.code).toBe("member_not_found");
  });

  it("TC-BE-016-09 settlement per epoch", async () => {
    const { res, body } = await get("/epochs/42/settlements", 8);
    expect(res.status).toBe(200);
    expect(body.items).toHaveLength(6);
    expect(body.items.map((i: { account: string }) => i.account)).toEqual(
      ["cleaner", "gpu", "image", "scraper", "summarizer", "translator"].map(acct),
    );
    const translator = body.items.find((i: { account: string }) => i.account === acct("translator"));
    expect(translator).toMatchObject({ role: "none", net: "0", status: null, amount: "0" });
  });

  it("TC-BE-016-10 paginasi per epoch 4/2", async () => {
    const s = await fxServer(8);
    close = s.close;
    const first = await (await fetch(`${s.srv.url}${BASE}/epochs/42/settlements?limit=4`)).json();
    expect(first.items).toHaveLength(4);
    const second = await (await fetch(`${s.srv.url}${BASE}/epochs/42/settlements?limit=4&cursor=${first.nextCursor}`)).json();
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
  });

  it("TC-BE-016-11 epoch tidak ada", async () => {
    const { res, body } = await get("/epochs/99/settlements", 8);
    expect(res.status).toBe(404);
    expect(body.error.code).toBe("epoch_not_found");
  });

  it("filter status per epoch", async () => {
    const { body } = await get("/epochs/42/settlements?status=due", 8);
    expect(body.items.map((i: { account: string }) => i.account)).toEqual([acct("cleaner"), acct("scraper")]);
  });

});
