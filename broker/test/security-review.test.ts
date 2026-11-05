// Second security review, broker part (attacker reading BK-006 and BK-008). A test failed first for each finding; the fix is in src/.
import { describe, expect, it } from "vitest";
import { X207ExtraSource } from "@x207/scheme";
import { Dispatcher } from "../src/dispatcher.js";
import { ClassBAdapter } from "../src/keys/class-b.js";
import { ClassCAdapter } from "../src/proxy/class-c.js";
import { ProviderRegistry } from "../src/proxy/providers.js";
import { createBrokerHandler } from "../src/server.js";
import { BrokerStore } from "../src/store.js";
import { BROKER, FakeChain, GRANTEE, GRANTOR, grant } from "./helpers.js";

const SECRET = "sk-live-0123456789abcdefSECRET";
const ASSET = "mock:echo";
const SCOPE = JSON.stringify({ path_prefixes: ["/v1/echo"], methods: ["GET", "POST"] });
const cGrant = (quota: string | null = "2") => grant({ class: "C", asset_type: ASSET, unit: "call", unit_price: "20000", limits: { scope: SCOPE, quota, expires_at: grant().limits.expires_at } } as never);

interface ProviderCall { method: string; url: string; headers: Headers; redirect: "follow" | "error" | "manual" | undefined }

function setup(options: { quota?: string | null; provider?: (call: ProviderCall) => Promise<Response> | Response } = {}) {
  const chain = new FakeChain();
  chain.grants.set(1, cGrant(options.quota === undefined ? "2" : options.quota));
  const store = new BrokerStore(":memory:");
  const providerCalls: ProviderCall[] = [];
  const settles: string[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host === "provider.test") {
      const call = { method: init?.method ?? "GET", url: url.toString(), headers: new Headers(init?.headers), redirect: init?.redirect };
      providerCalls.push(call);
      return options.provider ? options.provider(call) : new Response("{}", { status: 200 });
    }
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname === "/supported") return reply({ kinds: [{ scheme: "batch-settlement", network: "x207:agents-main", extra: { circleContract: "x207-circle.near", epoch: 42 } }] });
    if (url.pathname === "/verify") return reply({ isValid: true });
    if (url.pathname === "/settle") {
      settles.push(url.pathname);
      return reply({ success: true, transaction: "", network: "x207:agents-main", payer: GRANTEE });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  const classB = new ClassBAdapter({ chain, store, viewAccessKey: async () => null, now: () => chain.now });
  const classC = new ClassCAdapter({ baseUrl: "http://broker.test", store });
  const dispatcher = new Dispatcher({ chain, adapters: { B: classB, C: classC } });
  const providers = new ProviderRegistry([{ assetType: ASSET, baseUrl: "http://provider.test", secretEnv: "MOCK_PROVIDER_KEY" }], { MOCK_PROVIDER_KEY: SECRET });
  const handler = createBrokerHandler({
    dispatcher, classB, facilitatorUrl: "http://facilitator.test", circleId: "agents-main", brokerAccount: BROKER, fetch: fetchFn,
    extra: new X207ExtraSource({ facilitatorUrl: "http://facilitator.test", fetch: fetchFn }),
    proxy: { classC, providers, chain, store, owner: GRANTOR },
  });
  return { chain, store, handler, providerCalls, settles, classB };
}

