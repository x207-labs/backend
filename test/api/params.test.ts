import { afterEach, describe, expect, it } from "vitest";
import { block, eventLog, DEFAULT_PARAMS } from "../helpers/fx-log42.js";
import { fxServer } from "../helpers/fx-api.js";

const BASE = "/x207/circles/agents-main";

describe("BE-017 active parameters and history", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  async function get(path: string, upTo: number, extra: Parameters<typeof fxServer>[1] = []) {
    const s = await fxServer(upTo, extra);
    close = s.close;
    const res = await fetch(`${s.srv.url}${BASE}${path}`);
    return { res, body: await res.json() };
  }

  it("TC-BE-017-01 active parameters with a pending change", async () => {
    const { res, body } = await get("/params", 4);
    expect(res.status).toBe(200);
    expect(body).toEqual({
      circle: "agents-main",
      currentEpoch: 42,
      active: DEFAULT_PARAMS,
      nextEpoch: { payment_window: 2700 },
      nextEpochEffective: 43,
    });
  });

  it("TC-BE-017-02 change already in effect", async () => {
    const { body } = await get("/params", 5);
    expect(body.currentEpoch).toBe(43);
    expect(body.active.payment_window).toBe(2700);
    expect(body.nextEpoch).toBeNull();
    expect(body.nextEpochEffective).toBeNull();
  });

  it("TC-BE-017-03 D7 field names are snake_case", async () => {
    const { body } = await get("/params", 5);
    expect(Object.keys(body.active).sort()).toEqual(Object.keys(DEFAULT_PARAMS).sort());
  });

  it("TC-BE-017-04 history newest first, then the initial row", async () => {
    const { body } = await get("/params/history", 5);
    expect(body.items[0]).toMatchObject({ field: "payment_window", oldValue: 1800, newValue: 2700, effectiveEpoch: 43 });
    const initial = body.items.at(-1);
    expect(initial).toMatchObject({ oldValue: null, effectiveEpoch: 0 });
    expect(body.items).toHaveLength(10);
  });

  it("TC-BE-017-05 history pagination without duplicate items", async () => {
    const s = await fxServer(4);
    close = s.close;
    const ids: number[] = [];
    let cursor: string | null = null;
    do {
      const body: { items: { id: number }[]; nextCursor: string | null } = await (
        await fetch(`${s.srv.url}${BASE}/params/history?limit=4${cursor ? `&cursor=${cursor}` : ""}`)
      ).json();
      ids.push(...body.items.map((i) => i.id));
      cursor = body.nextCursor;
    } while (cursor);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
    expect([...ids].sort((a, b) => b - a)).toEqual(ids);
  });

  it("TC-BE-017-06 circle does not exist", async () => {
    const s = await fxServer(4);
    close = s.close;
    for (const path of ["/x207/circles/nope/params", "/x207/circles/nope/params/history"]) {
      const res = await fetch(s.srv.url + path);
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("circle_not_found");
    }
  });

  it("second proposal in the same epoch: the latest pending value wins", async () => {
    const second = block(1011, { logs: [eventLog("params_updated", { old: DEFAULT_PARAMS, new: { ...DEFAULT_PARAMS, payment_window: 2400 }, changed: ["payment_window"], effective_epoch: 43 })] });
    const { body } = await get("/params", 4, [second]);
    expect(body.nextEpoch).toEqual({ payment_window: 2400 });
  });
});
