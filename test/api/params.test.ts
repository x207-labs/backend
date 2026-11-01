import { afterEach, describe, expect, it } from "vitest";
import { block, eventLog, DEFAULT_PARAMS } from "../helpers/fx-log42.js";
import { fxServer } from "../helpers/fx-api.js";

const BASE = "/x207/circles/agents-main";

describe("BE-017 parameter aktif dan riwayat", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  async function get(path: string, upTo: number, extra: Parameters<typeof fxServer>[1] = []) {
    const s = await fxServer(upTo, extra);
    close = s.close;
    const res = await fetch(`${s.srv.url}${BASE}${path}`);
    return { res, body: await res.json() };
  }

  it("TC-BE-017-01 parameter aktif dengan perubahan tertunda", async () => {
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

  it("TC-BE-017-02 perubahan sudah berlaku", async () => {
    const { body } = await get("/params", 5);
    expect(body.currentEpoch).toBe(43);
    expect(body.active.payment_window).toBe(2700);
    expect(body.nextEpoch).toBeNull();
    expect(body.nextEpochEffective).toBeNull();
  });

  it("TC-BE-017-03 nama field D7 snake_case", async () => {
    const { body } = await get("/params", 5);
    expect(Object.keys(body.active).sort()).toEqual(Object.keys(DEFAULT_PARAMS).sort());
  });

  it("TC-BE-017-04 riwayat terbaru dulu, lalu baris awal", async () => {
    const { body } = await get("/params/history", 5);
    expect(body.items[0]).toMatchObject({ field: "payment_window", oldValue: 1800, newValue: 2700, effectiveEpoch: 43 });
    const initial = body.items.at(-1);
    expect(initial).toMatchObject({ oldValue: null, effectiveEpoch: 0 });
    expect(body.items).toHaveLength(10);
  });

  it("TC-BE-017-05 paginasi riwayat tanpa item ganda", async () => {
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

  it("TC-BE-017-06 lingkaran tidak ada", async () => {
    const s = await fxServer(4);
    close = s.close;
    for (const path of ["/x207/circles/nope/params", "/x207/circles/nope/params/history"]) {
      const res = await fetch(s.srv.url + path);
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("circle_not_found");
    }
  });

  it("usulan kedua di epoch yang sama: nilai tertunda terbaru menang", async () => {
    const second = block(1011, { logs: [eventLog("params_updated", { old: DEFAULT_PARAMS, new: { ...DEFAULT_PARAMS, payment_window: 2400 }, changed: ["payment_window"], effective_epoch: 43 })] });
    const { body } = await get("/params", 4, [second]);
    expect(body.nextEpoch).toEqual({ payment_window: 2400 });
  });
});
