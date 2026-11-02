import { describe, expect, it } from "vitest";
import { Dispatcher } from "../src/dispatcher.js";
import { ClassBAdapter } from "../src/keys/class-b.js";
import { ClassCAdapter } from "../src/proxy/class-c.js";
import { inScope, parseProxyScope, ProviderRegistry } from "../src/proxy/providers.js";
import { NoAttestation } from "../src/attest/index.js";
import { createBrokerHandler } from "../src/server.js";
import { BrokerStore } from "../src/store.js";
import { X207ExtraSource } from "@x207/scheme";
import { BROKER, FakeChain, GRANTEE, GRANTOR, grant } from "./helpers.js";

const SECRET = "sk-live-0123456789abcdefSECRET";
const ASSET = "mock:echo";
const SCOPE = JSON.stringify({ path_prefixes: ["/v1/echo"], methods: ["GET", "POST"] });
const cGrant = (patch = {}) => grant({ class: "C", asset_type: ASSET, unit: "call", unit_price: "20000", limits: { scope: SCOPE, quota: "2", expires_at: grant().limits.expires_at }, ...patch } as never);

/** One fake network: the facilitator and the mock provider. The provider wants the secret in `authorization` and can be told to fail. */
function network() {
  const seen: string[] = [];
  const providerCalls: Array<{ method: string; path: string; auth: string | null; hasPayment: boolean }> = [];
  const state = { providerStatus: 200, verdict: { isValid: true } as { isValid: boolean; invalidReason?: string } };
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host === "provider.test") {
      const headers = new Headers(init?.headers);
      providerCalls.push({ method: init?.method ?? "GET", path: url.pathname + url.search, auth: headers.get("authorization"), hasPayment: headers.has("payment-signature") });
      if (headers.get("authorization") !== `Bearer ${SECRET}`) return new Response("unauthorized", { status: 401 });
      return new Response(JSON.stringify({ echo: url.pathname, token: "visible-to-lessee-only-if-provider-returns-it" }), { status: state.providerStatus, headers: { "content-type": "application/json" } });
    }
    seen.push(url.pathname);
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname === "/supported") return reply({ kinds: [{ scheme: "batch-settlement", network: "x207:agents-main", extra: { circleContract: "x207-circle.near", epoch: 42 } }] });
    if (url.pathname === "/verify") return reply(state.verdict);
    if (url.pathname === "/settle") return reply({ success: true, transaction: "", network: "x207:agents-main", payer: GRANTEE });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchFn, seen, providerCalls, state };
}

function setup(patch = {}) {
  const chain = new FakeChain();
  chain.grants.set(1, cGrant(patch));
  const store = new BrokerStore(":memory:");
  const net = network();
  const classB = new ClassBAdapter({ chain, store, viewAccessKey: async () => null, now: () => chain.now });
  const classC = new ClassCAdapter({ baseUrl: "http://broker.test", store });
  const dispatcher = new Dispatcher({ chain, adapters: { B: classB, C: classC } });
  const providers = new ProviderRegistry([{ assetType: ASSET, baseUrl: "http://provider.test", secretEnv: "MOCK_PROVIDER_KEY" }], { MOCK_PROVIDER_KEY: SECRET });
  const handler = createBrokerHandler({
    dispatcher, classB, facilitatorUrl: "http://facilitator.test", circleId: "agents-main", brokerAccount: BROKER, fetch: net.fetchFn,
    extra: new X207ExtraSource({ facilitatorUrl: "http://facilitator.test", fetch: net.fetchFn }),
    proxy: { classC, providers, chain, store },
  });
  return { chain, store, net, handler, classC };
}

const url = (path = "/v1/echo/ping") => `http://broker.test/grants/1/proxy${path}`;
async function challenge(handler: ReturnType<typeof setup>["handler"], path?: string) {
  const r = await handler(new Request(url(path), { method: "POST", body: "{}" }));
  const body = (await r.json()) as { accepts: Array<{ scheme: string; amount: string; payTo: string; extra: Record<string, unknown> }> };
  return { status: r.status, x207: body.accepts.find((a) => a.scheme === "batch-settlement")! };
}
const pay = (x207: unknown, path = "/v1/echo/ping", payer = GRANTEE, method = "POST") =>
  new Request(url(path), { method, ...(method === "GET" ? {} : { body: "{}" }), headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify({ x402Version: 2, accepted: x207, payload: { voucher: { payer }, signature: "ed25519:x" } })).toString("base64") } });

describe("BK-008 scope helpers", () => {
  it("TC-BK-008-01 a prefix matches whole segments; method, dot-dot and bad scopes are refused", () => {
    const scope = parseProxyScope(SCOPE);
    expect(inScope(scope, "post", "/v1/echo")).toBe(true);
    expect(inScope(scope, "GET", "/v1/echo/a/b")).toBe(true);
    expect(inScope(scope, "GET", "/v1/echoes")).toBe(false);
    expect(inScope(scope, "DELETE", "/v1/echo/a")).toBe(false);
    expect(inScope(scope, "GET", "/v1/echo/../admin")).toBe(false);
    expect(() => parseProxyScope("nope")).toThrow();
    expect(() => parseProxyScope('{"path_prefixes":[],"methods":["GET"]}')).toThrow();
  });
});

