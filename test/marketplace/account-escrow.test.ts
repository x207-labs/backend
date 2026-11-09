import { afterEach, describe, expect, it } from "vitest";
import { CIRCLE, NOW_S, signedListing, startMarket, type Market } from "./helpers.js";
import { ACCOUNT_ASSET_TYPES, type AccountHistory } from "../../src/marketplace/account-escrow.js";
import { CATALOG } from "../helpers/asset-catalog.js";

const PRICE = "100000000";
let nonce = 0;
const SOLD = "old-shop.testnet";

/** BE-110 (P1, contract 0.0.18): the listing of a NEAR account. The rules are those of the ADR `docs/adr-0.0.18.md` (1.3, 1.4, 1.1). */
describe("BE-110 listing of a NEAR account", () => {
  let market: Market | undefined;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });

  async function start(history?: AccountHistory, inactive: string[] = []) {
    market = await startMarket(["andi", "budi", "citra"], inactive, undefined, history === undefined ? {} : { accountHistory: history });
    for (const t of Object.keys(ACCOUNT_ASSET_TYPES)) {
      market.db.prepare("INSERT INTO asset_classes (circle_id, asset_type, class, block_height, receipt_id, log_index) VALUES (?, ?, 'A', 1, 'r', 0)").run(CIRCLE, t);
    }
    // the members of startMarket are not admitted by the fixture; budi is the one that is admitted and sellable
    market.db.prepare("UPDATE members SET admitted = 1 WHERE circle_id = ? AND account_id = ?").run(CIRCLE, `budi.x207-circle.near`);
    return market;
  }

  const post = (m: Market, o: { type: string; detail?: unknown; account?: string; seller?: string; cls?: string; quantity?: number }) =>
    m.post("/listings", signedListing(m, o.seller ?? "andi", {
      offer: { asset_type: o.type, asset_class: (o.cls ?? "A") as "A", quantity: o.quantity ?? 1, value: PRICE },
      detail: typeof o.detail === "string" ? o.detail : JSON.stringify(o.detail ?? { account_id: o.account ?? SOLD }),
      expires_at: NOW_S + 3600, nonce: `n${++nonce}`,
    }));
  const err = (r: { status: number; json: any }) => [r.status, r.json.error?.code];

  it("TC-BE-110-00 the asset types are those of the catalog (#11, #12, #13); #14 is the entry that the owner registers (ADR 1.4)", () => {
    const names = new Set(CATALOG.map((c: { assetType: string }) => c.assetType));
    for (const t of ["near:named-account", "chain-signatures:derived-address", "vesting:transferable-lockup"]) expect(names.has(t), t).toBe(true);
    expect(Object.keys(ACCOUNT_ASSET_TYPES).sort()).toEqual(["chain-signatures:derived-address", "near:account", "near:member_account", "near:named-account", "vesting:transferable-lockup"]);
  });

  it("TC-BE-110-01 a named account that is not a member is accepted; the scope is exactly account_id (display keys are not checked)", async () => {
    const m = await start();
    expect((await post(m, { type: "near:named-account" })).status).toBe(201);
    expect((await post(m, { type: "vesting:transferable-lockup", detail: { account_id: "lockup.near", kind: "account", display: "lockup of 1000" } })).status).toBe(201);
  });

  it("TC-BE-110-02 a wrong scope is refused: no account_id, another key, a bad id, text that is not JSON", async () => {
    const m = await start();
    expect(err(await post(m, { type: "near:named-account", detail: {} }))).toEqual([400, "scope_invalid"]);
    expect(err(await post(m, { type: "near:named-account", detail: { account_id: SOLD, ft_contract: "x.near" } }))).toEqual([400, "scope_invalid"]);
    expect(err(await post(m, { type: "near:named-account", detail: { account_id: "Not An Account" } }))).toEqual([400, "scope_invalid"]);
    expect(err(await post(m, { type: "near:named-account", detail: "plain text" }))).toEqual([400, "scope_invalid"]);
  });

  it("TC-BE-110-03 the class must be A, the quantity 1, and the asset type registered as class A (ERR_ASSET_CLASS on the contract)", async () => {
    const m = await start();
    expect(err(await post(m, { type: "near:named-account", cls: "B" }))).toEqual([400, "scope_invalid"]);
    expect(err(await post(m, { type: "near:named-account", quantity: 2 }))).toEqual([400, "scope_invalid"]);
    m.db.prepare("DELETE FROM asset_classes WHERE circle_id = ? AND asset_type = 'near:named-account'").run(CIRCLE);
    expect(err(await post(m, { type: "near:named-account" }))).toEqual([400, "scope_invalid"]);
  });

  it("TC-BE-110-04 the seller is not the account that is sold (ERR_ACCOUNT_SELF): the buyer pays the seller", async () => {
    const m = await start();
    expect(err(await post(m, { type: "near:named-account", account: "andi.x207-circle.near" }))).toEqual([400, "account_self_sale"]);
  });

  it("TC-BE-110-05 an account that is a member is sold only as near:member_account (a named account that is a member is refused)", async () => {
    const m = await start();
    expect(err(await post(m, { type: "near:named-account", account: "budi.x207-circle.near" }))).toEqual([400, "account_is_member"]);
    expect(err(await post(m, { type: "chain-signatures:derived-address", account: "budi.x207-circle.near" }))).toEqual([400, "account_is_member"]);
  });

  it("TC-BE-110-06 near:member_account (#14): an active member is accepted (the `admitted` flag is not read: the contract does not, and an open circle never sets it); a stranger, a suspended or a leaving member is not", async () => {
    const m = await start(undefined, ["dewi"]);
    expect((await post(m, { type: "near:member_account", account: "budi.x207-circle.near" })).status).toBe(201);
    expect(err(await post(m, { type: "near:member_account", account: SOLD }))).toEqual([400, "account_not_member"]);
    expect(err(await post(m, { type: "near:member_account", account: "dewi.x207-circle.near" }))).toEqual([400, "account_not_sellable"]);
    expect((await post(m, { type: "near:member_account", account: "citra.x207-circle.near" })).status).toBe(201); // active, never admitted: an open circle
    m.db.prepare("UPDATE members SET admitted = 1, exit_requested_epoch = 44 WHERE circle_id = ? AND account_id = ?").run(CIRCLE, "citra.x207-circle.near");
    expect(err(await post(m, { type: "near:member_account", account: "citra.x207-circle.near" }))).toEqual([400, "account_not_sellable"]); // asked to leave
  });

  it("TC-BE-110-07 #12: without an index of MPC calls the listing is refused (fail closed); the dry run says the same", async () => {
    const m = await start();
    expect(err(await post(m, { type: "chain-signatures:derived-address" }))).toEqual([501, "account_history_not_configured"]);
    const dry = await m.post("/listings/check", signedListing(m, "andi", { offer: { asset_type: "chain-signatures:derived-address", asset_class: "A", quantity: 1, value: PRICE }, detail: JSON.stringify({ account_id: SOLD }), expires_at: NOW_S + 3600, nonce: "dry" }));
    expect(err(dry)).toEqual([501, "account_history_not_configured"]);
  });

  it("TC-BE-110-08 #12: any sign call to the MPC contract refuses the listing; zero is accepted; an index that answers incomplete or fails is not proof", async () => {
    const asked: string[] = [];
    let answer: () => Promise<{ count: number; complete: boolean }> = () => Promise.resolve({ count: 0, complete: true });
    const m = await start({ signCalls: (id) => (asked.push(id), answer()) });
    expect((await post(m, { type: "chain-signatures:derived-address" })).status).toBe(201);
    expect(asked).toEqual([SOLD]);
    answer = () => Promise.resolve({ count: 1, complete: true });
    const used = await post(m, { type: "chain-signatures:derived-address", account: "used.testnet" });
    expect(err(used)).toEqual([409, "account_has_sign_history"]);
    expect(used.json.error.details).toMatchObject({ account: "used.testnet", signCalls: 1 });
    answer = () => Promise.resolve({ count: 0, complete: false });
    expect(err(await post(m, { type: "chain-signatures:derived-address", account: "partial.testnet" }))).toEqual([503, "account_history_unavailable"]);
    answer = () => Promise.reject(new Error("index down"));
    expect(err(await post(m, { type: "chain-signatures:derived-address", account: "down.testnet" }))).toEqual([503, "account_history_unavailable"]);
  });

  it("TC-BE-110-09 the sign history is asked only for #12, not for a named account or a member account", async () => {
    const asked: string[] = [];
    const m = await start({ signCalls: (id) => (asked.push(id), Promise.resolve({ count: 9, complete: true })) });
    expect((await post(m, { type: "near:named-account" })).status).toBe(201);
    expect((await post(m, { type: "near:member_account", account: "budi.x207-circle.near" })).status).toBe(201);
    expect(asked).toEqual([]);
  });
});
