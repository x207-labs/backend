import { afterEach, describe, expect, it } from "vitest";
import { block, eventLog, acct } from "../helpers/fx-log42.js";
import { fxServer } from "../helpers/fx-api.js";
import { rebuildReadModel } from "../../src/indexer/rebuild.js";

const V = "0.0.10";
const offered = (h: number, id: number) =>
  block(h, { logs: [eventLog("grant_offered", { grant_id: id, asset_type: "rwa:bond", grantor: acct("scraper"), class: "A", unit: "once", unit_price: "10000000", expires_at: "1795000000000000000" }, V)] });
const nftHeld = (h: number, id: number) => block(h, { logs: [eventLog("escrow_held", { grant_id: id, nft_contract: "nft.test.near", token_id: `t${id}` }, V)] });
const ftHeld = (h: number, id: number, amount = "1000") => block(h, { logs: [eventLog("ft_escrow_held", { grant_id: id, ft_contract: "rwa.test.near", amount }, V)] });
const registered = (h: number, payer: string, seq: number, cumulative: string, debt: string) =>
  block(h, { logs: [eventLog("voucher_registered", { payer: acct(payer), payee: acct("scraper"), epoch: 42, seq, cumulative_amount: cumulative, delta: "10000000", obligation: cumulative, outstanding_debt: debt, mode: "cumulative" }, V)] });
const failed = (h: number, payer: string, reverted: boolean, step = "complete", id = 1) =>
  block(h, { logs: [eventLog("escrow_failed", { grant_id: id, step, epoch: 42, payer: acct(payer), payee: acct("scraper"), delta: reverted ? "10000000" : "0", reverted }, V)] });
const activated = (h: number, id = 1) => block(h, { logs: [eventLog("grant_activated", { grant_id: id, grantee: acct("gpu"), delivery_pubkey: null }, V)] });
const revoked = (h: number, id = 1) => block(h, { logs: [eventLog("grant_revoked", { grant_id: id, reason: "grantor" }, V)] });

