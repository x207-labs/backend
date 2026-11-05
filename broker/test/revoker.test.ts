import { describe, expect, it } from "vitest";
import { Dispatcher } from "../src/dispatcher.js";
import { ClassBAdapter, DAY_MS } from "../src/keys/class-b.js";
import { Revoker } from "../src/revoker.js";
import { BrokerStore } from "../src/store.js";
import { FakeChain, grant, GRANTEE, KEY, NOW } from "./helpers.js";

function setup() {
  const chain = new FakeChain();
  const store = new BrokerStore(":memory:");
  const clock = { now: NOW };
  const classB = new ClassBAdapter({ chain, store, viewAccessKey: async () => null, now: () => clock.now });
  const dispatcher = new Dispatcher({ chain, adapters: { B: classB } });
  const log: string[] = [];
  const revoker = new Revoker({ chain, store, classB, activeGrantIdsOf: chain.activeIdsOf, now: () => clock.now, log: (l) => log.push(l) });
  return { chain, store, clock, dispatcher, revoker, log };
}

async function leased(ctx: ReturnType<typeof setup>, g = grant()) {
  ctx.chain.grants.set(g.grant_id, g);
  await ctx.dispatcher.deliver(g.grant_id);
}

describe("BK-007 revocation", () => {
  it("TC-BK-007-01 a lease that was not renewed loses its key and the grant is revoked as operator", async () => {
    const ctx = setup();
    await leased(ctx);
    expect((await ctx.revoker.sweep()).closed).toEqual([]);
    ctx.clock.now = NOW + DAY_MS + 1;
    const report = await ctx.revoker.sweep();
    expect(report.closed).toEqual([{ grantId: 1, reason: "operator", keyDeleted: true, revoked: true }]);
    expect(ctx.chain.keys.has(KEY)).toBe(false);
    expect(ctx.chain.calls).toContain("revoke:1:operator");
    expect(ctx.store.lease(1)!.closed).toBe(true);
    expect((await ctx.revoker.sweep()).closed).toEqual([]);
  });

  it("TC-BK-007-02 a renewed lease keeps its key; at expires_at the key goes and the grant is expired", async () => {
    const ctx = setup();
    await leased(ctx);
    ctx.clock.now = NOW + DAY_MS - 1000;
    await ctx.dispatcher.deliver(1);
    ctx.clock.now = NOW + DAY_MS + 1;
    expect((await ctx.revoker.sweep()).closed).toEqual([]);
    ctx.chain.now = NOW + 11 * DAY_MS;
    const report = await ctx.revoker.sweep();
    expect(report.closed).toMatchObject([{ grantId: 1, reason: "expired", keyDeleted: true, revoked: true }]);
    expect(ctx.chain.calls).toContain("revoke:1:expired");
  });

  it("TC-BK-007-03 a defaulted lessee loses the keys of all its active grants; others are untouched", async () => {
    const ctx = setup();
    await leased(ctx, grant({ grant_id: 1 }));
    await leased(ctx, grant({ grant_id: 2, delivery_pubkey: "ed25519:2222222222222222222222222222222222222222222" }));
    await leased(ctx, grant({ grant_id: 3, grantee: "gpu.x207-circle.near", delivery_pubkey: "ed25519:3333333333333333333333333333333333333333333" }));
    const report = await ctx.revoker.onDefault(GRANTEE);
    expect(report.closed.map((c) => [c.grantId, c.reason, c.keyDeleted, c.revoked])).toEqual([[1, "defaulted", true, true], [2, "defaulted", true, true]]);
    expect(ctx.chain.keys.has(KEY)).toBe(false);
    expect(ctx.chain.keys.size).toBe(1);
    expect(ctx.log.some((l) => l.includes("member_defaulted") && l.includes(GRANTEE))).toBe(true);
    expect(ctx.log.filter((l) => l.includes("DeleteKey"))).toHaveLength(2);
    // the next request for a revoked grant is refused
    await expect(ctx.dispatcher.deliver(1)).rejects.toMatchObject({ code: "grant_revoked" });
  });

  it("TC-BK-007-04 a failed revoke_grant is reported but the key stays deleted; a failed DeleteKey is not followed by revoke_grant", async () => {
    const ctx = setup();
    await leased(ctx);
    ctx.chain.revokeResult = { ok: false, error: "ERR_GRANT_REVOKE_DENIED" };
    const report = await ctx.revoker.onDefault(GRANTEE);
    expect(report.closed[0]).toMatchObject({ keyDeleted: true, revoked: false, error: expect.stringContaining("ERR_GRANT_REVOKE_DENIED") });
    expect(ctx.chain.keys.size).toBe(0);

    const broken = setup();
    await leased(broken);
    broken.chain.deleteLeaseKey = async () => {
      throw new Error("node down");
    };
    const second = await broken.revoker.onDefault(GRANTEE);
    expect(second.closed[0]).toMatchObject({ keyDeleted: false, revoked: false, error: expect.stringContaining("node down") });
    expect(broken.chain.calls.some((c) => c.startsWith("revoke:"))).toBe(false);
    expect(broken.store.lease(1)!.closed).toBe(false);
  });

  it("TC-BE-096-01 a revoke_grant that failed after DeleteKey is repeated by the next sweep until it works, and its error is in the report each time", async () => {
    const ctx = setup();
    await leased(ctx);
    ctx.clock.now = NOW + DAY_MS + 1;
    ctx.chain.revokeResult = { ok: false, error: "ERR_RPC_TIMEOUT" };
    const first = await ctx.revoker.sweep();
    expect(first.closed).toMatchObject([{ grantId: 1, keyDeleted: true, revoked: false, error: expect.stringContaining("ERR_RPC_TIMEOUT") }]);
    const second = await ctx.revoker.sweep();
    expect(second.closed).toMatchObject([{ grantId: 1, reason: "operator", revoked: false, error: expect.stringContaining("ERR_RPC_TIMEOUT") }]);
    ctx.chain.revokeResult = { ok: true, txHash: "tx-revoke" };
    const third = await ctx.revoker.sweep();
    expect(third.closed).toMatchObject([{ grantId: 1, reason: "operator", revoked: true }]);
    expect((await ctx.revoker.sweep()).closed).toEqual([]); // nothing left to repeat
  });

  it("TC-BE-096-02 a DeleteKey that failed leaves the lease open, so the next sweep tries it again", async () => {
    const ctx = setup();
    await leased(ctx);
    ctx.clock.now = NOW + DAY_MS + 1;
    const deleteKey = ctx.chain.deleteLeaseKey.bind(ctx.chain);
    ctx.chain.deleteLeaseKey = async () => {
      throw new Error("node down");
    };
    expect((await ctx.revoker.sweep()).closed).toMatchObject([{ keyDeleted: false, error: expect.stringContaining("node down") }]);
    expect(ctx.store.lease(1)!.closed).toBe(false);
    ctx.chain.deleteLeaseKey = deleteKey;
    expect((await ctx.revoker.sweep()).closed).toMatchObject([{ grantId: 1, keyDeleted: true, revoked: true }]);
  });

  it("TC-BK-007-05 a grant that the grantor revoked: the watcher event deletes the key, with no second revoke_grant", async () => {
    const ctx = setup();
    await leased(ctx);
    ctx.chain.grants.set(1, grant({ status: "revoked" }));
    await ctx.revoker.handle({ receiptId: "r1", logIndex: 0, blockHeight: 5, event: "grant_revoked", data: { grant_id: 1, reason: "grantor" } });
    expect(ctx.chain.keys.size).toBe(0);
    expect(ctx.chain.calls.some((c) => c.startsWith("revoke:"))).toBe(false);
    // and the sweep finds nothing left to do
    expect((await ctx.revoker.sweep()).closed).toEqual([]);
  });

  it("TC-BK-007-06 the sweep also closes a lease whose grant was revoked while the watcher was down", async () => {
    const ctx = setup();
    await leased(ctx);
    ctx.chain.grants.set(1, grant({ status: "revoked" }));
    const report = await ctx.revoker.sweep();
    expect(report.closed).toMatchObject([{ grantId: 1, reason: "already_final", keyDeleted: true, revoked: false }]);
    expect(ctx.chain.keys.size).toBe(0);
  });
});
