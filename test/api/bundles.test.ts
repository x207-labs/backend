import { afterEach, describe, expect, it } from "vitest";
import { block, eventLog, acct } from "../helpers/fx-log42.js";
import { fxServer } from "../helpers/fx-api.js";

const legs = (n: number) => [
  { payer: acct("scraper"), payee: acct("gpu"), max_amount: String(n * 1_000_000) },
  { payer: acct("gpu"), payee: acct("scraper"), max_amount: "2000000" },
];
const committed = (height: number, id: number | string, hash: string, epoch = 42) =>
  block(height, { logs: [eventLog("bundle_committed", { bundle_id: id, terms_hash: hash, epoch, legs: legs(id as number), solver: acct("cleaner") })] });

describe("BE-036 bundle_committed and GET …/bundles", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  async function server(extra = [committed(1012, 1, "aa".repeat(32)), committed(1013, 2, "bb".repeat(32))]) {
    const f = await fxServer(11, extra);
    close = f.close;
    return f;
  }
  const get = async (f: Awaited<ReturnType<typeof server>>, query = "") => {
    const res = await fetch(`${f.srv.url}/x207/circles/agents-main/bundles${query}`);
    return { res, json: (await res.json()) as Record<string, any> };
  };

  it("TC-BE-036-01 an active bundle and its legs are read back, newest first", async () => {
    const f = await server();
    const { res, json } = await get(f, "?status=active");
    expect(res.status).toBe(200);
    expect(json.items.map((b: { bundleId: number }) => b.bundleId)).toEqual([2, 1]);
    expect(json.items[1]).toMatchObject({ bundleId: 1, termsHash: "aa".repeat(32), epoch: 42, solver: acct("cleaner"), status: "active" });
    expect(json.items[1].legs).toEqual([
      { payer: acct("scraper"), payee: acct("gpu"), maxAmount: "1000000" },
      { payer: acct("gpu"), payee: acct("scraper"), maxAmount: "2000000" },
    ]);
    expect(json.nextCursor).toBeNull();
  });

  it("TC-BE-036-02 the event is handled and a replay does not duplicate the bundle", async () => {
    const f = await server([committed(1012, 1, "aa".repeat(32))]);
    expect(f.db.prepare("SELECT event, handled FROM events_raw WHERE event = 'bundle_committed'").all()).toEqual([{ event: "bundle_committed", handled: 1 }]);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM bundles").get()).toEqual({ n: 1 });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM bundle_legs").get()).toEqual({ n: 2 });
  });

  it("TC-BE-036-03 paging and a status the API does not know", async () => {
    const f = await server();
    const first = await get(f, "?limit=1");
    expect(first.json.items.map((b: { bundleId: number }) => b.bundleId)).toEqual([2]);
    expect(first.json.nextCursor).not.toBeNull();
    const second = await get(f, `?limit=1&cursor=${first.json.nextCursor}`);
    expect(second.json.items.map((b: { bundleId: number }) => b.bundleId)).toEqual([1]);
    const bad = await get(f, "?status=settled");
    expect([bad.res.status, bad.json.error.code]).toEqual([400, "invalid_request"]);
  });

  it("TC-BE-036-04 no bundle gives an empty list and bundle_id may be a string", async () => {
    const f = await server([committed(1012, "7" as unknown as number, "cc".repeat(32))]);
    const { json } = await get(f);
    expect(json.items.map((b: { bundleId: number }) => b.bundleId)).toEqual([7]);
    await close?.();
    const empty = await server([]);
    expect((await get(empty)).json.items).toEqual([]);
  });
});
