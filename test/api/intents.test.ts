import { afterEach, describe, expect, it } from "vitest";
import { block, eventLog, acct } from "../helpers/fx-log42.js";
import { fxServer } from "../helpers/fx-api.js";
import { rebuildReadModel } from "../../src/indexer/rebuild.js";

const V = "0.0.9";
const H = (n: number): string => n.toString(16).padStart(64, "0");
const posted = (height: number, hash: string, who: string) => block(height, { logs: [eventLog("intent_posted", { intent_hash: hash, account_id: acct(who), posted_at: "1795000000000000000" }, V)] });
const removed = (height: number, hash: string, who: string) => block(height, { logs: [eventLog("intent_removed", { intent_hash: hash, account_id: acct(who) }, V)] });
const withdrawn = (height: number, amount: string) => block(height, { logs: [eventLog("intents_withdrawn", { amount }, V)] });

describe("BE-036 events 0.0.9 intent_posted, intent_removed, intents_withdrawn and the routes", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  async function server() {
    const f = await fxServer(11, [
      posted(1011, H(1), "translator"),
      posted(1012, H(2), "translator"),
      posted(1013, H(3), "scraper"),
      removed(1014, H(2), "translator"),
      removed(1015, H(99), "translator"),
      withdrawn(1016, "30000000"),
      withdrawn(1017, "12500000"),
    ]);
    close = f.close;
    return f;
  }
  const get = async (f: Awaited<ReturnType<typeof server>>, path: string) => {
    const res = await fetch(`${f.srv.url}/x207/circles/agents-main/${path}`);
    return { res, json: (await res.json()) as Record<string, any> };
  };

  it("TC-BE-036-01 a removed intent leaves the posted list and shows under removed; an unknown removal is ignored", async () => {
    const f = await server();
    const live = await get(f, "intents/hashes");
    expect(live.res.status).toBe(200);
    expect(live.json.items.map((i: any) => i.intentHash)).toEqual([H(3), H(1)]);
    const gone = await get(f, "intents/hashes?status=removed");
    expect(gone.json.items.map((i: any) => [i.intentHash, i.accountId, i.status, i.changedBlock])).toEqual([[H(2), acct("translator"), "removed", 1014]]);
    const mine = await get(f, `intents/hashes?account=${acct("translator")}`);
    expect(mine.json.items.map((i: any) => i.intentHash)).toEqual([H(1)]);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM intent_book WHERE intent_hash = ?").get(H(99))).toEqual({ n: 0 });
    expect(f.db.prepare("SELECT handled FROM events_raw WHERE event = 'intent_removed' ORDER BY rowid").all()).toEqual([{ handled: 1 }, { handled: 1 }]);
  });

  it("TC-BE-036-02 withdrawals come newest first with the total; paging and a bad status", async () => {
    const f = await server();
    const { res, json } = await get(f, "intents/withdrawals");
    expect(res.status).toBe(200);
    expect(json.withdrawals).toBe(2);
    expect(json.totalWithdrawn).toEqual(expect.anything());
    expect(json.items.map((w: any) => w.changedBlock)).toEqual([1017, 1016]);
    const first = await get(f, "intents/withdrawals?limit=1");
    expect(first.json.items).toHaveLength(1);
    expect(first.json.nextCursor).not.toBeNull();
    const second = await get(f, `intents/withdrawals?limit=1&cursor=${first.json.nextCursor}`);
    expect(second.json.items.map((w: any) => w.changedBlock)).toEqual([1016]);
    expect(second.json.nextCursor).toBeNull();
    const bad = await get(f, "intents/hashes?status=lent");
    expect([bad.res.status, bad.json.error.code]).toEqual([400, "invalid_request"]);
  });

  it("TC-BE-036-03 a removed hash can be posted again; a rebuild gives the same rows", async () => {
    const f = await fxServer(11, [posted(1011, H(1), "translator"), removed(1012, H(1), "translator"), posted(1013, H(1), "translator"), withdrawn(1014, "1")]);
    close = f.close;
    expect(f.db.prepare("SELECT status FROM intent_book").all()).toEqual([{ status: "posted" }]);
    const before = f.db.prepare("SELECT * FROM intent_book").all();
    const beforeW = f.db.prepare("SELECT * FROM intent_withdrawals").all();
    rebuildReadModel(f.db, "agents-main");
    expect(f.db.prepare("SELECT * FROM intent_book").all()).toEqual(before);
    expect(f.db.prepare("SELECT * FROM intent_withdrawals").all()).toEqual(beforeW);
    expect(beforeW).toHaveLength(1);
  });
});
