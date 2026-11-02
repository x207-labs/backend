import { describe, expect, it } from "vitest";
import { X207ExtraSource } from "@x207/scheme";
import { MemoryAudit } from "../src/audit.js";
import { Dispatcher } from "../src/dispatcher.js";
import { ClassBAdapter } from "../src/keys/class-b.js";
import { ClassCAdapter } from "../src/proxy/class-c.js";
import { ProviderRegistry } from "../src/proxy/providers.js";
import { createBrokerHandler } from "../src/server.js";
import { BrokerStore } from "../src/store.js";
import { BROKER, FakeChain, GRANTEE, grant } from "./helpers.js";

const KEY_A1 = "sk-A-one-0123456789SECRET";
const KEY_A2 = "sk-A-two-9876543210SECRET";
const KEY_B = "sk-B-0000111122223333SECRET";
const SCOPE = JSON.stringify({ path_prefixes: ["/v1"], methods: ["POST"] });
const cGrant = (id: number, assetType: string, quota: string | null = null) =>
  grant({ grant_id: id, class: "C", asset_type: assetType, unit: "call", unit_price: "20000", limits: { scope: SCOPE, quota, expires_at: grant().limits.expires_at } } as never);

/** Two providers behind one fake network; each wants its own key in `authorization`. */
function network(keys: { current: Record<string, string> }) {
  const seen: Array<{ host: string; auth: string | null; path: string }> = [];
  const settled: string[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host.endsWith(".test") && url.host.startsWith("provider-")) {
      const auth = new Headers(init?.headers).get("authorization");
      seen.push({ host: url.host, auth, path: url.pathname });
      return auth === `Bearer ${keys.current[url.host]}` ? new Response(JSON.stringify({ from: url.host }), { status: 200 }) : new Response("unauthorized", { status: 401 });
    }
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.pathname === "/supported") return reply({ kinds: [{ scheme: "batch-settlement", network: "x207:agents-main", extra: { circleContract: "x207-circle.near", epoch: 42 } }] });
    if (url.pathname === "/verify") return reply({ isValid: true });
    if (url.pathname === "/settle") return (settled.push("settle"), reply({ success: true, transaction: "", network: "x207:agents-main", payer: GRANTEE }));
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchFn, seen, settled };
}

function setup(env: Record<string, string>) {
  const chain = new FakeChain();
  chain.grants.set(1, cGrant(1, "mock:alpha", "100"));
  chain.grants.set(2, cGrant(2, "mock:beta"));
  const store = new BrokerStore(":memory:");
  const audit = new MemoryAudit();
  const keys = { current: { "provider-a.test": KEY_A1, "provider-b.test": KEY_B } as Record<string, string> };
  const net = network(keys);
  const providers = new ProviderRegistry(
    [
      { assetType: "mock:alpha", baseUrl: "http://provider-a.test", secretEnv: "KEY_ALPHA" },
      { assetType: "mock:beta", baseUrl: "http://provider-b.test", secretEnv: "KEY_BETA" },
    ],
    env, audit,
  );
  const classB = new ClassBAdapter({ chain, store, viewAccessKey: async () => null, now: () => chain.now });
  const classC = new ClassCAdapter({ baseUrl: "http://broker.test", store });
  const dispatcher = new Dispatcher({ chain, adapters: { B: classB, C: classC } });
  const handler = createBrokerHandler({
    dispatcher, classB, facilitatorUrl: "http://facilitator.test", circleId: "agents-main", brokerAccount: BROKER, fetch: net.fetchFn,
    extra: new X207ExtraSource({ facilitatorUrl: "http://facilitator.test", fetch: net.fetchFn }), proxy: { classC, providers, chain, store, audit },
  });
  return { chain, store, handler, net, providers, audit, keys };
}

const call = async (handler: ReturnType<typeof setup>["handler"], id: number, path = "/v1/ping") => {
  const challenge = await handler(new Request(`http://broker.test/grants/${id}/proxy${path}`, { method: "POST", body: "{}" }));
  const x207 = ((await challenge.json()) as { accepts: Array<{ scheme: string }> }).accepts.find((a) => a.scheme === "batch-settlement");
  const header = Buffer.from(JSON.stringify({ x402Version: 2, accepted: x207, payload: { voucher: { payer: GRANTEE }, signature: "ed25519:x" } })).toString("base64");
  return handler(new Request(`http://broker.test/grants/${id}/proxy${path}`, { method: "POST", body: "{}", headers: { "PAYMENT-SIGNATURE": header } }));
};

