import { describe, expect, it } from "vitest";
import { Dispatcher } from "../src/dispatcher.js";
import { ClassBAdapter } from "../src/keys/class-b.js";
import { ClassCAdapter } from "../src/proxy/class-c.js";
import { hostedForbidden, ProviderRegistry, providersFromEnv } from "../src/proxy/providers.js";
import { createBrokerHandler } from "../src/server.js";
import { BrokerStore } from "../src/store.js";
import { X207ExtraSource } from "@x207/scheme";
import { BROKER, FakeChain, GRANTEE, grant } from "./helpers.js";

const SECRET = "sk-live-0123456789abcdefSECRET";
const ASSET = "mock:echo";
const SCOPE = JSON.stringify({ path_prefixes: ["/v1/echo"], methods: ["GET", "POST"] });
const PRICE = 20000;

/** The facilitator and the provider of one test; the provider's status (and a failure of the network) can be set per call. */
function setup(o: { mode?: "self-hosted" | "hosted"; mock?: boolean; env?: Record<string, string | undefined>; quota?: string | null } = {}) {
  const chain = new FakeChain();
  chain.grants.set(1, grant({ class: "C", asset_type: ASSET, unit: "call", unit_price: String(PRICE), limits: { scope: SCOPE, quota: o.quota === undefined ? null : o.quota, expires_at: grant().limits.expires_at } } as never));
  const store = new BrokerStore(":memory:");
  const net = { settled: 0, providerCalls: 0, providerStatus: 200, providerDown: false };
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host === "provider.test") {
      net.providerCalls += 1;
      if (net.providerDown) throw new Error("connection refused");
      return new Response(net.providerStatus >= 300 && net.providerStatus < 400 ? null : JSON.stringify({ ok: true }), { status: net.providerStatus, headers: net.providerStatus >= 300 && net.providerStatus < 400 ? { location: "http://elsewhere.test/" } : {} });
    }
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname === "/supported") return reply({ kinds: [{ scheme: "batch-settlement", network: "x207:agents-main", extra: { circleContract: "x207-circle.near", epoch: 42 } }] });
    if (url.pathname === "/verify") return reply({ isValid: true });
    if (url.pathname === "/settle") {
      net.settled += 1;
      return reply({ success: true, transaction: "", network: "x207:agents-main", payer: GRANTEE });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  const classB = new ClassBAdapter({ chain, store, viewAccessKey: async () => null, now: () => chain.now });
  const classC = new ClassCAdapter({ baseUrl: "http://broker.test", store });
  const dispatcher = new Dispatcher({ chain, adapters: { B: classB, C: classC } });
  const providers = new ProviderRegistry([{ assetType: ASSET, baseUrl: "http://provider.test", secretEnv: "MOCK_PROVIDER_KEY", ...(o.mock ? { mock: true } : {}) }], o.env ?? { MOCK_PROVIDER_KEY: SECRET });
  const handler = createBrokerHandler({
    dispatcher, classB, facilitatorUrl: "http://facilitator.test", circleId: "agents-main", brokerAccount: BROKER, fetch: fetchFn,
    extra: new X207ExtraSource({ facilitatorUrl: "http://facilitator.test", fetch: fetchFn }),
    proxy: { classC, providers, chain, store, ...(o.mode ? { mode: o.mode } : {}) },
  });
  return { handler, net, store };
}

const url = (path = "/v1/echo/ping") => `http://broker.test/grants/1/proxy${path}`;
async function call(handler: ReturnType<typeof setup>["handler"]): Promise<Response> {
  const first = await handler(new Request(url(), { method: "POST", body: "{}" }));
  if (first.status !== 402) return first;
  const x207 = ((await first.json()) as { accepts: Array<{ scheme: string }> }).accepts.find((a) => a.scheme === "batch-settlement");
  return handler(new Request(url(), { method: "POST", body: "{}", headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify({ x402Version: 2, accepted: x207, payload: { voucher: { payer: GRANTEE }, signature: "ed25519:x" } })).toString("base64") } }));
}
const usage = async (handler: ReturnType<typeof setup>["handler"]) => (await handler(new Request("http://broker.test/grants/1/usage"))).json() as Promise<any>;

