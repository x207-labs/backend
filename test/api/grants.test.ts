import { afterEach, describe, expect, it } from "vitest";
import { block, eventLog, acct } from "../helpers/fx-log42.js";
import { fxServer } from "../helpers/fx-api.js";
import { rebuildReadModel } from "../../src/indexer/rebuild.js";

const offered = (height: number, id: number, grantor: string, assetType = "near-rpc:access", price = "5000000") =>
  block(height, { logs: [eventLog("grant_offered", { grant_id: id, asset_type: assetType, grantor: acct(grantor), class: "B", unit: "day", unit_price: price, expires_at: "1795000000000000000" }, "0.0.6")] });
const activated = (height: number, id: number, grantee: string) =>
  block(height, { logs: [eventLog("grant_activated", { grant_id: id, grantee: acct(grantee), delivery_pubkey: "ed25519:7Yk" }, "0.0.6")] });
const revoked = (height: number, id: number, reason: string) => block(height, { logs: [eventLog("grant_revoked", { grant_id: id, reason }, "0.0.6")] });
const classSet = (height: number, assetType: string, cls: string) => block(height, { logs: [eventLog("asset_class_set", { asset_type: assetType, class: cls }, "0.0.6")] });

describe("BE-038 F8 events and GET …/grants", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  async function server() {
    const f = await fxServer(11, [
      classSet(1011, "near-rpc:access", "B"),
      offered(1012, 1, "scraper"),
      offered(1013, 2, "gpu"),
      offered(1014, 3, "scraper"),
      activated(1015, 1, "translator"),
      activated(1016, 2, "translator"),
      revoked(1017, 2, "defaulted"),
      revoked(1018, 3, "expired"),
      classSet(1019, "near-rpc:access", "C"),
    ]);
    close = f.close;
    return f;
  }
  const get = async (f: Awaited<ReturnType<typeof server>>, path: string) => {
    const res = await fetch(`${f.srv.url}/x207/circles/agents-main/${path}`);
    return { res, json: (await res.json()) as Record<string, any> };
  };

  it("TC-BE-038-01 the active grants of a grantee are listed, the revoked and the expired are not", async () => {
    const f = await server();
    const { res, json } = await get(f, `grants?grantee=${acct("translator")}&status=active`);
    expect(res.status).toBe(200);
    expect(json.items).toHaveLength(1);
    expect(json.items[0]).toMatchObject({ grantId: 1, assetType: "near-rpc:access", grantor: acct("scraper"), grantee: acct("translator"), class: "B", unit: "day", unitPrice: "5000000", status: "active", deliveryPubkey: "ed25519:7Yk", revokeReason: null });
    expect(json.items[0].expiresAt).toBe("1795000000000000000");
    const all = await get(f, `grants?grantee=${acct("translator")}`);
    expect(all.json.items.map((g: any) => [g.grantId, g.status, g.revokeReason])).toEqual([[1, "active", null], [2, "revoked", "defaulted"]]);
    const expired = await get(f, "grants?status=expired");
    expect(expired.json.items.map((g: any) => [g.grantId, g.revokeReason, g.grantee])).toEqual([[3, "expired", null]]);
    const byGrantor = await get(f, `grants?grantor=${acct("scraper")}`);
    expect(byGrantor.json.items.map((g: any) => g.grantId)).toEqual([1, 3]);
  });

  it("TC-BE-038-02 one grant by id, a missing id, a bad id and a bad status", async () => {
    const f = await server();
    const one = await get(f, "grants/2");
    expect([one.res.status, one.json.status, one.json.revokeReason]).toEqual([200, "revoked", "defaulted"]);
    const missing = await get(f, "grants/99");
    expect([missing.res.status, missing.json.error.code]).toEqual([404, "grant_not_found"]);
    expect((await get(f, "grants/zero")).res.status).toBe(400);
    const bad = await get(f, "grants?status=lent");
    expect([bad.res.status, bad.json.error.code]).toEqual([400, "invalid_request"]);
  });

  it("TC-BE-038-03 paging walks the grants in id order", async () => {
    const f = await server();
    const first = await get(f, "grants?limit=2");
    expect(first.json.items.map((g: any) => g.grantId)).toEqual([1, 2]);
    expect(first.json.nextCursor).not.toBeNull();
    const second = await get(f, `grants?limit=2&cursor=${first.json.nextCursor}`);
    expect(second.json.items.map((g: any) => g.grantId)).toEqual([3]);
    expect(second.json.nextCursor).toBeNull();
  });

  it("TC-BE-038-04 asset_class_set keeps the newest class, every F8 event is handled, a rebuild gives the same rows", async () => {
    const f = await server();
    expect(f.db.prepare("SELECT asset_type, class FROM asset_classes").all()).toEqual([{ asset_type: "near-rpc:access", class: "C" }]);
    const events = f.db.prepare("SELECT DISTINCT event, handled FROM events_raw WHERE event LIKE 'grant_%' OR event = 'asset_class_set' ORDER BY event").all();
    expect(events).toEqual([
      { event: "asset_class_set", handled: 1 }, { event: "grant_activated", handled: 1 }, { event: "grant_offered", handled: 1 }, { event: "grant_revoked", handled: 1 },
    ]);
    const before = f.db.prepare("SELECT * FROM grants ORDER BY grant_id").all();
    rebuildReadModel(f.db, "agents-main");
    expect(f.db.prepare("SELECT * FROM grants ORDER BY grant_id").all()).toEqual(before);
    expect(f.db.prepare("SELECT asset_type, class FROM asset_classes").all()).toEqual([{ asset_type: "near-rpc:access", class: "C" }]);
  });
});