describe("BK-011 class C with several providers, rotation and an audit log", () => {
  it("TC-BK-011-01 two providers are served at the same time, each with its own key", async () => {
    const { handler, net } = setup({ KEY_ALPHA: KEY_A1, KEY_BETA: KEY_B });
    const [a, b] = await Promise.all([call(handler, 1), call(handler, 2)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(((await a.json()) as { from: string }).from).toBe("provider-a.test");
    expect(((await b.json()) as { from: string }).from).toBe("provider-b.test");
    expect(net.seen.map((s) => [s.host, s.auth]).sort()).toEqual([["provider-a.test", `Bearer ${KEY_A1}`], ["provider-b.test", `Bearer ${KEY_B}`]]);
  });

  it("TC-BK-011-02 a rotation changes the key at once and cuts no grant: the same grant keeps working and keeps counting its quota", async () => {
    const { handler, net, providers, store, chain, keys } = setup({ KEY_ALPHA: KEY_A1, KEY_BETA: KEY_B });
    expect((await call(handler, 1)).status).toBe(200);
    expect(store.calls(1, chain.epoch)).toBe(1);
    // the operator gives the provider a new key and rotates the broker to it
    keys.current["provider-a.test"] = KEY_A2;
    expect((await call(handler, 1)).status).toBe(401); // between the two steps the old key is refused by the provider: passed on, not settled
    expect(providers.rotate("mock:alpha", "KEY_ALPHA_NEXT", { KEY_ALPHA_NEXT: KEY_A2 })).toBe(2);
    const after = await call(handler, 1);
    expect(after.status).toBe(200);
    expect(net.seen.at(-1)).toMatchObject({ host: "provider-a.test", auth: `Bearer ${KEY_A2}` });
    expect(store.calls(1, chain.epoch)).toBe(2); // the failed call did not count, the two good ones did, across the rotation
    expect(chain.grants.get(1)!.status).toBe("active");
    // the other provider was not touched
    expect(providers.version("mock:beta")).toBe(1);
    expect((await call(handler, 2)).status).toBe(200);
  });

  it("TC-BK-011-03 a rotation to an empty variable is refused and the old secret stays", async () => {
    const { handler, providers, audit } = setup({ KEY_ALPHA: KEY_A1, KEY_BETA: KEY_B });
    expect(() => providers.rotate("mock:alpha", "KEY_MISSING")).toThrow(/old secret stays/);
    expect(providers.version("mock:alpha")).toBe(1);
    expect((await call(handler, 1)).status).toBe(200);
    expect(audit.entries.some((e) => e.kind === "secret_rotated")).toBe(false);
    expect(() => providers.rotate("mock:none")).toThrow(/no provider/);
  });

  it("TC-BK-011-04 the audit log names calls, refusals and rotations and holds no secret, no header and no body", async () => {
    const env = { KEY_ALPHA: KEY_A1, KEY_BETA: KEY_B } as Record<string, string>;
    const { handler, providers, audit } = setup(env);
    await call(handler, 1);
    await call(handler, 2);
    expect((await handler(new Request("http://broker.test/grants/1/proxy/v2/other", { method: "POST" }))).status).toBe(403);
    providers.rotate("mock:alpha", "KEY_ALPHA_NEXT", { KEY_ALPHA_NEXT: KEY_A2 });
    const kinds = audit.entries.map((e) => [e.kind, e.grantId ?? e.assetType, e.status ?? e.to]);
    expect(kinds).toEqual([["proxy_call", 1, 200], ["proxy_call", 2, 200], ["proxy_refused", 1, 403], ["secret_rotated", "mock:alpha", "KEY_ALPHA_NEXT"]]);
    expect(audit.entries[0]).toMatchObject({ method: "POST", path: "/v1/ping", assetType: "mock:alpha", secretVersion: 1 });
    expect(audit.entries[2]).toMatchObject({ code: "grant_scope_denied" });
    const text = JSON.stringify(audit.entries);
    for (const secret of [KEY_A1, KEY_A2, KEY_B]) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/authorization|PAYMENT-SIGNATURE|"body"/i);
  });
});