const X207 = { scheme: "batch-settlement", network: "x207:agents-main", amount: "20000", asset: "USD", payTo: GRANTOR, maxTimeoutSeconds: 60, extra: { circleContract: "x207-circle.near", unit: "credit", decimals: 6, epoch: 42, grantId: 1 } };
const header = (payer = GRANTEE, seq = 0) => ({ "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify({ x402Version: 2, accepted: X207, payload: { voucher: { payer, payee: GRANTOR, epoch: 42, seq }, signature: "ed25519:x" } })).toString("base64") });
let seqCounter = 0;
const call = (handler: ReturnType<typeof setup>["handler"], path: string, init: RequestInit = {}, seq?: number) =>
  handler(new Request(`http://broker.test/grants/1/proxy${path}`, { method: "POST", body: "{}", ...init, headers: { ...header(GRANTEE, seq ?? (seqCounter += 1)), ...(init.headers as object | undefined) } }));

describe("security review 2: class C proxy path and headers", () => {
  it("TC-SR2-B01 an encoded slash or backslash cannot walk out of the scope prefix", async () => {
    const { handler, providerCalls } = setup();
    for (const path of ["/v1/echo/..%2fadmin", "/v1/echo/%2e%2e%2fadmin", "/v1/echo/..%5cadmin", "/v1/echo/%2E%2E%2Fadmin", "/v1/echo/a%2f..%2f..%2fadmin"]) {
      const response = await call(handler, path);
      expect([path, response.status]).toEqual([path, 403]);
    }
    expect(providerCalls).toEqual([]);
  });

  it("TC-SR2-B02 a path cannot change the host of the call to the provider", async () => {
    const { handler, providerCalls } = setup({ quota: null });
    for (const path of ["//evil.test/x", "/v1/echo/@evil.test", "/v1/echo/..;/x"]) await call(handler, path);
    for (const c of providerCalls) expect(new URL(c.url).host).toBe("provider.test");
  });

  it("TC-SR2-B03 headers that change the method or name the auth of the provider do not go through", async () => {
    const { handler, providerCalls } = setup();
    const response = await call(handler, "/v1/echo/ping", {
      headers: { "x-http-method-override": "DELETE", "x-method-override": "DELETE", "x-http-method": "DELETE", "proxy-authorization": "Basic eA==", "x-forwarded-for": "10.0.0.1" },
    });
    expect(response.status).toBe(200);
    const sent = providerCalls[0]!.headers;
    for (const name of ["x-http-method-override", "x-method-override", "x-http-method", "proxy-authorization", "x-forwarded-for"]) expect(sent.has(name), name).toBe(false);
  });

  it("TC-SR2-B04 a provider that echoes the request headers does not give the secret to the lessee", async () => {
    const { handler } = setup({ provider: (c) => new Response(JSON.stringify({ headers: Object.fromEntries(c.headers) }), { status: 200, headers: { "content-type": "application/json" } }) });
    const response = await call(handler, "/v1/echo/ping");
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(SECRET);
  });

  it("TC-SR2-B05 the broker does not follow a redirect of the provider with the secret in the request", async () => {
    const { handler, providerCalls } = setup({ provider: () => new Response(null, { status: 302, headers: { location: "http://evil.test/steal" } }) });
    await call(handler, "/v1/echo/ping");
    expect(providerCalls[0]!.redirect).toBe("manual");
  });
});

describe("security review 2: quota under parallel requests", () => {
  it("TC-SR2-B06 six parallel paid calls on a quota of 2 reach the provider twice and settle twice", async () => {
    const { handler, providerCalls, settles } = setup({ provider: async () => { await new Promise((r) => setTimeout(r, 20)); return new Response("{}", { status: 200 }); } });
    const responses = await Promise.all(Array.from({ length: 6 }, () => call(handler, "/v1/echo/ping")));
    expect(providerCalls.length).toBeLessThanOrEqual(2);
    expect(settles.length).toBeLessThanOrEqual(2);
    expect(responses.filter((r) => r.status === 200).length).toBeLessThanOrEqual(2);
    expect(responses.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(4);
  });

  it("TC-SR2-B07 a failed call gives its slot back", async () => {
    let n = 0;
    const { handler, store, chain } = setup({ provider: () => new Response("{}", { status: ++n === 1 ? 500 : 200 }) });
    expect((await call(handler, "/v1/echo/ping")).status).toBe(500);
    expect((await call(handler, "/v1/echo/ping")).status).toBe(200);
    expect((await call(handler, "/v1/echo/ping")).status).toBe(200);
    expect((await call(handler, "/v1/echo/ping")).status).toBe(429);
    expect(store.calls(1, chain.epoch)).toBe(2);
  });
});

describe("security review 2: lease paid twice (GET /grants/{id}/lease)", () => {
  const lease = (handler: ReturnType<typeof setup>["handler"], seq = 0) => handler(new Request("http://broker.test/grants/2/lease", { headers: header(GRANTEE, seq) }));

  it("TC-SR2-B09 two parallel requests with ONE voucher get one lease day, the second is 409 voucher_in_flight", async () => {
    const ctx = setup();
    ctx.chain.grants.set(2, grant({ grant_id: 2 }));
    const responses = await Promise.all([lease(ctx.handler), lease(ctx.handler)]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(ctx.store.lease(2)!.paidUntilMs).toBe(ctx.chain.now + 86_400_000);
  });

  it("TC-SR2-B10 six parallel proxy calls with ONE voucher reach the provider once", async () => {
    const { handler, providerCalls, settles } = setup({ quota: null, provider: async () => { await new Promise((r) => setTimeout(r, 20)); return new Response("{}", { status: 200 }); } });
    const responses = await Promise.all(Array.from({ length: 6 }, () => call(handler, "/v1/echo/ping", {}, 7)));
    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    expect(providerCalls).toHaveLength(1);
    expect(settles).toHaveLength(1);
  });

  it("TC-SR2-B08 two parallel payments with different vouchers add the key once and each extends the rent by one day", async () => {
    const ctx = setup();
    ctx.chain.grants.set(2, grant({ grant_id: 2 }));
    const slow = ctx.chain.addLeaseKey.bind(ctx.chain);
    ctx.chain.addLeaseKey = async (k: string, s: string) => { await new Promise((r) => setTimeout(r, 10)); return slow(k, s); };
    const responses = await Promise.all([lease(ctx.handler, 1), lease(ctx.handler, 2)]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(ctx.chain.calls.filter((c) => c.startsWith("addKey:"))).toHaveLength(1);
    expect(ctx.store.lease(2)!.paidUntilMs).toBe(ctx.chain.now + 2 * 86_400_000);
  });
});
