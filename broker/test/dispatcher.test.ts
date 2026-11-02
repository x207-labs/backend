import { describe, expect, it } from "vitest";
import { Dispatcher, DispatchError } from "../src/dispatcher.js";
import { ClassBAdapter, DAY_MS } from "../src/keys/class-b.js";
import { BrokerStore } from "../src/store.js";
import { FakeChain, grant, GRANTEE, KEY, NOW } from "./helpers.js";

function setup() {
  const chain = new FakeChain();
  const store = new BrokerStore(":memory:");
  const classB = new ClassBAdapter({ chain, store, viewAccessKey: async () => null, now: () => chain.now });
  const dispatcher = new Dispatcher({ chain, adapters: { B: classB } });
  return { chain, store, classB, dispatcher };
}

describe("BK-004 dispatcher deliver", () => {
  it("TC-BK-004-01 an active grant reaches the adapter of its class and nothing else", async () => {
    const { chain, dispatcher, store } = setup();
    chain.grants.set(1, grant());
    const { delivery } = (await dispatcher.deliver(1)) as { delivery: { account: string; publicKey: string } };
    expect(delivery).toMatchObject({ publicKey: KEY });
    expect(chain.calls).toContain(`addKey:${KEY}`);
    expect(store.lease(1)).toMatchObject({ keyAdded: true, closed: false });
  });

  it("TC-BK-004-02 a grant that is not active, is past expires_at or does not exist never produces an outgoing flow", async () => {
    const cases: Array<[string, number, ReturnType<typeof grant> | undefined, string]> = [
      ["offered", 1, grant({ status: "offered", grantee: null }), "grant_not_active"],
      ["revoked", 1, grant({ status: "revoked" }), "grant_revoked"],
      ["expired", 1, grant({ status: "expired" }), "grant_revoked"],
      ["missing", 9, undefined, "grant_not_found"],
    ];
    for (const [name, id, g, code] of cases) {
      const { chain, dispatcher } = setup();
      if (g) chain.grants.set(1, g);
      await expect(dispatcher.deliver(id), name).rejects.toMatchObject({ code });
      expect(chain.calls.filter((c) => c.startsWith("addKey") || c.startsWith("deleteKey")), name).toEqual([]);
    }
    // still `active` on chain, but the clock passed expires_at
    const { chain, dispatcher } = setup();
    chain.grants.set(1, grant());
    chain.now = NOW + 11 * DAY_MS;
    await expect(dispatcher.deliver(1)).rejects.toMatchObject({ code: "grant_revoked" });
    expect(chain.calls.some((c) => c.startsWith("addKey"))).toBe(false);
  });

  it("TC-BK-004-03 a class without an adapter is class_not_supported with status 501", async () => {
    const { chain, dispatcher } = setup();
    chain.grants.set(1, grant({ class: "C" }));
    const error = (await dispatcher.deliver(1).catch((e) => e)) as DispatchError;
    expect([error.code, error.status]).toEqual(["class_not_supported", 501]);
  });

  it("TC-BK-004-04 each payment moves paid_until by one day, never past expires_at, and a closed lease is not served", async () => {
    const { chain, dispatcher, store } = setup();
    chain.grants.set(1, grant());
    await dispatcher.deliver(1);
    expect(store.lease(1)!.paidUntilMs).toBe(NOW + DAY_MS);
    await dispatcher.deliver(1);
    expect(store.lease(1)!.paidUntilMs).toBe(NOW + 2 * DAY_MS);
    expect(chain.calls.filter((c) => c.startsWith("addKey"))).toHaveLength(1);
    chain.now = NOW + 9.5 * DAY_MS;
    chain.grants.set(1, grant());
    await dispatcher.deliver(1);
    expect(store.lease(1)!.paidUntilMs).toBe(NOW + 10 * DAY_MS);
    store.save({ ...store.lease(1)!, closed: true });
    await expect(dispatcher.deliver(1)).rejects.toThrow(/closed/);
    void GRANTEE;
  });
});