describe("BE-070 the proxy of secrets (ADR-48)", () => {
  it("TC-BE-070-01 a hosted broker serves a mock provider and refuses a real one with 501 secret_hosted_forbidden, before anything is paid or called", async () => {
    const mock = setup({ mode: "hosted", mock: true });
    expect((await call(mock.handler)).status).toBe(200);
    expect(mock.net.providerCalls).toBe(1);
    const real = setup({ mode: "hosted" });
    const refused = await call(real.handler);
    expect([refused.status, ((await refused.json()) as any).error]).toEqual([501, "secret_hosted_forbidden"]);
    expect([real.net.providerCalls, real.net.settled]).toEqual([0, 0]);
    // self-hosted serves the real one
    expect((await call(setup({ mode: "self-hosted" }).handler)).status).toBe(200);
  });

  it("TC-BE-070-02 the hosted broker does not start with a real provider: the list of what it refuses, and BROKER_PROVIDERS can mark a mock", () => {
    const providers = providersFromEnv({ BROKER_PROVIDERS: JSON.stringify([{ asset_type: "a:real", base_url: "https://api.example.com", secret_env: "K1" }, { asset_type: "a:mock", base_url: "http://localhost:9", secret_env: "K2", mock: true }]) });
    expect(hostedForbidden("hosted", providers)).toEqual(["a:real"]);
    expect(hostedForbidden("self-hosted", providers)).toEqual([]);
    expect(hostedForbidden("hosted", providers.filter((p) => p.mock))).toEqual([]);
  });

  it("TC-BE-070-03 an empty secret variable is 502 secret_not_configured naming the variable; nothing is settled", async () => {
    const t = setup({ env: { MOCK_PROVIDER_KEY: "" } });
    const r = await call(t.handler);
    const body = (await r.json()) as any;
    expect([r.status, body.error]).toEqual([502, "secret_not_configured"]);
    expect(body.message).toContain("MOCK_PROVIDER_KEY");
    expect(t.net.settled).toBe(0);
  });

  it("TC-BE-070-04 the bill is per call that succeeded: a 200 is billed and counted, a 500, a redirect and an unreachable provider are neither; settled == counted == what GET usage says", async () => {
    const t = setup();
    expect((await call(t.handler)).status).toBe(200);
    expect((await call(t.handler)).status).toBe(200);
    t.net.providerStatus = 500;
    expect((await call(t.handler)).status).toBe(500);
    t.net.providerStatus = 302;
    const redirected = await call(t.handler);
    expect([redirected.status, ((await redirected.json()) as any).error]).toEqual([502, "provider_redirect"]);
    t.net.providerStatus = 200;
    t.net.providerDown = true;
    expect((await call(t.handler)).status).toBe(502);
    t.net.providerDown = false;
    expect((await call(t.handler)).status).toBe(200);
    const u = await usage(t.handler);
    expect(t.net.settled).toBe(3);
    expect(u).toMatchObject({ grantId: 1, unit: "call", unitPrice: String(PRICE), calls: 3, billed: String(3 * PRICE), decimals: 6 });
    expect(u.epochs.reduce((n: number, e: { calls: number }) => n + e.calls, 0)).toBe(3);
  });

  it("TC-BE-070-05 with a quota the bill and the count stay together: a refused call over the quota is not billed", async () => {
    const t = setup({ quota: "2" });
    for (let i = 0; i < 2; i++) expect((await call(t.handler)).status).toBe(200);
    expect((await call(t.handler)).status).toBe(429);
    expect(t.net.settled).toBe(2);
    expect((await usage(t.handler)).calls).toBe(2);
  });

  it("TC-BE-070-06 the usage of a grant that is not class C is not served, and an unknown grant is 404", async () => {
    const t = setup();
    expect((await t.handler(new Request("http://broker.test/grants/99/usage"))).status).toBe(404);
    expect((await t.handler(new Request("http://broker.test/grants/1/usage", { method: "POST" }))).status).toBe(404);
  });
});
