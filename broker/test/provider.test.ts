import { afterEach, describe, expect, it } from "vitest";
import { BrokerStore } from "../src/store.js";
import { MockProviderAdapter, ProviderAccessError, ProviderAccessManager, RETRY_BASE_MS, type ProviderGrantInput } from "../src/provider/index.js";
import { ERROR_STATUS } from "../src/provider/routes.js";
import { NOW } from "./helpers.js";

const NS = (ms: number): string => (BigInt(ms) * 1_000_000n).toString();
const DAY = 86_400_000;
const input = (over: Record<string, unknown> = {}, id = 1, expiresIn = 10 * DAY): ProviderGrantInput => ({
  grant_id: id, limits: { scope: JSON.stringify({ provider: "mock", grantee_ref: "alice-dev", resource: "repo-x", permission: "pull", ...over }), expires_at: NS(NOW + expiresIn) },
});

describe("BE-057 P2 provider access: one interface, mock provider, revoke_pending with retry, modes", () => {
  let store: BrokerStore | undefined;
  afterEach(() => store?.close());
  const clock = { now: NOW };
  function setup(options: { mode?: "self-hosted" | "hosted"; adapter?: MockProviderAdapter } = {}) {
    clock.now = NOW;
    store = new BrokerStore(":memory:");
    const adapter = options.adapter ?? new MockProviderAdapter({ now: () => clock.now });
    const manager = new ProviderAccessManager({ store, now: () => clock.now, ...(options.mode ? { mode: options.mode } : {}) });
    manager.register(adapter);
    return { manager, adapter };
  }

  it("TC-BE-057-01 the mock provider runs a grant, the use and the revoke; the next day's rent moves the end; the end never passes expires_at", async () => {
    const { manager, adapter } = setup();
    const g = input();
    const first = await manager.grantAccess(g);
    expect(first.access).toMatchObject({ status: "active", provider: "mock", granteeRef: "alice-dev", paidUntilMs: NOW + DAY });
    expect(first.delivery).toMatchObject({ account: "alice-dev", resource: "repo-x" });
    expect(await adapter.status(first.access.handle)).toBe("active");
    clock.now += DAY / 2;
    expect((await manager.grantAccess(g)).access.paidUntilMs).toBe(NOW + 2 * DAY); // rent adds to the end that is still ahead
    const short = await manager.grantAccess(input({}, 2, DAY / 4));
    expect(short.access.paidUntilMs).toBe(NOW + DAY / 4); // not past expires_at
    clock.now = NOW + 3 * DAY;
    const closed = await manager.sweep();
    expect(closed.map((a) => [a.grantId, a.status])).toEqual([[1, "revoked"], [2, "revoked"]]);
    expect(await adapter.status(first.access.handle)).toBe("absent");
    expect(await manager.sweep()).toEqual([]);
  });

  it("TC-BE-057-02 a revoke that fails becomes revoke_pending and is retried with growing waits until it works", async () => {
    const { manager, adapter } = setup();
    await manager.grantAccess(input());
    adapter.failRevoke = 2;
    clock.now = NOW + DAY + 1;
    const first = (await manager.sweep())[0]!;
    expect(first).toMatchObject({ status: "revoke_pending", attempts: 1, nextRetryMs: clock.now + RETRY_BASE_MS });
    expect(first.lastError).toContain("down");
    expect(await manager.sweep()).toEqual([]); // not due yet
    expect(adapter.revokeCalls).toBe(1);
    clock.now += RETRY_BASE_MS;
    const second = (await manager.sweep())[0]!;
    expect(second).toMatchObject({ status: "revoke_pending", attempts: 2, nextRetryMs: clock.now + 2 * RETRY_BASE_MS });
    clock.now += 2 * RETRY_BASE_MS;
    const third = (await manager.sweep())[0]!;
    expect(third).toMatchObject({ status: "revoked", nextRetryMs: null, lastError: null, reason: "paid_until" });
    expect(await adapter.status("mock-1")).toBe("absent");
    expect(manager.list("revoke_pending")).toEqual([]);
  });

  it("TC-BE-057-03 the grantee is verified before every grant: a reference the provider does not know gets no access", async () => {
    const { manager, adapter } = setup();
    await expect(manager.grantAccess(input({ grantee_ref: "No Such User!" }))).rejects.toMatchObject({ code: "grantee_ref_unverified" });
    expect(adapter.entries.size).toBe(0);
    expect(manager.access(1)).toBeUndefined();
    await expect(manager.grantAccess(input({ provider: "nobody" }))).rejects.toMatchObject({ code: "provider_unknown" });
    await expect(manager.grantAccess({ grant_id: 3, limits: { scope: "{}", expires_at: NS(NOW + DAY) } })).rejects.toMatchObject({ code: "scope_invalid" });
  });

  it("TC-BE-057-04 hosted mode refuses a real provider and serves the mock; self-hosted takes both", () => {
    const real = new MockProviderAdapter({ provider: "github", real: true });
    expect(() => setup({ mode: "hosted", adapter: real })).toThrowError(ProviderAccessError);
    expect(() => setup({ mode: "hosted", adapter: real })).toThrowError(/hosted_mode_real_provider/);
    expect(() => setup({ mode: "hosted" })).not.toThrow();
    expect(() => setup({ mode: "self-hosted", adapter: real })).not.toThrow();
    expect(setup().manager.mode).toBe("self-hosted"); // the default
  });

  it("TC-BE-057-05 a provider with native expiry must set it; the expiry the adapter reports is kept, and one that would outlive the rent is undone", async () => {
    const native = new MockProviderAdapter({ nativeExpiry: true, now: () => clock.now });
    const { manager } = setup({ adapter: native });
    const a = (await manager.grantAccess(input())).access;
    expect(a.nativeExpiresMs).toBe(NOW + DAY);
    // the provider closes it by itself while the broker is away
    clock.now = NOW + DAY + 1;
    expect(await native.status(a.handle)).toBe("expired");
    // an adapter that claims native expiry but does not set it
    const lying = new MockProviderAdapter({ provider: "liar", nativeExpiry: true });
    lying.grant = async (r) => ({ handle: `x-${r.grantId}`, nativeExpiresAtMs: null, delivery: {} });
    const undone: string[] = [];
    lying.revoke = async (h) => void undone.push(h);
    manager.register(lying);
    await expect(manager.grantAccess(input({ provider: "liar" }, 9))).rejects.toMatchObject({ code: "native_expiry_required" });
    expect(undone).toEqual(["x-9"]);
    expect(manager.access(9)).toBeUndefined();
  });

  it("TC-BE-057-06 a costly access is billed by its real cost per day, once; a day over the cap of the grantor closes it", async () => {
    const price = new Map<string, bigint>([["mock-1", 700_000n], ["mock-2", 5_000_000n]]);
    const adapter = new MockProviderAdapter({ now: () => clock.now, costPerDay: (h) => price.get(h) ?? 0n });
    const { manager } = setup({ adapter });
    const cheap = input({ daily_cap: "2000000" }, 1);
    const dear = input({ daily_cap: "2000000" }, 2);
    await manager.grantAccess(cheap);
    await manager.grantAccess(dear);
    expect(await manager.settleDay(cheap, NOW)).toEqual({ amount: 700_000n, overCap: false });
    price.set("mock-1", 9n); // the provider now says something else; the day that was written down does not change
    expect(await manager.settleDay(cheap, NOW)).toEqual({ amount: 700_000n, overCap: false });
    expect(await manager.settleDay(dear, NOW)).toEqual({ amount: 5_000_000n, overCap: true });
    expect(manager.access(2)).toMatchObject({ status: "revoked", reason: "cap_exceeded" });
    expect(manager.access(1)?.status).toBe("active");
    expect(manager.charges(2)).toEqual([{ day: Math.floor(NOW / DAY), amount: 5_000_000n, overCap: true }]);
    await expect(manager.settleDay(input({}, 77), NOW)).rejects.toMatchObject({ code: "access_not_found" });
  });

  it("TC-BE-057-X1 the clock enforces daily_cap: an access whose real cost today passes the cap is closed by sweep, without anybody calling settleDay; the cost seen is the floor of the bill", async () => {
    const price = new Map<string, bigint>([["mock-1", 1_000_000n], ["mock-2", 1_000_000n], ["mock-3", 1_000_000n]]);
    const adapter = new MockProviderAdapter({ now: () => clock.now, costPerDay: (h) => price.get(h) ?? 0n });
    const { manager } = setup({ adapter });
    const midday = Math.floor(NOW / DAY) * DAY + DAY / 2; // the mock bills in proportion to the time since the start of the day
    clock.now = midday;
    const g3 = input({ daily_cap: "2000000" }, 3);
    await manager.grantAccess(input({ daily_cap: "2000000" }, 1));
    await manager.grantAccess(input({}, 2)); // no cap: never closed by cost
    await manager.grantAccess(g3);
    expect(await manager.sweep()).toEqual([]); // 0.5 credit so far, under the cap
    price.set("mock-1", 6_000_000n); // 3 credit so far, over the cap of 2
    price.set("mock-2", 18_000_000n);
    price.set("mock-3", 3_000_000n); // 1.5 so far: under the cap
    const closed = await manager.sweep();
    expect(closed.map((a) => [a.grantId, a.status, a.reason])).toEqual([[1, "revoked", "cap_exceeded"]]);
    expect(manager.access(2)?.status).toBe("active");
    expect(manager.access(3)?.status).toBe("active");
    expect(manager.charges(1)).toEqual([{ day: Math.floor(midday / DAY), amount: 3_000_000n, overCap: true }]);
    // a provider that cannot say what a finished day cost (it answers 0): the bill keeps what the clock saw
    price.set("mock-3", 0n);
    expect(await manager.settleDay(g3, midday)).toEqual({ amount: 1_500_000n, overCap: false });
  });

  it("TC-BE-078-P2 two paid first requests at once open ONE access at the provider: the second waits and renews the handle of the first (B7-P2)", async () => {
    const adapter = new MockProviderAdapter({ now: () => clock.now });
    const calls: Array<string | null> = [];
    const open = adapter.grant.bind(adapter);
    adapter.grant = async (request) => {
      calls.push(request.existingHandle ?? null);
      await new Promise((resolve) => setTimeout(resolve, 20)); // the provider takes its time: without the wait both calls are inside it
      return open(request);
    };
    const { manager } = setup({ adapter });
    const [a, b] = await Promise.all([manager.grantAccess(input()), manager.grantAccess(input())]);
    expect(calls).toEqual([null, "mock-1"]);
    expect(a.access.handle).toBe(b.access.handle);
    expect(adapter.entries.size).toBe(1);
  });

  it("TC-BE-057-07 revokeAccess closes at once, is safe twice, and a revoked access cannot be granted again", async () => {
    const { manager, adapter } = setup();
    await manager.grantAccess(input());
    expect((await manager.revokeAccess(1, "defaulted")).status).toBe("revoked");
    expect((await manager.revokeAccess(1, "defaulted")).status).toBe("revoked");
    expect(adapter.revokeCalls).toBe(1);
    await expect(manager.grantAccess(input())).rejects.toMatchObject({ code: "access_conflict" });
    await expect(manager.revokeAccess(5, "x")).rejects.toMatchObject({ code: "access_not_found" });
  });

  it("BE-057 fix: grant_failed is split in two codes: access_conflict (409, the state of the access or of another grant) and provider_grant_failed (502, the provider)", () => {
    expect(ERROR_STATUS.access_conflict).toBe(409);
    expect(ERROR_STATUS.provider_grant_failed).toBe(502);
    expect(Object.keys(ERROR_STATUS)).not.toContain("grant_failed");
  });
});

