// BE-100: review of BE-099 by Worker F. The key of a lease must never be left on the chain without a row (M2), a lease closes only when the FINAL head no longer shows the key (M1),
// the error of a key that is already gone is the class of near-api-js (L1), revoke and payment of one grant run in one queue (L3), a failed DeleteKey from an event does not fail the tick (c).
import { KeyPair } from "near-api-js";
import { DeleteKeyDoesNotExistActionError } from "near-api-js/rpc-errors";
import { describe, expect, it } from "vitest";
import { isKeyAlreadyGone } from "../src/chain.js";
import { Dispatcher } from "../src/dispatcher.js";
import { ClassBAdapter, DAY_MS } from "../src/keys/class-b.js";
import { Revoker } from "../src/revoker.js";
import { BrokerStore } from "../src/store.js";
import { FakeChain, grant, GRANTEE, KEY, LEASE, NOW } from "./helpers.js";

const present = { nonce: 1, permission: "FullAccess" as const };

function setup(options: { finalKeys?: () => boolean; finalWaitMs?: number } = {}) {
  const chain = new FakeChain();
  const store = new BrokerStore(":memory:");
  const clock = { now: NOW };
  const view = (async (_account: string, key: string) => (chain.keys.has(key) ? present : null)) as never;
  const sleeps: number[] = [];
  const classB = new ClassBAdapter({
    chain, store, viewAccessKey: view, now: () => clock.now, sleep: async (ms) => void sleeps.push(ms),
    ...(options.finalKeys ? { viewFinalAccessKey: (async (_a: string, key: string) => (chain.keys.has(key) || options.finalKeys!() ? present : null)) as never, finalWaitMs: options.finalWaitMs ?? 5_000 } : {}),
  });
  const log: string[] = [];
  const revoker = new Revoker({ chain, store, classB, activeGrantIdsOf: chain.activeIdsOf, now: () => clock.now, log: (l) => log.push(l) });
  return { chain, store, clock, classB, revoker, log, sleeps, dispatcher: new Dispatcher({ chain, adapters: { B: classB } }) };
}

describe("BE-100 review of BE-099", () => {
  it("TC-BE-100-01 (M2) the row with the key is stored before AddKey; an AddKey that throws after it ran leaves the lease usable, one that never ran leaves no open lease", async () => {
    const ctx = setup();
    ctx.chain.grants.set(1, grant());
    let rowAtAdd: boolean | undefined;
    const add = ctx.chain.addLeaseKey.bind(ctx.chain);
    ctx.chain.addLeaseKey = async (key, scope) => {
      rowAtAdd = ctx.store.lease(1)?.keyAdded; // the process could die right here: the row must already be there
      await add(key, scope);
      throw new Error("RPC timeout after the transaction was executed");
    };
    const delivered = await ctx.dispatcher.deliver(1);
    expect(rowAtAdd).toBe(true);
    expect(delivered).toBeDefined();
    expect(ctx.chain.keys.has(KEY)).toBe(true);
    expect(ctx.store.lease(1)).toMatchObject({ keyAdded: true, closed: false });
    expect(ctx.store.openLeases().map((l) => l.grantId)).toEqual([1]); // the sweep can find the key

    const failed = setup();
    failed.chain.grants.set(1, grant());
    failed.chain.addLeaseKey = async () => {
      throw new Error("node down");
    };
    await expect(failed.dispatcher.deliver(1)).rejects.toThrow(/node down/);
    expect(failed.chain.keys.size).toBe(0);
    expect(failed.store.openLeases()).toEqual([]); // no row for a key that was never added: the sweep does not close the grant of a lessee that got nothing
    expect(failed.store.lease(1)).toMatchObject({ keyAdded: false, paidUntilMs: 0 });
  });

  it("TC-BE-100-02 (M1) a lease closes only when the final head no longer shows the key; the check waits for the final head and gives up with the lease open", async () => {
    let finalShows = 3;
    const ctx = setup({ finalKeys: () => finalShows-- > 0 });
    ctx.chain.grants.set(1, grant());
    await ctx.dispatcher.deliver(1);
    await ctx.classB.revoke(grant());
    expect(ctx.store.lease(1)!.closed).toBe(true);
    expect(ctx.sleeps.length).toBeGreaterThan(0); // it waited for the final head

    const stuck = setup({ finalKeys: () => true, finalWaitMs: 1_000 });
    stuck.chain.grants.set(1, grant());
    await stuck.dispatcher.deliver(1);
    await expect(stuck.classB.revoke(grant())).rejects.toThrow(/still on/);
    expect(stuck.store.lease(1)!.closed).toBe(false);
    expect(stuck.sleeps).toEqual([500, 500]);
  });

  it("TC-BE-100-03 (L1) the real error class of near-api-js means 'key already gone'; the same words from another error do not", () => {
    const real = new DeleteKeyDoesNotExistActionError("lease.test.near", KeyPair.fromRandom("ed25519").getPublicKey(), 0, "txhash", "blockhash");
    expect(isKeyAlreadyGone(real)).toBe(true);
    expect(isKeyAlreadyGone(Object.assign(new Error("x"), { name: "DeleteKeyDoesNotExistActionError" }))).toBe(true);
    expect(isKeyAlreadyGone(new Error("Public key ed25519:abc does not exist on account lease.test.near"))).toBe(false);
    expect(isKeyAlreadyGone(Object.assign(new Error("RPC"), { type: "UNKNOWN_ACCESS_KEY" }))).toBe(false);
  });

  it("TC-BE-100-05 (L3) a revoke that starts while a payment is still adding the key waits for it, so no key is left behind", async () => {
    const ctx = setup();
    ctx.chain.grants.set(1, grant());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const add = ctx.chain.addLeaseKey.bind(ctx.chain);
    ctx.chain.addLeaseKey = async (key, scope) => {
      await gate;
      return add(key, scope);
    };
    const paying = ctx.classB.deliver(grant());
    await new Promise((r) => setTimeout(r, 5));
    const revoking = ctx.classB.revoke(grant());
    await new Promise((r) => setTimeout(r, 5));
    release();
    await paying;
    await revoking;
    expect(ctx.chain.keys.size).toBe(0);
    expect(ctx.store.lease(1)).toMatchObject({ keyAdded: true, closed: true });
  });

  it("TC-BE-100-06 (c) a grant_revoked event whose DeleteKey fails is logged, does not throw, and the sweep deletes the key", async () => {
    const ctx = setup();
    ctx.chain.grants.set(1, grant());
    await ctx.dispatcher.deliver(1);
    ctx.chain.grants.set(1, grant({ status: "revoked" }));
    const del = ctx.chain.deleteLeaseKey.bind(ctx.chain);
    ctx.chain.deleteLeaseKey = async () => {
      throw new Error("node down");
    };
    await expect(ctx.revoker.handle({ receiptId: "r1", logIndex: 0, blockHeight: 5, event: "grant_revoked", data: { grant_id: 1, reason: "grantor" } })).resolves.toBeUndefined();
    expect(ctx.log.some((l) => l.includes("DeleteKey failed") && l.includes("node down"))).toBe(true);
    expect(ctx.store.lease(1)!.closed).toBe(false);
    ctx.chain.deleteLeaseKey = del;
    expect((await ctx.revoker.sweep()).closed).toMatchObject([{ grantId: 1, reason: "already_final", keyDeleted: true }]);
    expect(ctx.chain.keys.size).toBe(0);
    void GRANTEE;
    void LEASE;
    void DAY_MS;
  });
});
