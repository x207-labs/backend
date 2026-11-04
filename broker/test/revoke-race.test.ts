// Security review batch 8 (BE-057 fix): a revoke (a default, a stop, the clock) must not interleave with a paid renewal of the same grant. Before the fix the renewal read the access
// as active, the revoke closed it at the provider and saved `revoked`, and then the renewal opened the access again and saved `active`: a defaulted lessee kept an open access.
import { describe, expect, it } from "vitest";
import type { ProviderAccessAdapter, ProviderGrantRequest, ProviderGrantResult } from "../src/provider/index.js";
import { ProviderAccessManager } from "../src/provider/index.js";
import { BrokerStore } from "../src/store.js";
import { NOW } from "./helpers.js";

const DAY = 86_400_000;
const NS = (ms: number): string => (BigInt(ms) * 1_000_000n).toString();
const input = { grant_id: 1, limits: { scope: JSON.stringify({ provider: "slow", grantee_ref: "agent-andi", resource: "x", permission: null }), expires_at: NS(NOW + 10 * DAY) } };

/** An adapter whose `grant` waits for a gate, so that a revoke can arrive in the middle of a renewal; `open` is what the provider says now. */
class SlowAdapter implements ProviderAccessAdapter {
  readonly provider = "slow";
  readonly real = true;
  readonly nativeExpiry = false;
  open = false;
  gate: Promise<void> = Promise.resolve();
  events: string[] = [];
  async verifyGranteeRef() {
    return { ok: true as const };
  }
  async grant(request: ProviderGrantRequest): Promise<ProviderGrantResult> {
    this.events.push("grant:start");
    await this.gate;
    this.open = true;
    this.events.push("grant:end");
    return { handle: "slow:1", nativeExpiresAtMs: null, delivery: { provider: "slow" } };
  }
  async revoke(): Promise<void> {
    this.events.push("revoke");
    this.open = false;
  }
  async status() {
    return this.open ? ("active" as const) : ("absent" as const);
  }
}

describe("security review batch 8: a revoke and a renewal of one grant do not interleave", () => {
  it("TC-BE-057-R1 a default that arrives in the middle of a paid renewal ends with the access revoked at the manager and at the provider", async () => {
    const clock = { now: NOW };
    const adapter = new SlowAdapter();
    const store = new BrokerStore(":memory:");
    const m = new ProviderAccessManager({ store, now: () => clock.now });
    m.register(adapter);
    await m.grantAccess(input); // day one
    expect(adapter.open).toBe(true);
    clock.now += DAY - 1000;
    let release!: () => void;
    adapter.gate = new Promise<void>((r) => (release = r));
    adapter.events = [];
    const renewal = m.grantAccess(input).catch((e: Error) => e); // day two, held at the provider
    await new Promise((r) => setTimeout(r, 20));
    const revoking = m.revokeAccess(1, "defaulted"); // the member defaulted while the renewal runs
    await new Promise((r) => setTimeout(r, 20));
    release();
    await renewal;
    await revoking;
    expect(m.access(1)?.status).toBe("revoked");
    expect(adapter.open).toBe(false);
    expect(adapter.events.at(-1)).toBe("revoke"); // the revoke came last
    store.close();
  });

  it("TC-BE-057-R2 the clock does not close a day that a renewal has just paid: the sweep decides on the access as it is when it gets its turn", async () => {
    const clock = { now: NOW };
    const adapter = new SlowAdapter();
    const store = new BrokerStore(":memory:");
    const m = new ProviderAccessManager({ store, now: () => clock.now });
    m.register(adapter);
    await m.grantAccess(input);
    clock.now += DAY + 1; // the first day is over: the sweep is due
    let release!: () => void;
    adapter.gate = new Promise<void>((r) => (release = r));
    const renewal = m.grantAccess(input); // paid just now, for the second day
    await new Promise((r) => setTimeout(r, 20));
    const swept = m.sweep();
    await new Promise((r) => setTimeout(r, 20));
    release();
    await renewal;
    await swept;
    expect(m.access(1)?.status).toBe("active");
    expect(m.access(1)?.paidUntilMs).toBeGreaterThan(clock.now);
    expect(adapter.open).toBe(true);
    store.close();
  });
});