describe("BE-070 fix B7-P10 the text of a provider error is redacted before it is kept or shown", () => {
  it("TC-BE-078-P10 lastError and provider_grant_failed hold [redacted], not the Bearer key", async () => {
    const store = new BrokerStore(":memory:");
    const clock = { now: NOW };
    const adapter = new MockProviderAdapter({ now: () => clock.now });
    const manager = new ProviderAccessManager({ store, now: () => clock.now });
    manager.register(adapter);
    const key = "sk-or-v1-0123456789abcdef0123456789abcdef";
    const failing = adapter.revoke.bind(adapter);
    adapter.revoke = async () => {
      throw new Error(`500 {"error":"bad Bearer ${key}"}`);
    };
    await manager.grantAccess(input());
    const revoked = await manager.revokeAccess(1, "stopped");
    expect(revoked.status).toBe("revoke_pending");
    expect(revoked.lastError).not.toContain(key);
    expect(revoked.lastError).toContain("[redacted]");
    adapter.revoke = failing;
    adapter.grant = async () => {
      throw new Error(`401 Bearer ${key}`);
    };
    const refused = await manager.grantAccess(input({}, 2)).catch((e: Error) => e);
    expect(refused).toMatchObject({ code: "provider_grant_failed" });
    expect((refused as Error).message).not.toContain(key);
    store.close();
  });
});
