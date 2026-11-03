import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateVoucherKeypair, nep413SigningHash, signHash } from "@x207/core";
import { X207ExtraSource } from "@x207/scheme";
import { Dispatcher } from "../src/dispatcher.js";
import { ClassBAdapter } from "../src/keys/class-b.js";
import { MockProviderAdapter, ProviderAccessManager, stopNoticeText } from "../src/provider/index.js";
import { createBrokerHandler, creditPrice } from "../src/server.js";
import { BrokerStore } from "../src/store.js";
import { BROKER, FakeChain, GRANTEE, GRANTOR, grant, NOW } from "./helpers.js";

const CIRCLE = "x207-circle.near";
const DAY = 86_400_000;
const NS = (ms: number): string => (BigInt(ms) * 1_000_000n).toString();
const granteeKeys = generateVoucherKeypair();
const strangerKeys = generateVoucherKeypair();

function facilitator() {
  const seen: string[] = [];
  const fetchFn = (async (input: string | URL) => {
    const path = new URL(String(input)).pathname;
    seen.push(path);
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (path === "/supported") return reply({ kinds: [{ scheme: "batch-settlement", network: "x207:agents-main", extra: { circleContract: CIRCLE, epoch: 42 } }] });
    if (path === "/verify") return reply({ isValid: true });
    if (path === "/settle") return reply({ success: true, transaction: "", network: "x207:agents-main", payer: GRANTEE });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchFn, seen };
}

const scopeOf = (over: Record<string, unknown> = {}): string => JSON.stringify({ provider: "mock", grantee_ref: "alice-dev", resource: "repo-x", permission: "pull", ...over });
const providerGrant = (over: Record<string, unknown> = {}, scope = scopeOf()) => grant({ limits: { scope, quota: null, expires_at: NS(NOW + 10 * DAY) }, ...over });

function setup(adapterOptions: ConstructorParameters<typeof MockProviderAdapter>[0] = {}, withProvider = true) {
  const chain = new FakeChain();
  const store = new BrokerStore(":memory:");
  const classB = new ClassBAdapter({ chain, store, viewAccessKey: async () => null, now: () => chain.now });
  const dispatcher = new Dispatcher({ chain, adapters: { B: classB } });
  const adapter = new MockProviderAdapter({ now: () => chain.now, ...adapterOptions });
  const manager = new ProviderAccessManager({ store, now: () => chain.now });
  manager.register(adapter);
  const f = facilitator();
  const handler = createBrokerHandler({
    dispatcher, classB, facilitatorUrl: "http://facilitator.test", circleId: "agents-main", brokerAccount: BROKER, fetch: f.fetchFn,
    ...(withProvider ? { provider: { manager, contractId: CIRCLE, now: () => chain.now, voucherKeyOf: async (a: string) => (a === GRANTEE ? granteeKeys.publicKey : null) } } : {}),
  });
  chain.grants.set(1, providerGrant());
  return { chain, store, handler, f, manager, adapter };
}

const url = (id: number, tail = "") => `http://broker.test/grants/${id}/access${tail}`;
async function requirements(handler: ReturnType<typeof setup>["handler"]) {
  const response = await handler(new Request(url(1), { method: "POST", body: JSON.stringify({ grantee_ref: "alice-dev" }) }));
  const body = (await response.json()) as { accepts: Array<{ scheme: string; payTo: string; amount: string }> };
  return { response, x207: body.accepts.find((a) => a.scheme === "batch-settlement")! };
}
const pay = (x207: unknown, body: unknown, payer = GRANTEE, id = 1) =>
  new Request(url(id), {
    method: "POST", body: JSON.stringify(body),
    headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify({ x402Version: 2, accepted: x207, payload: { voucher: { payer, seq: 1, cumulativeAmount: "250000" }, signature: "ed25519:x" } })).toString("base64") },
  });