describe("BE-046 ft_escrow_held and the escrow of a token in D9", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  async function server(extra: ReturnType<typeof block>[]) {
    const f = await fxServer(11, extra);
    close = f.close;
    return f;
  }
  const escrowOf = async (f: Awaited<ReturnType<typeof server>>, id: number) => {
    const res = await fetch(`${f.srv.url}/x207/circles/agents-main/grants/${id}`);
    return ((await res.json()) as { escrow: unknown }).escrow;
  };

  it("TC-BE-046-01 a token escrow is read as kind ft with the exact amount in token units; an NFT escrow says kind nft", async () => {
    const f = await server([offered(1011, 1), ftHeld(1012, 1, "123456789012345678901"), offered(1013, 2), nftHeld(1014, 2)]);
    expect(await escrowOf(f, 1)).toEqual({ kind: "ft", ftContract: "rwa.test.near", amount: "123456789012345678901", state: "held" });
    expect(await escrowOf(f, 2)).toEqual({ kind: "nft", nftContract: "nft.test.near", tokenId: "t2", state: "held" });
    const list = (await (await fetch(`${f.srv.url}/x207/circles/agents-main/grants`)).json()) as { items: Array<{ grantId: number; escrow: { kind: string } }> };
    expect(list.items.map((g) => [g.grantId, g.escrow.kind])).toEqual([[1, "ft"], [2, "nft"]]);
    expect(f.db.prepare("SELECT event, handled FROM events_raw WHERE event = 'ft_escrow_held'").all()).toEqual([{ event: "ft_escrow_held", handled: 1 }]);
  });

  it("TC-BE-046-02 delivered, cancelled, a failed payment taken back, and a payment that stays (stuck) work the same as for an NFT", async () => {
    const delivered = await server([offered(1011, 1), ftHeld(1012, 1), registered(1013, "gpu", 1, "10000000", "10000000"), activated(1014)]);
    expect(((await escrowOf(delivered, 1)) as { state: string }).state).toBe("delivered");
    await close?.();
    const cancelled = await server([offered(1011, 1), ftHeld(1012, 1), revoked(1013)]);
    expect(((await escrowOf(cancelled, 1)) as { state: string }).state).toBe("cancelled");
    await close?.();
    const taken = await server([offered(1011, 1), ftHeld(1012, 1), registered(1013, "gpu", 1, "10000000", "10000000"), failed(1014, "gpu", true)]);
    expect(((await escrowOf(taken, 1)) as { state: string }).state).toBe("held");
    expect(taken.db.prepare("SELECT COUNT(*) AS n FROM obligations WHERE epoch = 42 AND debtor = ? AND creditor = ?").get(acct("gpu"), acct("scraper"))).toEqual({ n: 0 });
    expect((taken.db.prepare("SELECT outstanding_debt AS d FROM members WHERE account_id = ?").get(acct("gpu")) as { d: number }).d).toBe(0);
    await close?.();
    const stuck = await server([offered(1011, 1), ftHeld(1012, 1), registered(1013, "gpu", 1, "10000000", "10000000"), failed(1014, "gpu", false)]);
    expect(((await escrowOf(stuck, 1)) as { state: string }).state).toBe("stuck");
    await close?.();
    const cancelFailed = await server([offered(1011, 1), ftHeld(1012, 1), failed(1013, "scraper", false, "cancel")]);
    expect(((await escrowOf(cancelFailed, 1)) as { state: string }).state).toBe("held");
  });

  it("TC-BE-046-03 a repeated event changes nothing and a rebuild gives the same rows", async () => {
    const f = await server([offered(1011, 1), ftHeld(1012, 1), ftHeld(1013, 1, "999"), offered(1014, 2), nftHeld(1015, 2), activated(1016, 2)]);
    const before = f.db.prepare("SELECT * FROM escrows ORDER BY grant_id").all();
    expect(before).toHaveLength(2);
    expect(before[0]).toMatchObject({ kind: "ft", ft_contract: "rwa.test.near", amount: "1000", nft_contract: null, token_id: null, state: "held" });
    rebuildReadModel(f.db, "agents-main");
    expect(f.db.prepare("SELECT * FROM escrows ORDER BY grant_id").all()).toEqual(before);
  });

  const mtHeld = (h: number, id: number, token = "nep141:usdc.test.near", amount = "1000") =>
    block(h, { logs: [eventLog("mt_escrow_held", { grant_id: id, mt_contract: "mt.test.near", token_id: token, amount }, V)] });

  it("TC-BE-048-01 a multi-token escrow is read as kind mt with the contract, the token and the exact amount; the other kinds are unchanged", async () => {
    const f = await server([offered(1011, 1), mtHeld(1012, 1, "nep141:usdc.test.near", "123456789012345678901"), offered(1013, 2), ftHeld(1014, 2), offered(1015, 3), nftHeld(1016, 3)]);
    expect(await escrowOf(f, 1)).toEqual({ kind: "mt", mtContract: "mt.test.near", tokenId: "nep141:usdc.test.near", amount: "123456789012345678901", state: "held" });
    expect(await escrowOf(f, 2)).toEqual({ kind: "ft", ftContract: "rwa.test.near", amount: "1000", state: "held" });
    expect(await escrowOf(f, 3)).toEqual({ kind: "nft", nftContract: "nft.test.near", tokenId: "t3", state: "held" });
    expect(f.db.prepare("SELECT event, handled FROM events_raw WHERE event = 'mt_escrow_held'").all()).toEqual([{ event: "mt_escrow_held", handled: 1 }]);
  });

  it("TC-BE-048-02 delivered, cancelled, a failed payment taken back, stuck and a failed cancel work the same for a multi-token", async () => {
    const delivered = await server([offered(1011, 1), mtHeld(1012, 1), registered(1013, "gpu", 1, "10000000", "10000000"), activated(1014)]);
    expect(((await escrowOf(delivered, 1)) as { state: string }).state).toBe("delivered");
    await close?.();
    const cancelled = await server([offered(1011, 1), mtHeld(1012, 1), revoked(1013)]);
    expect(((await escrowOf(cancelled, 1)) as { state: string }).state).toBe("cancelled");
    await close?.();
    const taken = await server([offered(1011, 1), mtHeld(1012, 1), registered(1013, "gpu", 1, "10000000", "10000000"), failed(1014, "gpu", true)]);
    expect(((await escrowOf(taken, 1)) as { state: string }).state).toBe("held");
    expect(taken.db.prepare("SELECT COUNT(*) AS n FROM obligations WHERE epoch = 42 AND debtor = ? AND creditor = ?").get(acct("gpu"), acct("scraper"))).toEqual({ n: 0 });
    await close?.();
    const stuck = await server([offered(1011, 1), mtHeld(1012, 1), registered(1013, "gpu", 1, "10000000", "10000000"), failed(1014, "gpu", false)]);
    expect(((await escrowOf(stuck, 1)) as { state: string }).state).toBe("stuck");
    await close?.();
    const cancelFailed = await server([offered(1011, 1), mtHeld(1012, 1), failed(1013, "scraper", false, "cancel")]);
    expect(((await escrowOf(cancelFailed, 1)) as { state: string }).state).toBe("held");
  });

  it("TC-BE-048-03 a repeated event changes nothing, a bad amount halts the indexer, and a rebuild gives the same rows", async () => {
    const f = await server([offered(1011, 1), mtHeld(1012, 1), mtHeld(1013, 1, "nep141:other.test.near", "999")]);
    const before = f.db.prepare("SELECT * FROM escrows ORDER BY grant_id").all();
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ kind: "mt", mt_contract: "mt.test.near", token_id: "nep141:usdc.test.near", amount: "1000", nft_contract: null, ft_contract: null, state: "held" });
    rebuildReadModel(f.db, "agents-main");
    expect(f.db.prepare("SELECT * FROM escrows ORDER BY grant_id").all()).toEqual(before);
    await close?.();
    await expect(server([offered(1011, 1), mtHeld(1012, 1, "nep141:usdc.test.near", "0")])).rejects.toThrow(/amount/);
  });
});
