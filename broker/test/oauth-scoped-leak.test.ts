// BE-083 fix: the handle of an `oauth-scoped` access holds the access token (RFC 7009 and RFC 7662 take nothing else), so it is a secret that lives only in the store of the broker. These tests
// check that it never leaves: not in the grants API (GET access), not in the answer of `status`, not in the log lines of the manager, not in the error of a revoke that fails.
import { describe, expect, it } from "vitest";
import { Dispatcher } from "../src/dispatcher.js";
import { ClassBAdapter } from "../src/keys/class-b.js";
import { OAuthScopedAdapter, ProviderAccessManager } from "../src/provider/index.js";
import { createBrokerHandler } from "../src/server.js";
import { BrokerStore } from "../src/store.js";
import { provider } from "./oauth-mock.js";
import { BROKER, FakeChain, GRANTEE, grant, NOW } from "./helpers.js";

const CIRCLE = "x207-circle.near";
const DAY = 86_400_000;
const NS = (ms: number): string => (BigInt(ms) * 1_000_000n).toString();
const SCOPE = JSON.stringify({ provider: "oauth-scoped", grantee_ref: "agent-andi", resource: "read:repo write:issues", permission: null });

function setup() {
  const chain = new FakeChain();
  const clock = chain as unknown as { now: number };
  const flags = { failRevoke: false };
  const p = provider({ clock, failRevoke: () => flags.failRevoke });
  const store = new BrokerStore(":memory:");
  const logs: string[] = [];
  const manager = new ProviderAccessManager({ store, now: () => chain.now, log: (line) => logs.push(line) });
  manager.register(p.adapter() as OAuthScopedAdapter);
  const classB = new ClassBAdapter({ chain, store, viewAccessKey: async () => null, now: () => chain.now });
  const dispatcher = new Dispatcher({ chain, adapters: { B: classB } });
  const fetchFn = (async (input: string | URL) => {
    const path = new URL(String(input)).pathname;
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (path === "/supported") return reply({ kinds: [{ scheme: "batch-settlement", network: "x207:agents-main", extra: { circleContract: CIRCLE, epoch: 42 } }] });
    if (path === "/verify") return reply({ isValid: true });
    if (path === "/settle") return reply({ success: true, transaction: "", network: "x207:agents-main", payer: GRANTEE });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  const handler = createBrokerHandler({
    dispatcher, classB, facilitatorUrl: "http://facilitator.test", circleId: "agents-main", brokerAccount: BROKER, fetch: fetchFn,
    provider: { manager, contractId: CIRCLE, now: () => chain.now, voucherKeyOf: async () => null },
  });
  chain.grants.set(1, grant({ limits: { scope: SCOPE, quota: null, expires_at: NS(NOW + 10 * DAY) } }));
  return { chain, store, handler, manager, logs, flags, adapter: p.adapter() };
}
const url = (tail = "") => `http://broker.test/grants/1/access${tail}`;
const pay = (x207: unknown) =>
  new Request(url(), {
    method: "POST", body: JSON.stringify({ grantee_ref: "agent-andi" }),
    headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify({ x402Version: 2, accepted: x207, payload: { voucher: { payer: GRANTEE, seq: 1, cumulativeAmount: "250000" }, signature: "ed25519:x" } })).toString("base64") },
  });

describe("BE-083 fix: the token inside the handle of oauth-scoped never leaves the store of the broker", () => {
  it("TC-BE-083-10 the lessee gets the token once, in the paid answer; GET access, status and the log lines never hold it or the handle", async () => {
    const t = setup();
    const first = await t.handler(new Request(url(), { method: "POST", body: JSON.stringify({ grantee_ref: "agent-andi" }) }));
    const accepts = ((await first.json()) as { accepts: Array<{ scheme: string }> }).accepts;
    const paid = await t.handler(pay(accepts.find((a) => a.scheme === "batch-settlement")));
    expect(paid.status).toBe(200);
    const body = (await paid.json()) as { delivery: { accessToken: string } };
    const token = body.delivery.accessToken;
    expect(token).toBe("tok-0001");
    const handle = t.manager.access(1)!.handle;
    expect(handle).toContain(Buffer.from(token).toString("base64url")); // the secret is in the store, as designed
    const secrets = [token, Buffer.from(token).toString("base64url"), handle];

    const viewed = await t.handler(new Request(url(), { method: "GET" }));
    expect(viewed.status).toBe(200);
    const viewedText = await viewed.text();
    for (const s of secrets) expect(viewedText).not.toContain(s);
    expect(JSON.parse(viewedText)).toMatchObject({ provider: "oauth-scoped", status: "active" });

    const state = await t.adapter.status(handle);
    expect(state).toBe("active");
    for (const s of secrets) expect(JSON.stringify(state)).not.toContain(s);

    t.chain.now += DAY + 1;
    await t.manager.sweep();
    for (const s of secrets) expect(t.logs.join("\n")).not.toContain(s);
    t.store.close();
  });

  it("TC-BE-083-11 a revoke that fails: the retry state in GET access and in the log names the path and the status, never the token", async () => {
    const t = setup();
    const first = await t.handler(new Request(url(), { method: "POST", body: JSON.stringify({ grantee_ref: "agent-andi" }) }));
    const accepts = ((await first.json()) as { accepts: Array<{ scheme: string }> }).accepts;
    const paid = (await (await t.handler(pay(accepts.find((a) => a.scheme === "batch-settlement")))).json()) as { delivery: { accessToken: string } };
    const secrets = [paid.delivery.accessToken, Buffer.from(paid.delivery.accessToken).toString("base64url"), t.manager.access(1)!.handle];
    t.flags.failRevoke = true;
    t.chain.now += DAY + 1;
    const [pending] = await t.manager.sweep();
    expect(pending?.status).toBe("revoke_pending");
    const viewedText = await (await t.handler(new Request(url(), { method: "GET" }))).text();
    expect(JSON.parse(viewedText).revokePending.lastError).toMatch(/HTTP 503/);
    for (const s of secrets) {
      expect(viewedText).not.toContain(s);
      expect(t.logs.join("\n")).not.toContain(s);
    }
    expect(t.logs.join("\n")).toMatch(/revoke_pending/);
    t.store.close();
  });
});