const signStop = (id: number, actor: string, secret: `ed25519:${string}`, at: number) => {
  const text = stopNoticeText({ circle: CIRCLE, grant_id: id, actor, at });
  return { notice: { circle: CIRCLE, grant_id: id, actor, action: "stop", at }, signature: signHash(nep413SigningHash(text, createHash("sha256").update(text, "utf8").digest(), CIRCLE), secret) };
};

describe("BE-060 HTTP rent of a P2 access: pay, ask, look, stop", () => {
  it("TC-BE-060-01 without a voucher the answer is 402 for one day to the grantor; a paid request opens the access at the (mock) provider and settles", async () => {
    const { handler, f, adapter, manager } = setup();
    const { response, x207 } = await requirements(handler);
    expect(response.status).toBe(402);
    expect(x207).toMatchObject({ payTo: GRANTOR, amount: expect.any(String) });
    const ok = await handler(pay(x207, { grantee_ref: "alice-dev" }));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as any;
    expect(body).toMatchObject({ grantId: 1, provider: "mock", granteeRef: "alice-dev", status: "active", delivery: { account: "alice-dev", resource: "repo-x" }, unit: "credit", decimals: 6 });
    expect(body.paidUntil).toBe(new Date(NOW + DAY).toISOString());
    expect(adapter.entries.size).toBe(1);
    expect(manager.access(1)?.status).toBe("active");
    expect(f.seen).toContain("/settle");
  });

  it("TC-BE-060-20 the view of an access carries the warning when the reference is not proven, also on GET (B4-F7)", async () => {
    const { handler, adapter } = setup();
    (adapter as { proveGranteeRef?: unknown }).proveGranteeRef = undefined;
    const { x207 } = await requirements(handler);
    const paid = (await (await handler(pay(x207, { grantee_ref: "alice-dev" }))).json()) as any;
    expect(paid).toMatchObject({ proof: "not_applicable", warnings: ["grantee_unproven"] });
    const viewed = (await (await handler(new Request(url(1), { method: "GET" }))).json()) as any;
    expect(viewed).toMatchObject({ proof: "not_applicable", warnings: ["grantee_unproven"] });
  });

  it("TC-BE-060-02 nothing is settled when the access cannot be opened: a ref other than the scope, a payer who is not the lessee, a ref the provider does not know", async () => {
    const { handler, f, adapter, chain } = setup();
    const { x207 } = await requirements(handler);
    const mismatch = await handler(pay(x207, { grantee_ref: "mallory" }));
    expect(mismatch.status).toBe(403);
    expect(((await mismatch.json()) as any).error).toBe("grantee_ref_mismatch");
    const other = await handler(pay(x207, { grantee_ref: "alice-dev" }, "intruder.x207-circle.near"));
    expect(other.status).toBe(403);
    expect(((await other.json()) as any).error).toBe("payer_not_grantee");
    chain.grants.set(2, providerGrant({ grant_id: 2 }, scopeOf({ grantee_ref: "No Such User!" })));
    const unknown = await handler(pay(x207, { grantee_ref: "No Such User!" }, GRANTEE, 2));
    expect(unknown.status).toBe(403);
    expect(((await unknown.json()) as any).error).toBe("grantee_ref_unverified");
    expect((await handler(new Request(url(1), { method: "POST", body: "not json" }))).status).toBe(400);
    expect(f.seen).not.toContain("/settle");
    expect(adapter.entries.size).toBe(0);
  });

  it("TC-BE-060-03 an adapter that asks for a proof of the ref needs it on the first day only", async () => {
    const { handler, f, adapter } = setup({ requireProof: true });
    const { x207 } = await requirements(handler);
    const without = await handler(pay(x207, { grantee_ref: "alice-dev" }));
    expect(without.status).toBe(403);
    expect(((await without.json()) as any).error).toBe("grantee_ref_unverified");
    expect(f.seen).not.toContain("/settle");
    expect((await handler(pay(x207, { grantee_ref: "alice-dev", proof: "own:someone-else" }))).status).toBe(403);
    expect((await handler(pay(x207, { grantee_ref: "alice-dev", proof: "own:alice-dev" }))).status).toBe(200);
    expect(adapter.entries.size).toBe(1);
    // the rent of the next day: no proof
    const next = await handler(pay(x207, { grantee_ref: "alice-dev" }));
    expect(next.status).toBe(200);
    expect(((await next.json()) as any).paidUntil).toBe(new Date(NOW + 2 * DAY).toISOString());
  });

  it("TC-BE-060-04 GET shows the status, the cost of today so far, and a revoke that is pending", async () => {
    const { handler, chain, manager, adapter } = setup({ costPerDay: () => 86_400_000n });
    expect((await handler(new Request(url(1)))).status).toBe(404); // no access yet
    const { x207 } = await requirements(handler);
    await handler(pay(x207, { grantee_ref: "alice-dev" }));
    chain.now = NOW + DAY / 4;
    const live = (await (await handler(new Request(url(1)))).json()) as any;
    expect(live).toMatchObject({ status: "active", revokePending: null });
    expect(BigInt(live.today.cost)).toBeGreaterThan(0n);
    expect(live.today.billed).toBeNull();
    // the day ends, the provider is down: revoke_pending shows its attempts
    adapter.failRevoke = 5;
    chain.now = NOW + DAY + 1;
    await manager.sweep();
    const pending = (await (await handler(new Request(url(1)))).json()) as any;
    expect(pending.status).toBe("revoke_pending");
    expect(pending.revokePending).toMatchObject({ attempts: 1, lastError: expect.stringContaining("down") });
    expect(pending.revokePending.nextRetryAt).toEqual(expect.any(String));
  });

  it("TC-BE-060-05 stop: the lessee signs with its voucher key and the access closes; a stranger, a forged signature and a stale notice are refused", async () => {
    const { handler, chain, adapter, manager } = setup();
    const { x207 } = await requirements(handler);
    await handler(pay(x207, { grantee_ref: "alice-dev" }));
    const at = Math.floor(chain.now / 1000);
    const stop = (b: unknown) => handler(new Request(url(1, "/stop"), { method: "POST", body: JSON.stringify(b) }));
    expect((await stop(signStop(1, "intruder.x207-circle.near", strangerKeys.secretKey, at))).status).toBe(403);
    const forged = await stop(signStop(1, GRANTEE, strangerKeys.secretKey, at));
    expect(forged.status).toBe(401);
    expect((await stop(signStop(1, GRANTEE, granteeKeys.secretKey, at - 3600))).status).toBe(400);
    expect((await stop({ nothing: true })).status).toBe(400);
    expect(manager.access(1)?.status).toBe("active");
    const ok = await stop(signStop(1, GRANTEE, granteeKeys.secretKey, at));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).status).toBe("revoked");
    expect(await adapter.status("mock-1")).toBe("absent");
    // stopping again is safe
    expect((await stop(signStop(1, GRANTEE, granteeKeys.secretKey, at))).status).toBe(200);
    expect((await handler(new Request(url(2, "/stop"), { method: "POST", body: "{}" }))).status).toBe(404);
  });

  it("TC-BE-060-06 a broker without the P2 routes says so, and a grant whose scope is not a provider scope is refused before any payment", async () => {
    const off = setup({}, false);
    expect((await off.handler(new Request(url(1), { method: "POST", body: "{}" }))).status).toBe(501);
    const { handler, chain, f } = setup();
    chain.grants.set(3, grant({ grant_id: 3 }));
    const r = await handler(new Request(url(3), { method: "POST", body: JSON.stringify({ grantee_ref: "alice-dev" }) }));
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe("scope_invalid");
    expect(f.seen).toEqual([]);
    void creditPrice;
    void X207ExtraSource;
  });

  it("TC-BE-060-07 the challenge route says no challenge is needed for a provider that needs none, and refuses a grant that is not a provider grant", async () => {
    const { handler, chain } = setup();
    const r = await handler(new Request(url(1, "/challenge")));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ required: false });
    chain.grants.set(3, grant({ grant_id: 3 }));
    expect((await handler(new Request(url(3, "/challenge")))).status).toBe(400);
  });
});
