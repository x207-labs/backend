import { afterEach, describe, expect, it } from "vitest";
import { block, eventLog, acct } from "../helpers/fx-log42.js";
import { fxServer } from "../helpers/fx-api.js";

const offered = (h: number, id: number) =>
  block(h, { logs: [eventLog("grant_offered", { grant_id: id, asset_type: "near-rpc:access", grantor: acct("scraper"), class: "B", unit: "day", unit_price: "1", expires_at: "1795000000000000000" }, "0.0.6")] });
const activated = (h: number, id: number) => block(h, { logs: [eventLog("grant_activated", { grant_id: id, grantee: acct("translator"), delivery_pubkey: null }, "0.0.6")] });

describe("BK-003 GET …/events", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  async function server() {
    const f = await fxServer(11, [offered(1011, 1), offered(1012, 2), activated(1013, 1), activated(1014, 2)]);
    close = f.close;
    return f;
  }
  const get = async (f: Awaited<ReturnType<typeof server>>, query = "") => {
    const res = await fetch(`${f.srv.url}/x207/circles/agents-main/events${query}`);
    return { res, json: (await res.json()) as Record<string, any> };
  };

  it("TC-BK-003-01 events come in the order they happened and the filter keeps only the named ones", async () => {
    const f = await server();
    const { json } = await get(f, "?event=grant_activated");
    expect(json.items.map((e: any) => [e.event, e.data.grant_id, e.blockHeight])).toEqual([["grant_activated", 1, 1013], ["grant_activated", 2, 1014]]);
    expect(json.items[0]).toMatchObject({ logIndex: 0, data: { grantee: acct("translator") } });
    expect(typeof json.items[0].receiptId).toBe("string");
    const both = await get(f, "?event=grant_offered,grant_activated");
    expect(both.json.items.map((e: any) => e.blockHeight)).toEqual([1011, 1012, 1013, 1014]);
  });

  it("TC-BK-003-02 the cursor continues after the last event shown and never repeats one", async () => {
    const f = await server();
    const first = await get(f, "?event=grant_offered,grant_activated&limit=3");
    expect(first.json.items).toHaveLength(3);
    expect(first.json.more).toBe(true);
    const second = await get(f, `?event=grant_offered,grant_activated&limit=3&cursor=${first.json.nextCursor}`);
    expect(second.json.items.map((e: any) => e.blockHeight)).toEqual([1014]);
    expect(second.json.more).toBe(false);
    const end = await get(f, `?event=grant_offered,grant_activated&cursor=${second.json.nextCursor}`);
    expect(end.json.items).toEqual([]);
    expect(end.json.nextCursor).toBeNull();
  });

  it("TC-BK-003-03 a bad event name and a bad cursor are 400", async () => {
    const f = await server();
    expect((await get(f, "?event=drop table")).res.status).toBe(400);
    expect((await get(f, "?cursor=!!")).res.status).toBe(400);
  });
});