describe("BK-008 class C proxy", () => {
  it("TC-BK-008-02 the 402 asks the price of one call and pays the grantor; nothing reaches the provider yet", async () => {
    const { handler, net } = setup();
    const { status, x207 } = await challenge(handler);
    expect(status).toBe(402);
    expect(x207).toMatchObject({ amount: "20000", payTo: GRANTOR, extra: { grantId: 1 } });
    expect(net.providerCalls).toEqual([]);
  });

  it("TC-BK-008-03 a paid call is forwarded with the secret of the grantor, then settled; the lessee never sees the secret", async () => {
    const { handler, net, store, chain } = setup();
    const { x207 } = await challenge(handler);
    const response = await handler(pay(x207));
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ echo: "/v1/echo/ping" });
    expect(net.providerCalls).toEqual([{ method: "POST", path: "/v1/echo/ping", auth: `Bearer ${SECRET}`, hasPayment: false }]);
    expect(net.seen.indexOf("/verify")).toBeLessThan(net.seen.indexOf("/settle"));
    expect(response.headers.get("PAYMENT-RESPONSE")).toBeTruthy();
    expect(store.calls(1, chain.epoch)).toBe(1);
    // BK-010 (scan): the secret is in no response header, no body, and not in what the facilitator was sent
    expect(text).not.toContain(SECRET);
    expect([...response.headers.values()].join("\n")).not.toContain(SECRET);
    expect(JSON.stringify(net.seen)).not.toContain(SECRET);
  });

  it("TC-BK-008-04 outside the scope is 403 grant_scope_denied with no payment asked, no verify, no settle", async () => {
    const { handler, net } = setup();
    for (const [method, path] of [["POST", "/v1/other"], ["DELETE", "/v1/echo/x"], ["GET", "/v1/echo/../admin"]] as const) {
      const r = await handler(new Request(url(path), { method }));
      expect([r.status, ((await r.json()) as { error: string }).error]).toEqual([403, "grant_scope_denied"]);
    }
    expect(net.seen.filter((p) => p === "/verify" || p === "/settle")).toEqual([]);
    expect(net.providerCalls).toEqual([]);
  });

  it("TC-BK-008-05 the quota of the epoch: two calls pass, the third is 429 grant_quota_exceeded without settle; the next epoch starts again", async () => {
    const { handler, net, chain } = setup();
    const { x207 } = await challenge(handler);
    for (let i = 0; i < 2; i += 1) expect((await handler(pay(x207))).status).toBe(200);
    const settles = net.seen.filter((p) => p === "/settle").length;
    const third = await handler(pay(x207));
    expect([third.status, ((await third.json()) as { error: string }).error]).toEqual([429, "grant_quota_exceeded"]);
    expect(net.seen.filter((p) => p === "/settle").length).toBe(settles);
    chain.epoch = 43;
    expect((await handler(pay(x207))).status).toBe(200);
  });

  it("TC-BK-008-06 a provider error is passed on and neither settled nor counted", async () => {
    const { handler, net, store, chain } = setup();
    const { x207 } = await challenge(handler);
    net.state.providerStatus = 500;
    const failed = await handler(pay(x207));
    expect(failed.status).toBe(500);
    expect(net.seen).not.toContain("/settle");
    expect(store.calls(1, chain.epoch)).toBe(0);
  });

  it("TC-BK-008-07 a refused voucher is 402 and the provider is not called; another payer than the lessee is 403", async () => {
    const refused = setup();
    refused.net.state.verdict = { isValid: false, invalidReason: "insufficient_credit" };
    const { x207 } = await challenge(refused.handler);
    expect((await refused.handler(pay(x207))).status).toBe(402);
    expect(refused.net.providerCalls).toEqual([]);

    const stranger = setup();
    const challenged = await challenge(stranger.handler);
    const response = await stranger.handler(pay(challenged.x207, "/v1/echo/ping", "gpu.x207-circle.near"));
    expect([response.status, ((await response.json()) as { error: string }).error]).toEqual([403, "payer_not_grantee"]);
    expect(stranger.net.providerCalls).toEqual([]);
  });

  it("TC-BK-008-08 not active or revoked grants are refused before anything else; a grant of class B is not served by the proxy", async () => {
    const offered = setup({ status: "offered", grantee: null });
    expect((await offered.handler(new Request(url(), { method: "POST" }))).status).toBe(403);
    const revoked = setup({ status: "revoked" });
    const r = await revoked.handler(new Request(url(), { method: "POST" }));
    expect([r.status, ((await r.json()) as { error: string }).error]).toEqual([403, "grant_revoked"]);
    const wrong = setup({ class: "B" });
    expect((await wrong.handler(new Request(url(), { method: "POST" }))).status).toBe(501);
  });

  it("TC-BK-008-09 a missing secret variable is 502 and the voucher is not settled", async () => {
    const ctx = setup();
    const providers = new ProviderRegistry([{ assetType: ASSET, baseUrl: "http://provider.test", secretEnv: "MOCK_PROVIDER_KEY" }], {});
    const handler = createBrokerHandler({
      dispatcher: new Dispatcher({ chain: ctx.chain, adapters: { C: ctx.classC } }), classB: undefined as never, facilitatorUrl: "http://facilitator.test", circleId: "agents-main",
      brokerAccount: BROKER, fetch: ctx.net.fetchFn, extra: new X207ExtraSource({ facilitatorUrl: "http://facilitator.test", fetch: ctx.net.fetchFn }),
      proxy: { classC: ctx.classC, providers, chain: ctx.chain, store: ctx.store },
    });
    const { x207 } = await challenge(handler);
    const response = await handler(pay(x207));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(SECRET);
    expect(ctx.net.seen).not.toContain("/settle");
  });
});

describe("BK-009 attestation (interface only)", () => {
  it("TC-BK-009-01 prove for class C says there is no attestation; it is never valid here", async () => {
    const { classC } = setup();
    expect(await classC.prove()).toMatchObject({ valid: false, reason: expect.stringContaining("no_attestation") });
    const none = new NoAttestation();
    expect(await none.quote()).toBeNull();
    expect(await none.verify()).toMatchObject({ valid: false });
  });
});
